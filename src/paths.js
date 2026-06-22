import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(here, "..");
export const defaultDataDir = path.join(projectRoot, "data");
export const defaultScanFile = path.join(defaultDataDir, "latest-scan.json");
export const defaultPlanFile = path.join(defaultDataDir, "latest-plan.json");

export function findDefaultWorkspaceRoot(start = process.cwd()) {
  let current = path.resolve(start);

  while (true) {
    if (path.basename(current) === "workspaces") {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const homeWorkspaces = path.join(os.homedir(), "workspaces");
  if (fs.existsSync(homeWorkspaces)) {
    return homeWorkspaces;
  }

  return process.cwd();
}

export function resolveDataFiles(outDir = defaultDataDir) {
  const dataDir = path.resolve(outDir);
  return {
    dataDir,
    scanFile: path.join(dataDir, "latest-scan.json"),
    planFile: path.join(dataDir, "latest-plan.json")
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: some filesystems do not support chmod.
  }
}

export function writeDataFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort: some filesystems do not support chmod.
  }
}
