import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { discoverCapabilities, summarizeCapabilities } from "./capabilities.js";
import { collectCommandHistory } from "./command-history.js";
import { discoverRemoteControl, isSshCommand } from "./remote-control.js";

const MARKER_FILES = new Set([
  "package.json",
  "composer.json",
  "artisan",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mvnw",
  "gradlew",
  "go.mod",
  "Cargo.toml",
  "pubspec.yaml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "Makefile",
  "makefile",
  "justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "README.md",
  "AGENTS.md"
]);

const SECRETISH_FILES = [
  /^\.env$/,
  /^\.env\..+/,
  /secret/i,
  /credential/i,
  /^id_rsa$/,
  /\.pem$/i,
  /\.key$/i,
  /\.sqlite$/i,
  /\.db$/i
];

const GENERATED_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".next",
  "dist",
  "build",
  "target",
  ".turbo",
  ".wrangler",
  ".gradle",
  ".mypy_cache",
  ".ruff_cache",
  "coverage"
]);

const IGNORED_TOP_DIRS = new Set([
  "_archive"
]);

const MAX_PROJECT_HISTORY_COMMANDS = 8;

export function scanWorkspace({ root, includeGenerated = true, logger = () => {} }) {
  const workspaceRoot = path.resolve(root);
  const startedAt = new Date();
  const directories = listTopDirectories(workspaceRoot);
  const commandHistory = collectCommandHistory();
  const workspaceProjects = directories.map((projectPath) => ({
    name: path.basename(projectPath),
    path: projectPath
  }));
  const remoteControl = discoverRemoteControl(commandHistory, { workspaceRoot, workspaceProjects });
  const projects = [];

  directories.forEach((projectPath, index) => {
    const name = path.basename(projectPath);
    logger(`[${index + 1}/${directories.length}] ${name}`);
    projects.push(scanProject(projectPath, { includeGenerated, commandHistory }));
  });

  const summary = summarizeProjects(projects, remoteControl);

  return {
    schemaVersion: 1,
    root: workspaceRoot,
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    capabilityDiscoveryVersion: 1,
    commandHistory: {
      generatedAt: commandHistory.generatedAt,
      sources: commandHistory.sources,
      entryCount: commandHistory.entryCount,
      commandCount: commandHistory.commandCount
    },
    remoteControl,
    summary,
    projects
  };
}

export function scanProject(projectPath, { includeGenerated = true, commandHistory = null } = {}) {
  const stat = fs.statSync(projectPath);
  const name = path.basename(projectPath);
  const markers = findMarkerFiles(projectPath, 2);
  const secretFiles = findSecretishFiles(projectPath, 2);
  const gitRepos = findGitRepos(projectPath, 5);
  const isGit = hasGitMetadata(projectPath);
  const generatedDirs = includeGenerated ? findGeneratedDirs(projectPath, 4) : [];
  const generatedBytes = generatedDirs.reduce((sum, item) => sum + item.sizeBytes, 0);
  const git = isGit ? readGitStatus(projectPath) : null;
  const activity = summarizeProjectActivity(projectPath, {
    rootModifiedAt: stat.mtime.toISOString(),
    git
  });
  const historyUsage = summarizeProjectHistoryUsage(projectPath, commandHistory);
  const capabilities = discoverCapabilities(projectPath, { maxDepth: 4, commandHistory });
  const capabilitySummary = summarizeCapabilities(capabilities);

  return {
    name,
    path: projectPath,
    sizeBytes: readDuBytes(projectPath),
    modifiedAt: stat.mtime.toISOString(),
    activity,
    isEmpty: isDirectoryEmpty(projectPath),
    markers,
    projectTypes: detectProjectTypes(markers),
    secretFiles,
    secretCount: secretFiles.length,
    gitRepoCount: gitRepos.length,
    nestedGitRepos: gitRepos.slice(isGit ? 1 : 0),
    isGit,
    git,
    generatedDirs,
    generatedBytes,
    historyUsage,
    capabilities,
    capabilitySummary
  };
}

function summarizeProjects(projects, remoteControl = null) {
  const totalBytes = projects.reduce((sum, project) => sum + project.sizeBytes, 0);
  const generatedBytes = projects.reduce((sum, project) => sum + project.generatedBytes, 0);
  const gitTopLevel = projects.filter((project) => project.isGit).length;
  const allGitRepos = projects.reduce((sum, project) => sum + project.gitRepoCount, 0);
  const dirtyGit = projects.filter((project) => project.git?.dirtyTotal > 0).length;
  const secretish = projects.filter((project) => project.secretCount > 0).length;
  const empty = projects.filter((project) => project.isEmpty).length;
  const capabilityCount = projects.reduce((sum, project) => sum + (project.capabilitySummary?.total || 0), 0);
  const highRiskCapabilityCount = projects.reduce((sum, project) => sum + (project.capabilitySummary?.highRisk || 0), 0);
  const projectsWithCapabilities = projects.filter((project) => (project.capabilitySummary?.total || 0) > 0).length;
  const projectsWithHighRiskCapabilities = projects.filter((project) => (project.capabilitySummary?.highRisk || 0) > 0).length;
  const historyCapabilityCount = projects.reduce((sum, project) => sum + (project.capabilitySummary?.history || 0), 0);
  const historyMatchedCapabilityCount = projects.reduce((sum, project) => sum + (project.capabilitySummary?.historyMatched || 0), 0);
  const historyRunCount = projects.reduce((sum, project) => sum + (project.capabilitySummary?.historyRunCount || 0), 0);
  const projectHistoryRunCount = projects.reduce((sum, project) => sum + (project.historyUsage?.runCount || 0), 0);
  const projectsWithHistoryUsage = projects.filter((project) => (project.historyUsage?.runCount || 0) > 0).length;

  return {
    projectCount: projects.length,
    totalBytes,
    generatedBytes,
    gitTopLevel,
    allGitRepos,
    dirtyGit,
    secretish,
    empty,
    capabilityCount,
    highRiskCapabilityCount,
    projectsWithCapabilities,
    projectsWithHighRiskCapabilities,
    historyCapabilityCount,
    historyMatchedCapabilityCount,
    historyRunCount,
    projectHistoryRunCount,
    projectsWithHistoryUsage,
    remoteDeviceCount: remoteControl?.deviceCount || 0,
    remoteCommandCount: remoteControl?.commandCount || 0,
    remoteHistoryRunCount: remoteControl?.historyRunCount || 0
  };
}

export function summarizeProjectHistoryUsage(projectPath, commandHistory = null) {
  const root = path.resolve(projectPath);
  const byCommandAndCwd = new Map();

  for (const historyCommand of commandHistory?.commands || []) {
    const command = String(historyCommand.command || "").trim();
    if (!command || isSshCommand(command)) {
      continue;
    }

    for (const hint of historyCommand.cwdHints || []) {
      const cwd = path.resolve(String(hint.cwd || ""));
      if (!isInside(root, cwd)) {
        continue;
      }

      const relativeDir = normalizeRelativePath(path.relative(root, cwd));
      const key = `${command}\x1f${relativeDir}`;
      const entry = byCommandAndCwd.get(key) || {
        command,
        count: 0,
        firstRunAt: null,
        lastRunAt: null,
        lastSequence: -1,
        relativeDir,
        cwdPath: hint.path || cwd
      };

      entry.count += hint.count || 1;
      entry.firstRunAt = earliestIso(entry.firstRunAt, hint.firstRunAt || historyCommand.firstRunAt || null);
      entry.lastRunAt = latestIso(entry.lastRunAt, hint.lastRunAt || historyCommand.lastRunAt || null);
      entry.lastSequence = Math.max(entry.lastSequence, hint.lastSequence ?? historyCommand.lastSequence ?? -1);
      entry.cwdPath = hint.path || entry.cwdPath || cwd;
      byCommandAndCwd.set(key, entry);
    }
  }

  const historyEntries = [...byCommandAndCwd.values()]
    .map((entry) => ({
      ...entry,
      signal: projectHistorySignalLevel(entry.command, entry.count)
    }));
  const signalEntries = historyEntries.filter((entry) => entry.signal === "signal");
  const topCommands = historyEntries
    .sort((a, b) =>
      b.count - a.count ||
      b.lastSequence - a.lastSequence ||
      (b.lastRunAt || "").localeCompare(a.lastRunAt || "") ||
      a.command.localeCompare(b.command)
    )
    .slice(0, MAX_PROJECT_HISTORY_COMMANDS);
  const topSignalCommands = signalEntries
    .sort((a, b) =>
      b.count - a.count ||
      b.lastSequence - a.lastSequence ||
      (b.lastRunAt || "").localeCompare(a.lastRunAt || "") ||
      a.command.localeCompare(b.command)
    )
    .slice(0, MAX_PROJECT_HISTORY_COMMANDS);
  const signalRunCount = signalEntries.reduce((sum, command) => sum + command.count, 0);
  const totalRunCount = historyEntries.reduce((sum, command) => sum + command.count, 0);

  return {
    runCount: totalRunCount,
    commandCount: byCommandAndCwd.size,
    signalRunCount,
    signalCommandCount: signalEntries.length,
    signalLastRunAt: latestIso(...signalEntries.map((command) => command.lastRunAt)),
    signalLastSequence: Math.max(-1, ...signalEntries.map((command) => command.lastSequence ?? -1)),
    weakRunCount: totalRunCount - signalRunCount,
    lastRunAt: latestIso(...historyEntries.map((command) => command.lastRunAt)),
    lastSequence: Math.max(-1, ...historyEntries.map((command) => command.lastSequence ?? -1)),
    topCommands,
    topSignalCommands
  };
}

function projectHistorySignalLevel(command, count = 1) {
  const normalized = String(command || "").replace(/\s+/g, " ").trim();
  const segments = projectHistoryCommandSegments(normalized);
  if (segments.length > 1) {
    if (segments.some((segment) => isStrongProjectHistoryCommand(segment))) {
      return "signal";
    }
    if (segments.every((segment) => isWeakProjectHistoryCommand(segment))) {
      return "weak";
    }
  }
  if (!normalized || isWeakProjectHistoryCommand(normalized)) {
    return "weak";
  }
  if (isStrongProjectHistoryCommand(normalized)) {
    return "signal";
  }
  return Number(count || 0) > 1 ? "signal" : "weak";
}

function projectHistoryCommandSegments(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||;)\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isWeakProjectHistoryCommand(command) {
  return /^(git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files|describe|merge-base)|git\s+config\s+--get|docker\s+ps|docker\s+compose\s+ps|container\s+system\s+status)\b/i.test(command) ||
    /^(code\s+\.|tail\s+-f\b|open\b.*\.(xcworkspace|xcodeproj|workspace|code-workspace)\b)/i.test(command) ||
    /^(go|git|docker|kubectl|helm|terraform|node|python|uv|npm|pnpm|yarn|bun|nvm)$/i.test(command) ||
    /^sudo\s+(softwareupdate|killall\s+syspolicyd)\b/i.test(command) ||
    /^mihomo-local\s+(status|select)\b/i.test(command) ||
    /^echo\s+workspace-keeper-tui-smoke$/i.test(command);
}

function isStrongProjectHistoryCommand(command) {
  return /^(npm|pnpm|yarn|bun)\s+(run\s+)?\S+/i.test(command) ||
    /^uv\s+run\s+\S+/i.test(command) ||
    /^(python\s+-m|pytest\b|make\b|just\b|task\b)/i.test(command) ||
    /^(go\s+(test|build|run)|cargo\s+(test|build|run)|docker\s+compose\s+(up|logs|build|run|restart|down))\b/i.test(command) ||
    /^git\s+(add|commit|checkout|switch|merge|rebase|pull|push|restore|reset|clean|stash|tag|fetch)\b/i.test(command) ||
    /^(\.\/|\.\.\/|bash\s+\.?\/|sh\s+\.?\/|zsh\s+\.?\/)/i.test(command) ||
    /^(codex|claude|agy|aider|gemini)\b/i.test(command) ||
    /^(\.?\/?mvnw?|\.?\/?gradlew?|composer\b|php\s+artisan\b|flutter\b|dart\b|xcodebuild\b)/i.test(command);
}

function listTopDirectories(root) {
  return safeReaddir(root)
    .filter((name) => !IGNORED_TOP_DIRS.has(name))
    .map((name) => path.join(root, name))
    .filter((entry) => safeStat(entry)?.isDirectory())
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function findMarkerFiles(root, maxDepth) {
  const markers = [];
  walkDepth(root, maxDepth, (entryPath, dirent, relativePath) => {
    if (dirent.isFile() && MARKER_FILES.has(dirent.name)) {
      markers.push(relativePath);
    }
  });
  return markers.sort();
}

function findSecretishFiles(root, maxDepth) {
  const files = [];
  walkDepth(root, maxDepth, (entryPath, dirent, relativePath) => {
    if (!dirent.isFile()) {
      return;
    }
    if (SECRETISH_FILES.some((pattern) => pattern.test(dirent.name))) {
      files.push(relativePath);
    }
  });
  return files.sort();
}

function findGitRepos(root, maxDepth) {
  const repos = [];

  function visit(dir, depth) {
    if (depth > maxDepth) {
      return;
    }

    if (hasGitMetadata(dir)) {
      repos.push(dir);
    }

    for (const dirent of safeReaddirWithTypes(dir)) {
      if (!dirent.isDirectory()) {
        continue;
      }
      if (dirent.name === ".git" || GENERATED_DIRS.has(dirent.name)) {
        continue;
      }
      visit(path.join(dir, dirent.name), depth + 1);
    }
  }

  visit(root, 0);
  return repos;
}

function findGeneratedDirs(root, maxDepth) {
  const dirs = [];

  function visit(dir, depth) {
    if (depth > maxDepth) {
      return;
    }

    for (const dirent of safeReaddirWithTypes(dir)) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const entryPath = path.join(dir, dirent.name);
      if (dirent.name === ".git") {
        continue;
      }

      if (GENERATED_DIRS.has(dirent.name)) {
        dirs.push({
          path: entryPath,
          relativePath: path.relative(root, entryPath),
          name: dirent.name,
          sizeBytes: readDuBytes(entryPath)
        });
        continue;
      }

      visit(entryPath, depth + 1);
    }
  }

  visit(root, 0);
  return dirs.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function detectProjectTypes(markers) {
  const types = new Set();

  for (const marker of markers) {
    const base = path.basename(marker);
    if (base === "package.json") types.add("node");
    if (base === "composer.json" || base === "artisan") types.add("php");
    if (base === "pyproject.toml" || base === "requirements.txt") types.add("python");
    if (base === "uv.lock") types.add("uv");
    if (base === "pom.xml" || base === "build.gradle" || base === "build.gradle.kts" || base === "mvnw" || base === "gradlew") types.add("java");
    if (base === "go.mod") types.add("go");
    if (base === "Cargo.toml") types.add("rust");
    if (base === "pubspec.yaml") types.add("flutter");
    if (base === "Dockerfile" || base === "docker-compose.yml" || base === "docker-compose.yaml" || base === "compose.yml" || base === "compose.yaml") types.add("docker");
    if (base === "Makefile" || base === "makefile" || base === "justfile" || base === "Taskfile.yml" || base === "Taskfile.yaml") types.add("tasks");
  }

  return Array.from(types).sort();
}

function readGitStatus(repoPath) {
  const porcelain = git(repoPath, ["status", "--porcelain"], 10_000);
  const trackedPorcelain = git(repoPath, ["status", "--porcelain", "-uno"], 10_000);
  const lastCommit = git(repoPath, ["log", "-1", "--format=%cI%x1f%h%x1f%s"], 5_000);
  const [lastCommitDate = "", lastCommitHash = "", lastCommitSubject = ""] = lastCommit.split("\x1f");

  return {
    branch: git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], 5_000),
    remote: sanitizeRemote(git(repoPath, ["remote", "get-url", "origin"], 5_000)),
    dirtyTotal: lineCount(porcelain),
    trackedDirty: lineCount(trackedPorcelain),
    statusPreview: porcelain.split("\n").filter(Boolean).slice(0, 30),
    lastCommitDate,
    lastCommitHash,
    lastCommitSubject
  };
}

function summarizeProjectActivity(projectPath, { rootModifiedAt, git }) {
  const fileModifiedAt = readLatestFileModifiedAt(projectPath, 5);
  const candidates = [
    { source: "project-dir", value: rootModifiedAt },
    { source: "project-files", value: fileModifiedAt },
    { source: "git-commit", value: git?.lastCommitDate || "" }
  ]
    .map((item) => ({ ...item, time: Date.parse(item.value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);
  const latest = candidates[0] || null;

  return {
    lastTouchedAt: latest?.value || rootModifiedAt,
    lastTouchedSource: latest?.source || "project-dir",
    rootModifiedAt,
    fileModifiedAt,
    gitLastCommitAt: git?.lastCommitDate || null
  };
}

function readLatestFileModifiedAt(root, maxDepth) {
  let latest = 0;

  walkDepth(root, maxDepth, (entryPath, dirent) => {
    if (!dirent.isFile()) {
      return;
    }
    const stat = safeStat(entryPath);
    if (stat?.mtimeMs > latest) {
      latest = stat.mtimeMs;
    }
  });

  return latest > 0 ? new Date(latest).toISOString() : null;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(relativePath) {
  return !relativePath || relativePath === "." ? "" : relativePath.split(path.sep).join("/");
}

function earliestIso(...values) {
  return values
    .filter(Boolean)
    .sort()
    .at(0) || null;
}

function latestIso(...values) {
  return values
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function git(cwd, args, timeout) {
  return run("git", args, { cwd, timeout });
}

function run(command, args, { cwd, timeout = 5_000 } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout
    }).trim();
  } catch {
    return "";
  }
}

function readDuBytes(targetPath) {
  const output = run("du", ["-sk", targetPath], { timeout: 20_000 });
  const kb = Number.parseInt(output.split(/\s+/)[0] || "0", 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function sanitizeRemote(remote) {
  return remote
    .replace(/https:\/\/[^/@]+@/i, "https://")
    .replace(/:\/\/[^/\s]+@/g, "://");
}

function hasGitMetadata(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function isDirectoryEmpty(dir) {
  return safeReaddir(dir).length === 0;
}

function walkDepth(root, maxDepth, onEntry) {
  function visit(dir, depth) {
    if (depth > maxDepth) {
      return;
    }

    for (const dirent of safeReaddirWithTypes(dir)) {
      if (dirent.name === ".git" || GENERATED_DIRS.has(dirent.name)) {
        continue;
      }

      const entryPath = path.join(dir, dirent.name);
      const relativePath = path.relative(root, entryPath);
      onEntry(entryPath, dirent, relativePath);

      if (dirent.isDirectory()) {
        visit(entryPath, depth + 1);
      }
    }
  }

  visit(root, 0);
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReaddirWithTypes(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(entryPath) {
  try {
    return fs.statSync(entryPath);
  } catch {
    return null;
  }
}

function lineCount(text) {
  if (!text) {
    return 0;
  }
  return text.split("\n").filter(Boolean).length;
}
