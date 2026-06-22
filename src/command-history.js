import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 20_000;
const MAX_COMMAND_LENGTH = 800;

const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|API[_-]?KEY)\s*=\s*("[^"]+"|'[^']+'|\S+)/i,
  /--(token|secret|password|passwd|api-key|access-key)(=|\s+)\S+/i,
  /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/i,
  /authorization:\s*bearer\s+\S+/i,
  /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/i
];

const NOISE_PATTERNS = [
  /^$/,
  /^(clear|pwd|exit|logout|history|jobs|fg|bg|alias|unalias|reset)\b/,
  /^(ls|ll|la|tree|du|df|top|htop|ps|whoami|date|cal)\b(?!.*(&&|\|\||;|\|))/,
  /^(cd|pushd|popd)\b(?!.*(&&|\|\||;|\|))/,
  /^(cat|less|more|head)\b(?!.*(&&|\|\||;|\|))/,
  /^tail\b(?!.*\s-f\b)(?!.*(&&|\|\||;|\|))/,
  /^open\b(?!.*\.(xcworkspace|xcodeproj|workspace|code-workspace)\b)(?!.*(&&|\|\||;|\|))/i,
  /^(code|vim|nvim|nano)\b(?!\s+\.($|\s))(?!.*\.(xcworkspace|xcodeproj|workspace|code-workspace)\b)(?!.*(&&|\|\||;|\|))/i
];

export function collectCommandHistory({
  homeDir = os.homedir(),
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  const sources = historySources(homeDir);
  const entries = [];
  const readableSources = [];

  for (const source of sources) {
    const content = readHistoryFile(source.path);
    if (!content) {
      continue;
    }
    const parsed = source.parser(content, source);
    readableSources.push({
      type: source.type,
      path: displayPath(source.path, homeDir),
      entries: parsed.length
    });
    entries.push(...parsed);
  }

  const recentEntries = orderHistoryEntries(entries)
    .slice(-maxEntries)
    .map((entry, index) => ({ ...entry, sequence: index }));
  const commands = aggregateCommands(recentEntries, homeDir);

  return {
    generatedAt: new Date().toISOString(),
    sources: readableSources,
    entryCount: recentEntries.length,
    commandCount: commands.length,
    commands
  };
}

function orderHistoryEntries(entries) {
  return entries
    .map((entry, inputOrder) => ({ ...entry, inputOrder }))
    .sort((a, b) => {
      if (Number.isFinite(a.timestamp) && Number.isFinite(b.timestamp) && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.inputOrder - b.inputOrder;
    });
}

function historySources(homeDir) {
  return [
    { type: "zsh", path: path.join(homeDir, ".zsh_history"), parser: parseZshHistory },
    { type: "bash", path: path.join(homeDir, ".bash_history"), parser: parseBashHistory },
    { type: "fish", path: path.join(homeDir, ".local/share/fish/fish_history"), parser: parseFishHistory },
    { type: "zsh", path: path.join(homeDir, ".zhistory"), parser: parseZshHistory }
  ];
}

function parseZshHistory(content, source) {
  const entries = [];
  let currentCommand = "";
  let currentTimestamp = null;

  function flush() {
    const entry = historyEntry(currentCommand, currentTimestamp, source);
    if (entry) {
      entries.push(entry);
    }
    currentCommand = "";
    currentTimestamp = null;
  }

  for (const line of content.split("\n")) {
    const extended = line.match(/^: (\d+):\d+;(.*)$/);
    if (extended) {
      flush();
      currentTimestamp = Number(extended[1]);
      currentCommand = extended[2];
      continue;
    }
    if (currentCommand) {
      currentCommand += `\n${line}`;
    } else {
      currentCommand = line;
    }
  }
  flush();

  return entries;
}

function parseBashHistory(content, source) {
  const entries = [];
  let pendingTimestamp = null;

  for (const line of content.split("\n")) {
    const timestamp = line.match(/^#(\d{9,})$/);
    if (timestamp) {
      pendingTimestamp = Number(timestamp[1]);
      continue;
    }

    const entry = historyEntry(line, pendingTimestamp, source);
    pendingTimestamp = null;
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function parseFishHistory(content, source) {
  const entries = [];
  let currentCommand = "";
  let currentTimestamp = null;

  function flush() {
    const entry = historyEntry(currentCommand, currentTimestamp, source);
    if (entry) {
      entries.push(entry);
    }
    currentCommand = "";
    currentTimestamp = null;
  }

  for (const line of content.split("\n")) {
    const command = line.match(/^- cmd:\s*(.*)$/);
    if (command) {
      flush();
      currentCommand = unescapeFishValue(command[1]);
      continue;
    }

    const timestamp = line.match(/^\s+when:\s*(\d+)$/);
    if (timestamp) {
      currentTimestamp = Number(timestamp[1]);
    }
  }
  flush();

  return entries;
}

function historyEntry(command, timestampSeconds, source) {
  if (String(command || "").includes("\n")) {
    return null;
  }
  const normalized = normalizeCommand(command);
  if (!isSafeCommand(normalized)) {
    return null;
  }

  return {
    command: normalized,
    timestamp: Number.isFinite(timestampSeconds) ? timestampSeconds : null,
    sourceType: source.type,
    sourcePath: source.path
  };
}

function aggregateCommands(entries, homeDir) {
  const byCommand = new Map();
  const cwdBySource = new Map();

  for (const entry of entries) {
    const sourceCwdKey = entry.sourcePath;
    const currentCwd = cwdBySource.get(sourceCwdKey) || homeDir;
    const nextCwd = parseDirectoryChange(entry.command, currentCwd, homeDir);
    if (nextCwd) {
      cwdBySource.set(sourceCwdKey, nextCwd);
      continue;
    }
    const leadingCdExecution = parseLeadingCdExecution(entry.command, currentCwd, homeDir);
    if (leadingCdExecution?.invalid) {
      continue;
    }
    const command = leadingCdExecution?.command || entry.command;
    if (!isUsefulCommand(command)) {
      continue;
    }

    const existing = byCommand.get(command) || {
      command,
      count: 0,
      firstRunAt: null,
      lastRunAt: null,
      lastSequence: -1,
      cwdHints: new Map(),
      sources: new Set()
    };
    const cwdHint = leadingCdExecution?.cwd || currentCwd;
    const existingCwdHint = existing.cwdHints.get(cwdHint) || {
      cwd: cwdHint,
      count: 0,
      firstRunAt: null,
      lastRunAt: null,
      lastSequence: -1
    };

    existing.count += 1;
    existing.lastSequence = Math.max(existing.lastSequence, entry.sequence);
    existing.sources.add(displayPath(entry.sourcePath));
    existingCwdHint.count += 1;
    existingCwdHint.lastSequence = Math.max(existingCwdHint.lastSequence, entry.sequence);
    existing.cwdHints.set(cwdHint, existingCwdHint);

    if (entry.timestamp) {
      const iso = new Date(entry.timestamp * 1000).toISOString();
      existing.firstRunAt = !existing.firstRunAt || iso < existing.firstRunAt ? iso : existing.firstRunAt;
      existing.lastRunAt = !existing.lastRunAt || iso > existing.lastRunAt ? iso : existing.lastRunAt;
      existingCwdHint.firstRunAt = !existingCwdHint.firstRunAt || iso < existingCwdHint.firstRunAt ? iso : existingCwdHint.firstRunAt;
      existingCwdHint.lastRunAt = !existingCwdHint.lastRunAt || iso > existingCwdHint.lastRunAt ? iso : existingCwdHint.lastRunAt;
    }

    byCommand.set(command, existing);
  }

  return [...byCommand.values()]
    .map((item) => ({
      ...item,
      cwdHints: [...item.cwdHints.values()]
        .sort((a, b) => b.count - a.count || b.lastSequence - a.lastSequence || a.cwd.localeCompare(b.cwd))
        .slice(0, 6)
        .map((hint) => ({
          cwd: hint.cwd,
          count: hint.count,
          firstRunAt: hint.firstRunAt,
          lastRunAt: hint.lastRunAt,
          lastSequence: hint.lastSequence,
          path: displayPath(hint.cwd, homeDir)
        })),
      sources: [...item.sources].sort()
    }))
    .sort((a, b) => b.count - a.count || b.lastSequence - a.lastSequence || a.command.localeCompare(b.command));
}

function isSafeCommand(command) {
  if (!command || command.length > MAX_COMMAND_LENGTH || command.includes("\n")) {
    return false;
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(command))) {
    return false;
  }
  return true;
}

function isUsefulCommand(command) {
  const stripped = stripLeadingWrappers(command);
  return !NOISE_PATTERNS.some((pattern) => pattern.test(stripped));
}

function parseDirectoryChange(command, cwd, homeDir) {
  const tokens = splitShellWords(command);
  if (tokens.length < 1 || tokens.length > 3) {
    return null;
  }
  if (!["cd", "pushd"].includes(tokens[0])) {
    return null;
  }
  if (tokens.some((token) => ["&&", "||", ";", "|"].includes(token))) {
    return null;
  }
  if (tokens[1] === "-") {
    return null;
  }
  const resolved = resolveShellPath(tokens[1] || "~", cwd, homeDir);
  return existingDirectory(resolved) ? resolved : null;
}

function parseLeadingCdExecution(command, cwd, homeDir) {
  const tokens = splitShellWords(command);
  const separatorIndex = tokens.findIndex((token) => token === "&&" || token === ";");
  if (separatorIndex < 2 || !["cd", "pushd"].includes(tokens[0]) || tokens[1] === "-") {
    return null;
  }
  const separator = findTopLevelSeparator(command);
  if (!separator) {
    return null;
  }
  const tailCommand = normalizeCommand(command.slice(separator.index + separator.length));
  if (!tailCommand) {
    return null;
  }
  const resolved = resolveShellPath(tokens[1], cwd, homeDir);
  if (!existingDirectory(resolved)) {
    return { invalid: true };
  }
  return {
    cwd: resolved,
    command: tailCommand
  };
}

function existingDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function findTopLevelSeparator(input) {
  let quote = "";
  let escaped = false;
  const text = String(input || "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";" || (char === "&" && text[index + 1] === "&")) {
      return {
        index,
        length: char === "&" ? 2 : 1
      };
    }
  }

  return null;
}

function resolveShellPath(value, cwd, homeDir) {
  const text = String(value || "~");
  if (text === "~") {
    return path.resolve(homeDir);
  }
  if (text.startsWith("~/")) {
    return path.resolve(homeDir, text.slice(2));
  }
  if (text === "$HOME") {
    return path.resolve(homeDir);
  }
  if (text.startsWith("$HOME/")) {
    return path.resolve(homeDir, text.slice(6));
  }
  if (path.isAbsolute(text)) {
    return path.resolve(text);
  }
  return path.resolve(cwd, text);
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

  for (const char of String(input)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
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

function stripLeadingWrappers(command) {
  return command
    .replace(/^(time|noglob|command|builtin)\s+/, "")
    .replace(/^env\s+((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+)/, "");
}

function normalizeCommand(command) {
  return String(command || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unescapeFishValue(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

function readHistoryFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
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
