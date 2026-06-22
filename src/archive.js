import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function archiveProject(plan, {
  projectName,
  archiveRoot,
  execute = false,
  force = false,
  pruneGenerated = false,
  compact = false
}) {
  const project = plan.projects.find((item) => item.name === projectName);
  if (!project) {
    throw new Error(`Project not found in latest plan: ${projectName}`);
  }

  const refusal = refusalReason(project, force);
  const targetRoot = archiveRoot || project.path;
  const targetPath = path.join(targetRoot, `${project.name}.tar.gz`);
  const tarArgs = buildTarArgs(project.path, targetPath);

  const result = {
    project: project.name,
    source: project.path,
    target: targetPath,
    execute,
    refused: Boolean(refusal),
    reason: refusal,
    sourceDirectoryPreserved: !compact,
    overwritesExistingArchive: fs.existsSync(targetPath),
    pruneGenerated,
    compact,
    excludedDirs: ARCHIVE_EXCLUDE_DIRS,
    command: shellCommand("tar", tarArgs)
  };

  if (refusal) {
    return result;
  }

  if (execute) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const sourceStat = fs.statSync(project.path);
    const tempPath = createTempArchivePath(project.name);
    try {
      execFileSync("tar", buildTarArgs(project.path, tempPath), { stdio: ["ignore", "pipe", "pipe"] });
      fs.renameSync(tempPath, targetPath);
      fs.utimesSync(project.path, sourceStat.atime, sourceStat.mtime);
      validateCreatedArchive(project, targetPath);
    } finally {
      if (fs.existsSync(tempPath)) {
        moveToTrashSync(tempPath);
      }
    }
    result.created = true;
    result.sizeBytes = fs.statSync(targetPath).size;
    if (compact) {
      result.compacted = compactProjectDirectory(project.path, targetPath);
    } else if (pruneGenerated) {
      result.pruned = pruneGeneratedDirs(project.path);
    }
  } else {
    result.dryRun = true;
    if (compact) {
      result.wouldMoveToTrash = findProjectEntriesExceptArchive(project.path, targetPath);
    }
    if (pruneGenerated) {
      result.wouldPrune = findGeneratedDirs(project.path);
    }
  }

  return result;
}

export function restoreArchive({ archivePath, targetRoot, execute = false, force = false, keepArchive = false }) {
  if (!archivePath) {
    throw new Error("restore requires --archive <path>");
  }

  const resolvedArchive = path.resolve(archivePath);
  if (!fs.existsSync(resolvedArchive)) {
    throw new Error(`Archive not found: ${resolvedArchive}`);
  }

  const resolvedTargetRoot = path.resolve(targetRoot);
  const entries = listArchiveEntries(resolvedArchive);
  const unsafeReason = unsafeArchiveReason(entries);
  const topLevels = archiveTopLevels(entries);
  const projectName = topLevels.length === 1 ? topLevels[0] : "";
  const targetPath = projectName ? path.join(resolvedTargetRoot, projectName) : resolvedTargetRoot;
  const refusal = restoreRefusalReason({ unsafeReason, topLevels, targetPath, force });
  const tarArgs = ["-xzf", resolvedArchive, "-C", resolvedTargetRoot];
  const shouldDeleteArchive = !keepArchive && isPathInside(resolvedArchive, targetPath);

  const result = {
    archive: resolvedArchive,
    targetRoot: resolvedTargetRoot,
    target: targetPath,
    execute,
    keepArchive,
    deleteArchiveAfterRestore: shouldDeleteArchive,
    refused: Boolean(refusal),
    reason: refusal,
    entries: entries.length,
    topLevel: topLevels,
    command: shellCommand("tar", tarArgs)
  };

  if (refusal) {
    return result;
  }

  if (execute) {
    fs.mkdirSync(resolvedTargetRoot, { recursive: true });
    execFileSync("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] });
    result.restored = true;
    if (shouldDeleteArchive) {
      result.archiveMovedToTrash = moveToTrashSync(resolvedArchive);
    }
  } else {
    result.dryRun = true;
  }

  return result;
}

export const ARCHIVE_EXCLUDE_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".nox",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".ipynb_checkpoints",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  "dist",
  "build",
  "target",
  "coverage",
  ".wrangler"
];

const ARCHIVE_FILE_PATTERN = "*.tar.gz";

function refusalReason(project, force) {
  if (force) {
    return "";
  }

  if (project.archive.status !== "archive-ready" && project.archive.status !== "cleanup") {
    return `status is ${project.archive.status}; use --force only after manual review`;
  }

  if (project.archive.blockers.length > 0) {
    return project.archive.blockers.join("; ");
  }

  return "";
}

function buildTarArgs(sourcePath, targetPath) {
  const sourceParent = path.dirname(sourcePath);
  const sourceBase = path.basename(sourcePath);
  const excludeArgs = ARCHIVE_EXCLUDE_DIRS.flatMap((dir) => [
    "--exclude",
    `*/${dir}`,
    "--exclude",
    `*/${dir}/*`
  ]);

  return ["-czf", targetPath, ...excludeArgs, "--exclude", `${sourceBase}/${ARCHIVE_FILE_PATTERN}`, "-C", sourceParent, sourceBase];
}

function createTempArchivePath(projectName) {
  const safeName = projectName.replace(/[^A-Za-z0-9._-]/g, "_");
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `workspace-keeper-${safeName}-${unique}.tar.gz`);
}

function validateCreatedArchive(project, archivePath) {
  const entries = listArchiveEntries(archivePath);
  const topLevels = archiveTopLevels(entries);
  if (topLevels.length !== 1 || topLevels[0] !== project.name) {
    throw new Error(`Archive did not contain exactly one top-level project directory: ${archivePath}`);
  }
  if ((project.isGit || fs.existsSync(path.join(project.path, ".git"))) && !entries.includes(`${project.name}/.git/HEAD`)) {
    throw new Error(`Archive missed Git history: ${archivePath}`);
  }
}

function findProjectEntriesExceptArchive(root, archivePath) {
  const resolvedArchive = path.resolve(archivePath);
  return safeReaddirWithTypes(root)
    .map((dirent) => {
      const entryPath = path.join(root, dirent.name);
      return {
        path: entryPath,
        relativePath: dirent.name,
        name: dirent.name,
        isDirectory: dirent.isDirectory()
      };
    })
    .filter((entry) => path.resolve(entry.path) !== resolvedArchive)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function compactProjectDirectory(root, archivePath) {
  return findProjectEntriesExceptArchive(root, archivePath).map((entry) => ({
    ...entry,
    trashPath: moveToTrashSync(entry.path)
  }));
}

function findGeneratedDirs(root) {
  const dirs = [];

  function visit(dir) {
    for (const dirent of safeReaddirWithTypes(dir)) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const entryPath = path.join(dir, dirent.name);
      const relativePath = path.relative(root, entryPath);
      if (dirent.name === ".git") {
        continue;
      }

      if (ARCHIVE_EXCLUDE_DIRS.includes(dirent.name)) {
        dirs.push({ path: entryPath, relativePath, name: dirent.name });
        continue;
      }

      visit(entryPath);
    }
  }

  visit(root);
  return dirs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function pruneGeneratedDirs(root) {
  const dirs = findGeneratedDirs(root);
  return dirs.map((dir) => ({
    ...dir,
    trashPath: moveToTrashSync(dir.path)
  }));
}

function safeReaddirWithTypes(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listArchiveEntries(archivePath) {
  const output = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return output.split("\n").map(normalizeArchiveEntry).filter(Boolean);
}

function normalizeArchiveEntry(entry) {
  return entry.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function unsafeArchiveReason(entries) {
  if (entries.length === 0) {
    return "archive is empty";
  }

  for (const entry of entries) {
    if (path.isAbsolute(entry)) {
      return `archive contains absolute path: ${entry}`;
    }
    if (entry.split("/").includes("..")) {
      return `archive contains parent-directory path: ${entry}`;
    }
  }

  return "";
}

function archiveTopLevels(entries) {
  return Array.from(new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean))).sort();
}

function restoreRefusalReason({ unsafeReason, topLevels, targetPath, force }) {
  if (unsafeReason) {
    return unsafeReason;
  }

  if (topLevels.length !== 1) {
    return `archive must contain exactly one top-level project directory; found ${topLevels.length}`;
  }

  if (!force && fs.existsSync(targetPath)) {
    return `target already exists: ${targetPath}; use --target-root for a clean restore location`;
  }

  return "";
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function moveToTrashSync(targetPath) {
  const trashRoot = path.join(os.homedir(), ".Trash");
  fs.mkdirSync(trashRoot, { recursive: true });
  const trashPath = uniqueTrashPath(trashRoot, path.basename(targetPath));
  fs.renameSync(targetPath, trashPath);
  return trashPath;
}

function uniqueTrashPath(trashRoot, baseName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const first = path.join(trashRoot, `${baseName}.${timestamp}`);
  if (!fs.existsSync(first)) {
    return first;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(trashRoot, `${baseName}.${timestamp}-${index}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find available Trash target for ${baseName}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellCommand(command, args) {
  return [command, ...args.map(shellQuote)].join(" ");
}
