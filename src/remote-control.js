import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SSH_CONFIG_MAX_BYTES = 512 * 1024;
const MAX_INCLUDE_DEPTH = 4;
const SSH_OPTIONS_WITH_ARGS = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w"
]);

const SSH_OPTIONS_WITH_INLINE_ARGS = new Set(["-D", "-E", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);

export function discoverRemoteControl(commandHistory, {
  homeDir = os.homedir(),
  workspaceRoot = null,
  workspaceProjects = []
} = {}) {
  const sshConfig = collectSshConfig(homeDir);
  const configuredDevices = buildConfiguredDevices(sshConfig.entries, homeDir);
  const devicesById = new Map(configuredDevices.map((device) => [device.id, device]));
  const indexes = buildDeviceIndexes(configuredDevices);

  for (const historyCommand of commandHistory?.commands || []) {
    const parsed = parseSshCommand(historyCommand.command);
    if (!parsed) {
      continue;
    }

    const device = findOrCreateDevice(parsed, { devicesById, indexes, homeDir });
    if (!device) {
      continue;
    }
    mergeRemoteCommand(device, parsed, historyCommand, { homeDir, workspaceRoot, workspaceProjects });
  }

  const devices = [...devicesById.values()]
    .map((device) => finalizeDevice(device, homeDir))
    .filter((device) => device.commandCount > 0 || device.source?.type === "ssh-config")
    .sort(compareDevices);

  const commandCount = devices.reduce((sum, device) => sum + device.commandCount, 0);
  const historyRunCount = devices.reduce((sum, device) => sum + device.runCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    sshConfig: {
      path: displayPath(path.join(homeDir, ".ssh/config"), homeDir),
      readable: sshConfig.rootReadable,
      files: sshConfig.files.map((file) => ({
        path: displayPath(file.path, homeDir),
        hostBlocks: file.hostBlocks,
        includes: file.includes.map((includePath) => displayPath(includePath, homeDir))
      })),
      hostCount: configuredDevices.length
    },
    deviceCount: devices.length,
    commandCount,
    historyRunCount,
    devices
  };
}

export function isSshCommand(command) {
  const tokens = splitShellWords(commandForParsing(command));
  return tokens[0] === "ssh";
}

export function parseSshCommand(command) {
  const parseCommand = commandForParsing(command);
  const tokens = splitShellWords(parseCommand);
  if (tokens[0] !== "ssh") {
    return null;
  }

  const options = {};
  let target = "";
  let index = 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }

    const option = optionWithInlineArg(token);
    if (option) {
      applySshOption(options, option.name, option.value);
      index += 1;
      continue;
    }

    if (SSH_OPTIONS_WITH_ARGS.has(token)) {
      applySshOption(options, token, tokens[index + 1] || "");
      index += 2;
      continue;
    }

    index += 1;
  }

  target = tokens[index] || "";
  if (!target) {
    return null;
  }

  const remaining = tokens.slice(index + 1);
  const targetParts = parseSshTarget(target, options);
  const remoteCommand = remaining.join(" ").trim();

  return {
    fullCommand: normalizeSpace(command),
    parseCommand,
    target,
    sshTarget: targetParts.sshTarget,
    host: targetParts.host,
    user: targetParts.user,
    port: options.port || "",
    identityFile: options.identityFile || "",
    proxyJump: options.proxyJump || "",
    remoteCommand,
    tokens
  };
}

function collectSshConfig(homeDir) {
  const rootPath = path.join(homeDir, ".ssh/config");
  const seen = new Set();
  const files = [];
  const entries = [];
  const rootReadable = fs.existsSync(rootPath);

  function visit(filePath, depth) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved) || depth > MAX_INCLUDE_DEPTH) {
      return;
    }
    seen.add(resolved);

    const content = readSmallText(resolved);
    if (!content) {
      return;
    }

    const parsed = parseSshConfigContent(content, resolved, homeDir);
    files.push({
      path: resolved,
      hostBlocks: parsed.entries.length,
      includes: parsed.includes
    });
    entries.push(...parsed.entries);

    for (const includePath of parsed.includes) {
      visit(includePath, depth + 1);
    }
  }

  visit(rootPath, 0);

  return { rootReadable, files, entries };
}

function parseSshConfigContent(content, filePath, homeDir) {
  const entries = [];
  const includes = [];
  let current = null;

  content.split("\n").forEach((rawLine, index) => {
    const line = stripSshComment(rawLine).trim();
    if (!line) {
      return;
    }

    const [rawKey, ...rest] = line.split(/\s+/);
    const key = rawKey.toLowerCase();
    const value = rest.join(" ").trim();
    if (!value) {
      return;
    }

    if (key === "include") {
      for (const includePattern of splitShellWords(value)) {
        includes.push(...resolveIncludePattern(includePattern, filePath, homeDir));
      }
      return;
    }

    if (key === "host") {
      const aliases = value
        .split(/\s+/)
        .map(unquoteShellToken)
        .filter((alias) => alias && !isHostPattern(alias));
      current = aliases.length
        ? {
            aliases,
            options: {},
            source: {
              type: "ssh-config",
              path: displayPath(filePath, homeDir),
              line: index + 1
            }
          }
        : null;
      if (current) {
        entries.push(current);
      }
      return;
    }

    if (!current) {
      return;
    }

    const optionKey = normalizeSshConfigKey(key);
    if (!optionKey || current.options[optionKey]) {
      return;
    }
    current.options[optionKey] = unquoteShellToken(value);
  });

  return { entries, includes };
}

function buildConfiguredDevices(entries, homeDir) {
  return entries.map((entry, index) => {
    const alias = entry.aliases[0];
    const hostName = entry.options.hostName || alias;
    const user = entry.options.user || "";
    const port = entry.options.port || "";
    const id = stableId(`remote-device:${entry.aliases.join(",")}:${user}@${hostName}:${port}`);
    return {
      id,
      alias,
      aliases: entry.aliases,
      hostName,
      user,
      port,
      target: formatTarget({ user, host: hostName, port }),
      source: entry.source,
      config: {
        identityFile: entry.options.identityFile ? displayPath(resolveHomePath(entry.options.identityFile, homeDir), homeDir) : "",
        proxyJump: entry.options.proxyJump || "",
        identitiesOnly: entry.options.identitiesOnly || ""
      },
      configOrder: index,
      commandMap: new Map()
    };
  });
}

function buildDeviceIndexes(devices) {
  const byAlias = new Map();
  const byHostName = new Map();
  const byUserHost = new Map();

  for (const device of devices) {
    for (const alias of device.aliases) {
      byAlias.set(alias, device.id);
    }
    if (device.hostName) {
      if (!byHostName.has(device.hostName)) {
        byHostName.set(device.hostName, []);
      }
      byHostName.get(device.hostName).push(device.id);
      if (device.user) {
        byUserHost.set(`${device.user}@${device.hostName}`, device.id);
      }
    }
  }

  return { byAlias, byHostName, byUserHost };
}

function findOrCreateDevice(parsed, { devicesById, indexes }) {
  const aliasMatch = indexes.byAlias.get(parsed.host);
  if (aliasMatch) {
    return devicesById.get(aliasMatch);
  }

  if (parsed.user) {
    const userHostMatch = indexes.byUserHost.get(`${parsed.user}@${parsed.host}`);
    if (userHostMatch) {
      return devicesById.get(userHostMatch);
    }
  }

  const hostMatches = indexes.byHostName.get(parsed.host) || [];
  if (hostMatches.length) {
    const exactUserMatch = hostMatches
      .map((id) => devicesById.get(id))
      .find((device) => !parsed.user || !device.user || device.user === parsed.user);
    if (exactUserMatch) {
      return exactUserMatch;
    }
  }

  const id = stableId(`remote-device:adhoc:${parsed.user}@${parsed.host}:${parsed.port}`);
  if (!isPlausibleAdhocTarget(parsed)) {
    return null;
  }
  if (!devicesById.has(id)) {
    const device = {
      id,
      alias: parsed.host,
      aliases: [parsed.host],
      hostName: parsed.host,
      user: parsed.user,
      port: parsed.port,
      target: formatTarget({ user: parsed.user, host: parsed.host, port: parsed.port }),
      source: { type: "history", path: "shell-history", line: null },
      config: {
        identityFile: parsed.identityFile || "",
        proxyJump: parsed.proxyJump || "",
        identitiesOnly: ""
      },
      configOrder: Number.POSITIVE_INFINITY,
      commandMap: new Map()
    };
    devicesById.set(id, device);
    indexes.byAlias.set(parsed.host, id);
  }
  return devicesById.get(id);
}

function mergeRemoteCommand(device, parsed, historyCommand, { homeDir, workspaceRoot, workspaceProjects }) {
  const commandKey = parsed.fullCommand;
  const existing = device.commandMap.get(commandKey) || {
    id: stableId(`remote-command:${device.id}:${commandKey}`),
    name: remoteCommandName(parsed.remoteCommand, parsed.sshTarget),
    kind: parsed.remoteCommand ? "remote-command" : "login",
    command: commandKey,
    sshTarget: parsed.sshTarget,
    remoteCommand: parsed.remoteCommand,
    risk: "high",
    runnable: true,
    count: 0,
    firstRunAt: null,
    lastRunAt: null,
    lastSequence: -1,
    sources: new Set(),
    cwdHints: new Map(),
    localProjects: new Map()
  };

  existing.count += historyCommand.count || 1;
  existing.firstRunAt = earliestIso(existing.firstRunAt, historyCommand.firstRunAt);
  existing.lastRunAt = latestIso(existing.lastRunAt, historyCommand.lastRunAt);
  existing.lastSequence = Math.max(existing.lastSequence, historyCommand.lastSequence ?? -1);
  for (const source of historyCommand.sources || []) {
    existing.sources.add(source);
  }

  for (const hint of historyCommand.cwdHints || []) {
    const cwd = path.resolve(hint.cwd || homeDir);
    const cwdEntry = existing.cwdHints.get(cwd) || {
      cwd,
      path: displayPath(cwd, homeDir),
      count: 0,
      firstRunAt: null,
      lastRunAt: null,
      lastSequence: -1
    };
    cwdEntry.count += hint.count || 1;
    cwdEntry.firstRunAt = earliestIso(cwdEntry.firstRunAt, hint.firstRunAt);
    cwdEntry.lastRunAt = latestIso(cwdEntry.lastRunAt, hint.lastRunAt);
    cwdEntry.lastSequence = Math.max(cwdEntry.lastSequence, hint.lastSequence ?? -1);
    existing.cwdHints.set(cwd, cwdEntry);

    const projectHint = projectHintForCwd(cwd, hint, workspaceRoot);
    if (projectHint) {
      const projectEntry = existing.localProjects.get(projectHint.name) || {
        name: projectHint.name,
        path: projectHint.path,
        count: 0,
        lastSequence: -1,
        lastRunAt: null,
        source: "cwd"
      };
      projectEntry.count += hint.count || 1;
      projectEntry.lastSequence = Math.max(projectEntry.lastSequence, hint.lastSequence ?? -1);
      projectEntry.lastRunAt = latestIso(projectEntry.lastRunAt, hint.lastRunAt);
      existing.localProjects.set(projectHint.name, projectEntry);
    }
  }

  for (const projectHint of projectHintsForRemoteCommand(parsed.remoteCommand, workspaceProjects)) {
    const currentProjectEntry = existing.localProjects.get(projectHint.name);
    if (currentProjectEntry) {
      currentProjectEntry.source = currentProjectEntry.source || "cwd";
      continue;
    }

    const projectEntry = {
      name: projectHint.name,
      path: projectHint.path,
      count: 0,
      lastSequence: -1,
      lastRunAt: null,
      source: "remote-command"
    };
    projectEntry.count += historyCommand.count || 1;
    projectEntry.lastSequence = Math.max(projectEntry.lastSequence, historyCommand.lastSequence ?? -1);
    projectEntry.lastRunAt = latestIso(projectEntry.lastRunAt, historyCommand.lastRunAt);
    existing.localProjects.set(projectHint.name, projectEntry);
  }

  device.commandMap.set(commandKey, existing);
}

function finalizeDevice(device, homeDir) {
  const commands = [...device.commandMap.values()]
    .map((command) => finalizeRemoteCommand(command, homeDir))
    .sort(compareRemoteCommands);
  if (device.source?.type === "ssh-config" && !commands.some((command) => command.fullSshCommand === `ssh ${device.alias}`)) {
    commands.push(configLoginCommand(device, homeDir));
    commands.sort(compareRemoteCommands);
  }
  const runCount = commands.reduce((sum, command) => sum + command.count, 0);
  const lastRunAt = commands.map((command) => command.lastRunAt).filter(Boolean).sort().at(-1) || null;
  const lastSequence = commands.reduce((max, command) => Math.max(max, command.lastSequence ?? -1), -1);

  return {
    id: device.id,
    alias: device.alias,
    aliases: device.aliases,
    hostName: device.hostName,
    user: device.user,
    port: device.port,
    target: device.target,
    source: device.source,
    config: device.config,
    commandCount: commands.length,
    runCount,
    lastRunAt,
    lastSequence,
    commands
  };
}

function configLoginCommand(device, homeDir) {
  const command = `ssh ${device.alias}`;
  return {
    id: stableId(`remote-command:${device.id}:${command}:config-login`),
    name: `login ${device.alias}`,
    kind: "login",
    command,
    fullSshCommand: command,
    sshTarget: device.alias,
    remoteCommand: "",
    risk: "high",
    runnable: true,
    count: 0,
    firstRunAt: null,
    lastRunAt: null,
    lastSequence: -1,
    sources: [device.source?.path || "~/.ssh/config"],
    cwdHints: [{
      cwd: homeDir,
      path: "~",
      count: 0,
      firstRunAt: null,
      lastRunAt: null,
      lastSequence: -1
    }],
    localProjects: [],
    execution: {
      cwd: homeDir,
      command: "shell",
      args: ["-lc", command]
    }
  };
}

function finalizeRemoteCommand(command, homeDir) {
  const cwdHints = [...command.cwdHints.values()]
    .sort((a, b) => b.count - a.count || b.lastSequence - a.lastSequence || a.cwd.localeCompare(b.cwd))
    .slice(0, 6);
  const topCwd = cwdHints[0]?.cwd || homeDir;
  return {
    id: command.id,
    name: command.name,
    kind: command.kind,
    command: command.command,
    fullSshCommand: command.command,
    sshTarget: command.sshTarget,
    remoteCommand: command.remoteCommand,
    risk: command.risk,
    runnable: command.runnable,
    count: command.count,
    firstRunAt: command.firstRunAt,
    lastRunAt: command.lastRunAt,
    lastSequence: command.lastSequence,
    sources: [...command.sources].sort(),
    cwdHints,
    localProjects: [...command.localProjects.values()]
      .sort((a, b) => b.count - a.count || b.lastSequence - a.lastSequence || a.name.localeCompare(b.name))
      .slice(0, 6),
    execution: {
      cwd: topCwd,
      command: "shell",
      args: ["-lc", command.command]
    }
  };
}

function commandForParsing(command) {
  return stripLeadingCdExecution(stripLeadingWrappers(normalizeSpace(command))).command;
}

function stripLeadingCdExecution(command) {
  const tokens = splitShellWords(command);
  const separatorIndex = tokens.findIndex((token) => token === "&&" || token === ";");
  if (separatorIndex < 2 || !["cd", "pushd"].includes(tokens[0]) || tokens[1] === "-") {
    return { command };
  }
  return {
    command: tokens.slice(separatorIndex + 1).join(" ")
  };
}

function stripLeadingWrappers(command) {
  return String(command || "")
    .replace(/^(time|noglob|command|builtin)\s+/, "")
    .replace(/^env\s+((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+)/, "");
}

function splitShellWords(input) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;

  function push() {
    if (current) {
      tokens.push(current);
      current = "";
    }
  }

  for (const char of String(input || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === ";") {
      push();
      tokens.push(";");
      continue;
    }
    current += char;
  }
  push();

  return tokens.flatMap((token) => {
    if (token.includes("&&")) {
      return token.split(/(&&)/).filter(Boolean);
    }
    if (token.includes("||")) {
      return token.split(/(\|\|)/).filter(Boolean);
    }
    return token.includes("|") ? token.split(/(\|)/).filter(Boolean) : [token];
  });
}

function optionWithInlineArg(token) {
  if (token.startsWith("-o") && token.length > 2) {
    return { name: "-o", value: token.slice(2) };
  }
  for (const optionName of SSH_OPTIONS_WITH_INLINE_ARGS) {
    if (token.startsWith(optionName) && token.length > optionName.length) {
      return { name: optionName, value: token.slice(optionName.length) };
    }
  }
  return null;
}

function applySshOption(options, name, value) {
  if (!value) {
    return;
  }
  if (name === "-p") {
    options.port = value;
  } else if (name === "-l") {
    options.user = value;
  } else if (name === "-i") {
    options.identityFile = value;
  } else if (name === "-J") {
    options.proxyJump = value;
  } else if (name === "-o") {
    const [rawKey, ...rawValue] = value.split("=");
    const key = rawKey.toLowerCase();
    const optionValue = rawValue.join("=");
    if (key === "user") options.user = optionValue;
    if (key === "port") options.port = optionValue;
    if (key === "hostname") options.hostName = optionValue;
    if (key === "identityfile") options.identityFile = optionValue;
    if (key === "proxyjump") options.proxyJump = optionValue;
  }
}

function parseSshTarget(target, options) {
  const cleaned = target.replace(/^ssh:\/\//, "");
  const match = cleaned.match(/^(?:([^@]+)@)?(.+)$/);
  const targetUser = options.user || match?.[1] || "";
  const host = options.hostName || match?.[2] || cleaned;
  return {
    user: targetUser,
    host,
    sshTarget: formatTarget({ user: targetUser, host, port: options.port })
  };
}

function remoteCommandName(remoteCommand, target) {
  if (!remoteCommand) {
    return `login ${target}`;
  }

  let text = normalizeSpace(remoteCommand)
    .replace(/^cmd\s+\/[cs]\s+\/[cs]\s+/i, "")
    .replace(/^bash\s+-lc\s+/i, "")
    .replace(/^zsh\s+-lc\s+/i, "")
    .replace(/^sh\s+-lc\s+/i, "");
  text = unquoteShellToken(text);
  if (text.includes("&&")) {
    text = text.split("&&").at(-1).trim();
  }
  text = text.replace(/^call\s+/i, "");
  return trimMiddle(text || remoteCommand, 72);
}

function projectHintForCwd(cwd, hint, workspaceRoot) {
  if (!workspaceRoot) {
    return null;
  }
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, cwd);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const [name] = relative.split(path.sep);
  if (!name) {
    return null;
  }
  return {
    name,
    path: path.join(root, name),
    count: hint.count || 1,
    lastSequence: hint.lastSequence ?? -1,
    lastRunAt: hint.lastRunAt || null
  };
}

function projectHintsForRemoteCommand(remoteCommand, workspaceProjects) {
  const normalizedCommand = String(remoteCommand || "").replace(/\\/g, "/");
  if (!normalizedCommand || !workspaceProjects?.length) {
    return [];
  }

  return workspaceProjects
    .filter((project) => isProjectNameInPathLikeText(project.name, normalizedCommand))
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name))
    .slice(0, 3);
}

function isProjectNameInPathLikeText(projectName, text) {
  if (!projectName || projectName.length < 3) {
    return false;
  }
  const escaped = escapeRegex(projectName);
  return new RegExp(`(^|[\\s:/\\\\\"'])${escaped}($|[\\s:/\\\\\"'.-])`, "i").test(text);
}

function isPlausibleAdhocTarget(parsed) {
  const host = String(parsed.host || "");
  if (!host) {
    return false;
  }
  if (parsed.user) {
    return true;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return true;
  }
  if (/^[0-9a-f:]{3,}$/i.test(host) && host.includes(":")) {
    return true;
  }
  if (host.includes(".")) {
    return true;
  }
  return false;
}

function resolveIncludePattern(pattern, filePath, homeDir) {
  const resolvedPattern = resolveHomePath(pattern, homeDir, path.dirname(filePath));
  if (!resolvedPattern.includes("*")) {
    return fs.existsSync(resolvedPattern) ? [resolvedPattern] : [];
  }

  const dir = path.dirname(resolvedPattern);
  const filePattern = path.basename(resolvedPattern);
  const regex = new RegExp(`^${escapeRegex(filePattern).replace(/\\\*/g, ".*")}$`);
  try {
    return fs.readdirSync(dir)
      .filter((name) => regex.test(name))
      .map((name) => path.join(dir, name))
      .filter((entry) => fs.statSync(entry).isFile());
  } catch {
    return [];
  }
}

function readSmallText(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > SSH_CONFIG_MAX_BYTES) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function stripSshComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (char === "#" && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function normalizeSshConfigKey(key) {
  const mapping = {
    hostname: "hostName",
    user: "user",
    port: "port",
    identityfile: "identityFile",
    proxyjump: "proxyJump",
    identitiesonly: "identitiesOnly"
  };
  return mapping[key] || "";
}

function isHostPattern(alias) {
  return alias === "*" || alias.startsWith("!") || /[*?]/.test(alias);
}

function formatTarget({ user, host, port }) {
  const login = user ? `${user}@${host}` : host;
  return port ? `${login}:${port}` : login;
}

function compareDevices(a, b) {
  return b.runCount - a.runCount ||
    b.lastSequence - a.lastSequence ||
    a.source?.type.localeCompare(b.source?.type || "") ||
    a.alias.localeCompare(b.alias);
}

function compareRemoteCommands(a, b) {
  return b.count - a.count ||
    b.lastSequence - a.lastSequence ||
    (b.lastRunAt || "").localeCompare(a.lastRunAt || "") ||
    a.name.localeCompare(b.name);
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unquoteShellToken(value) {
  const text = String(value || "");
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\""))) {
    return text.slice(1, -1);
  }
  return text.replace(/\\(.)/g, "$1");
}

function resolveHomePath(value, homeDir, relativeDir = homeDir) {
  const text = unquoteShellToken(value);
  if (text === "~") {
    return homeDir;
  }
  if (text.startsWith("~/")) {
    return path.join(homeDir, text.slice(2));
  }
  if (path.isAbsolute(text)) {
    return text;
  }
  return path.resolve(relativeDir, text);
}

function displayPath(filePath, homeDir = os.homedir()) {
  const resolvedHome = path.resolve(homeDir);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath === resolvedHome) {
    return "~";
  }
  if (resolvedPath.startsWith(`${resolvedHome}${path.sep}`)) {
    return `~/${path.relative(resolvedHome, resolvedPath).split(path.sep).join("/")}`;
  }
  return filePath;
}

function earliestIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function latestIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function trimMiddle(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  const head = Math.ceil((maxLength - 1) * 0.62);
  const tail = maxLength - 1 - head;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function stableId(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return `remote-${(hash >>> 0).toString(36)}`;
}
