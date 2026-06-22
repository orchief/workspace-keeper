import fs from "node:fs";
import path from "node:path";
import { archiveProject, restoreArchive } from "./archive.js";
import { formatBytes, makePlan } from "./classifier.js";
import { ensureDir, findDefaultWorkspaceRoot, resolveDataFiles, writeDataFile } from "./paths.js";
import { scanWorkspace } from "./scanner.js";
import { serve } from "./server.js";
import { runTui } from "./tui.js";

export async function main(argv) {
  const [command = "help", ...rest] = argv.slice(2);
  const options = parseOptions(rest);

  if (command === "scan") {
    return runScan(options);
  }
  if (command === "plan") {
    return runPlan(options);
  }
  if (command === "report") {
    return runReport(options);
  }
  if (command === "serve") {
    return serve({
      root: options.root || findDefaultWorkspaceRoot(),
      port: Number(options.port || 4789),
      dataDir: options.out,
      host: options.host || "127.0.0.1"
    });
  }
  if (command === "tui") {
    return runTui({
      root: options.root || findDefaultWorkspaceRoot(),
      out: options.out,
      refresh: Boolean(options.refresh)
    });
  }
  if (command === "archive") {
    return runArchive(options);
  }
  if (command === "restore") {
    return runRestore(options);
  }

  printHelp();
}

export function runScan(options = {}) {
  const root = path.resolve(options.root || findDefaultWorkspaceRoot());
  const files = resolveDataFiles(options.out);
  ensureDir(files.dataDir);

  const scan = scanWorkspace({
    root,
    includeGenerated: !options.quick,
    logger: options.json ? () => {} : (line) => console.error(line)
  });
  const plan = makePlan(scan);

  writeDataFile(files.scanFile, `${JSON.stringify(scan, null, 2)}\n`);
  writeDataFile(files.planFile, `${JSON.stringify(plan, null, 2)}\n`);

  if (options.json) {
    console.log(JSON.stringify({ scanFile: files.scanFile, planFile: files.planFile, summary: plan.summary }, null, 2));
    return { scan, plan, files };
  }

  console.log(`scan: ${files.scanFile}`);
  console.log(`plan: ${files.planFile}`);
  printSummary(plan.summary);
  return { scan, plan, files };
}

export function runPlan(options = {}) {
  const files = resolveDataFiles(options.out);
  if (options.refresh || !fs.existsSync(files.scanFile)) {
    return runScan(options);
  }

  const scan = JSON.parse(fs.readFileSync(files.scanFile, "utf8"));
  const plan = makePlan(scan);
  ensureDir(files.dataDir);
  writeDataFile(files.planFile, `${JSON.stringify(plan, null, 2)}\n`);

  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }

  console.log(`plan: ${files.planFile}`);
  printSummary(plan.summary);
  return plan;
}

export function runReport(options = {}) {
  const files = resolveDataFiles(options.out);
  if (!fs.existsSync(files.planFile)) {
    runPlan(options);
  }

  const plan = JSON.parse(fs.readFileSync(files.planFile, "utf8"));
  printSummary(plan.summary);

  const bySize = [...plan.projects].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 10);
  const byGenerated = [...plan.projects].sort((a, b) => b.generatedBytes - a.generatedBytes).slice(0, 10);

  console.log("\nLargest projects");
  bySize.forEach((project) => {
    console.log(`- ${project.name}: ${formatBytes(project.sizeBytes)} [${project.archive.status}]`);
  });

  console.log("\nLargest generated/cache footprint");
  byGenerated
    .filter((project) => project.generatedBytes > 0)
    .forEach((project) => {
      console.log(`- ${project.name}: ${formatBytes(project.generatedBytes)} reclaimable-ish`);
    });

  console.log("\nReview before archive");
  plan.projects
    .filter((project) => project.archive.status === "review")
    .slice(0, 30)
    .forEach((project) => {
      console.log(`- ${project.name}: ${project.archive.blockers.join("; ")}`);
    });
}

export function runArchive(options = {}) {
  const allReady = Boolean(options["all-ready"]);
  const projectName = options.project || options._[0];
  if (!allReady && !projectName) {
    throw new Error("archive requires --project <name> or --all-ready");
  }

  const files = resolveDataFiles(options.out);
  if (options.refresh || !fs.existsSync(files.planFile)) {
    runPlan(options);
  }
  const plan = JSON.parse(fs.readFileSync(files.planFile, "utf8"));

  if (allReady) {
    const projects = plan.projects.filter((project) => project.archive.status === "archive-ready");
    const results = projects.map((project) => archiveProject(plan, {
      projectName: project.name,
      archiveRoot: options["archive-root"],
      execute: Boolean(options.execute),
      force: false,
      pruneGenerated: Boolean(options["prune-generated"]),
      compact: Boolean(options.compact)
    }));
    console.log(JSON.stringify({
      execute: Boolean(options.execute),
      count: results.length,
      created: results.filter((result) => result.created).length,
      refused: results.filter((result) => result.refused).length,
      results
    }, null, 2));
    return;
  }

  const result = archiveProject(plan, {
    projectName,
    archiveRoot: options["archive-root"],
    execute: Boolean(options.execute),
    force: Boolean(options.force),
    pruneGenerated: Boolean(options["prune-generated"]),
    compact: Boolean(options.compact)
  });

  console.log(JSON.stringify(result, null, 2));
}

export function runRestore(options = {}) {
  const archivePath = options.archive || options._[0];
  const targetRoot = options["target-root"] || options.root || findDefaultWorkspaceRoot();
  const result = restoreArchive({
    archivePath,
    targetRoot,
    execute: Boolean(options.execute),
    force: Boolean(options.force),
    keepArchive: Boolean(options["keep-archive"])
  });

  console.log(JSON.stringify(result, null, 2));
}

function printSummary(summary) {
  console.log(`projects: ${summary.projectCount}`);
  console.log(`git repositories: ${summary.gitTopLevel} top-level / ${summary.allGitRepos} total`);
  console.log(`dirty git projects: ${summary.dirtyGit}`);
  console.log(`local config/data projects: ${summary.secretish}`);
  console.log(`total size: ${formatBytes(summary.totalBytes)}`);
  console.log(`generated/cache footprint: ${formatBytes(summary.generatedBytes)}`);
  console.log(`capabilities: ${summary.capabilityCount || 0} total / ${summary.highRiskCapabilityCount || 0} high risk`);
  console.log(`project history usage: ${summary.projectHistoryRunCount || 0} runs / ${summary.projectsWithHistoryUsage || 0} projects`);
  console.log(`capability history usage: ${summary.historyRunCount || 0} runs / ${summary.historyCapabilityCount || 0} history candidates / ${summary.historyMatchedCapabilityCount || 0} matched capabilities`);
  console.log(`remote control: ${summary.remoteDeviceCount || 0} devices / ${summary.remoteCommandCount || 0} commands / ${summary.remoteHistoryRunCount || 0} history runs`);
  console.log(`buckets: ${JSON.stringify(summary.buckets)}`);
}

function parseOptions(args) {
  const options = { _: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

function printHelp() {
  console.log(`workspace-keeper

Commands:
  tui [--root PATH] [--out PATH] [--refresh]
  scan [--root PATH] [--quick] [--json]
  plan [--refresh] [--json]
  report
  serve [--root PATH] [--port 4789]   optional legacy web view
  archive (--project NAME | --all-ready) [--execute] [--force] [--prune-generated] [--compact] [--archive-root PATH]
  restore --archive PATH [--target-root PATH] [--execute] [--force] [--keep-archive]

Defaults:
  root: nearest parent named workspaces, then ~/workspaces
  data: ./data/latest-scan.json and ./data/latest-plan.json

Archive:
  dry-run by default; --execute creates PROJECT/PROJECT.tar.gz and keeps the source directory
  dependency/build directories such as node_modules, .venv, venv, dist, build, target are excluded
  --prune-generated moves those rebuildable directories to ~/.Trash after archive creation
  --compact moves every project entry except PROJECT.tar.gz to ~/.Trash after archive creation

Restore:
  dry-run by default; --execute extracts a .tar.gz archive into --target-root
  archives inside the restored project directory are moved to ~/.Trash unless --keep-archive is provided
  existing target directories are refused unless --force is provided
`);
}
