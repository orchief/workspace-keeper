import fs from "node:fs";
import path from "node:path";
import { isSshCommand } from "./remote-control.js";

const DEFAULT_MAX_DEPTH = 4;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CAPABILITIES = 120;
const MAX_HISTORY_CANDIDATES = 80;
const CONTEXT_BYTES = 32 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
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

const AUTOMATION_DIRS = new Set([
  ".github",
  "bin",
  "ci",
  "devops",
  "hack",
  "ops",
  "script",
  "scripts",
  "task",
  "tasks",
  "tool",
  "tooling",
  "tools"
]);

const SCRIPT_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".command",
  ".js",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".sql",
  ".ts",
  ".zsh"
]);

const TASKISH_FILE = /\b(build|check|clean|deploy|dev|doctor|format|lint|migrate|release|serve|setup|sync|test)\b/i;

const CATEGORY_RULES = [
  rule("dev", [
    [/\b(dev|develop|local|watch)\b/i, 26, "name or command mentions dev/watch"],
    [/\b(vite|next dev|nuxt dev|astro dev|webpack-dev-server|nodemon|tsx watch|air)\b/i, 30, "dev server command detected"],
    [/\b(flask run|uvicorn|fastapi|django.*runserver|artisan serve|flutter run|cargo run)\b/i, 26, "application run command detected"]
  ]),
  rule("test", [
    [/\b(test|tests|spec|e2e)\b/i, 26, "name or command mentions tests"],
    [/\b(pytest|unittest|jest|vitest|playwright|cypress|mocha|phpunit|go test|cargo test|mvn test|gradle test)\b/i, 34, "test runner detected"]
  ]),
  rule("lint", [
    [/\b(lint|eslint|ruff check|flake8|pylint|golangci|clippy|phpstan|psalm|staticcheck)\b/i, 34, "lint/static analysis command detected"]
  ]),
  rule("format", [
    [/\b(format|fmt|prettier|black|isort|rustfmt|gofmt|ruff format)\b/i, 32, "formatter command detected"]
  ]),
  rule("build", [
    [/\b(build|compile|bundle|assemble)\b/i, 26, "name or command mentions build"],
    [/\b(tsc|vite build|next build|nuxt build|cargo build|go build|mvn package|gradle assemble|flutter build)\b/i, 32, "build tool command detected"]
  ]),
  rule("package", [
    [/\b(pack|package|artifact|wheel|sdist|goreleaser)\b/i, 28, "packaging command detected"],
    [/\bdocker build\b/i, 30, "container image build detected"]
  ]),
  rule("serve", [
    [/\b(serve|server|preview|start)\b/i, 22, "serve/start command detected"],
    [/\b(vite preview|http-server|python -m http\.server|gunicorn|uvicorn)\b/i, 28, "server process command detected"]
  ]),
  rule("setup", [
    [/\b(setup|bootstrap|init|install|deps|prepare)\b/i, 26, "setup/bootstrap command detected"],
    [/\b(npm install|pnpm install|yarn install|bun install|uv sync|pip install|composer install|bundle install|go mod download)\b/i, 32, "dependency setup command detected"]
  ]),
  rule("db", [
    [/\b(db|database|mysql|postgres|psql|sqlite|redis|mongo|elastic)\b/i, 24, "database keyword detected"]
  ]),
  rule("migration", [
    [/\b(migrate|migration|alembic|flyway|liquibase|prisma migrate|typeorm migration|sequelize db:migrate|artisan migrate)\b/i, 38, "database migration command detected"]
  ]),
  rule("seed", [
    [/\b(seed|fixture|fixtures)\b/i, 28, "seed/fixture command detected"]
  ]),
  rule("deploy", [
    [/\b(deploy|ship|rollout)\b/i, 34, "deployment keyword detected"],
    [/\b(kubectl apply|helm upgrade|terraform apply|wrangler deploy|vercel deploy|netlify deploy|fly deploy|serverless deploy|scp|rsync|ssh)\b/i, 40, "remote deployment command detected"]
  ]),
  rule("release", [
    [/\b(release|publish|version|changeset|changelog|tag)\b/i, 30, "release/publish keyword detected"],
    [/\b(npm publish|pnpm publish|yarn publish|cargo publish|semantic-release|goreleaser|git tag)\b/i, 42, "publish or release tool detected"]
  ]),
  rule("docker", [
    [/\b(docker|compose|container|image)\b/i, 34, "container command detected"]
  ]),
  rule("clean", [
    [/\b(clean|cleanup|prune|purge|reset|remove|trash)\b/i, 30, "cleanup command detected"],
    [/\brm\s+-[^\n;&|]*r[^\n;&|]*f\b/i, 40, "recursive removal command detected"]
  ]),
  rule("backup", [
    [/\b(backup|dump|snapshot|archive|tar|mysqldump|pg_dump)\b/i, 30, "backup/archive command detected"]
  ]),
  rule("sync", [
    [/\b(sync|mirror|fetch)\b/i, 28, "sync command detected"],
    [/\b(import-data|export-data|data import|data export)\b/i, 28, "data import/export command detected"],
    [/\b(git pull|git fetch|rsync)\b/i, 30, "repository or file sync command detected"]
  ]),
  rule("diagnose", [
    [/\b(audit|doctor|check|inspect|probe|diagnose|health|status|report|scan|plan)\b/i, 30, "diagnostic command detected"]
  ]),
  rule("ci", [
    [/\b(ci|workflow|actions|pipeline)\b/i, 30, "CI workflow detected"]
  ])
];

export function discoverCapabilities(projectPath, { maxDepth = DEFAULT_MAX_DEPTH, commandHistory = null } = {}) {
  const root = path.resolve(projectPath);
  const detectedCandidates = [
    ...detectPackageScripts(root, maxDepth),
    ...detectComposerScripts(root, maxDepth),
    ...detectPyprojectScripts(root, maxDepth),
    ...detectAutomationFiles(root, maxDepth),
    ...detectMakefiles(root, maxDepth),
    ...detectJustfiles(root, maxDepth),
    ...detectTaskfiles(root, maxDepth),
    ...detectDockerFiles(root, maxDepth),
    ...detectGithubWorkflows(root, maxDepth),
    ...detectFrameworkTasks(root, maxDepth)
  ];
  const historyMatches = matchHistoryCommands(root, commandHistory);
  const detectedWithUsage = annotateDetectedCandidates(detectedCandidates, historyMatches);
  const detectedKeys = new Set(detectedWithUsage.map((candidate) => historyKey(candidate.execution?.cwd || "", commandForHistoryMatch(candidate))));
  const historyCandidates = historyMatches
    .filter((match) => !detectedKeys.has(historyKey(match.relativeDir, match.command)))
    .filter(isPromotableHistoryMatch)
    .sort(compareHistoryMatches)
    .slice(0, MAX_HISTORY_CANDIDATES)
    .map(historyCapabilityCandidate);

  return dedupeCapabilities([...historyCandidates, ...detectedWithUsage].map((candidate) => buildCapability(candidate)).filter(Boolean))
    .sort(compareCapabilities)
    .slice(0, MAX_CAPABILITIES);
}

export function summarizeCapabilities(capabilities = []) {
  const byCategory = {};
  const byRisk = { low: 0, medium: 0, high: 0 };

  for (const capability of capabilities) {
    byCategory[capability.category] = (byCategory[capability.category] || 0) + 1;
    byRisk[capability.risk] = (byRisk[capability.risk] || 0) + 1;
  }

  const topCategories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([category, count]) => ({ category, count }));

  return {
    total: capabilities.length,
    runnable: capabilities.filter((capability) => capability.runnable).length,
    unknown: byCategory.unknown || 0,
    highRisk: byRisk.high || 0,
    mediumRisk: byRisk.medium || 0,
    history: capabilities.filter((capability) => capability.source?.type === "shell-history").length,
    historyMatched: capabilities.filter((capability) => capability.usage?.runCount > 0).length,
    historyRunCount: capabilities.reduce((sum, capability) => sum + (capability.usage?.runCount || 0), 0),
    lastHistoryRunAt: capabilities
      .map((capability) => capability.usage?.lastRunAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    byCategory,
    byRisk,
    topCategories
  };
}

function detectPackageScripts(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => path.basename(relativePath) === "package.json")
    .flatMap(({ filePath, relativePath }) => {
      const pkg = readJson(filePath);
      if (!pkg?.scripts || typeof pkg.scripts !== "object") {
        return [];
      }

      const dir = path.dirname(filePath);
      const relativeDir = path.dirname(relativePath);
      const runner = inferPackageManager(dir, pkg);

      return Object.entries(pkg.scripts)
        .filter(([, command]) => typeof command === "string" && command.trim())
        .map(([name, command]) => ({
          name,
          runtime: runner,
          command: commandInDir(relativeDir, `${runner} run ${shellArg(name)}`),
          analysisCommand: `${runner} run ${name}`,
          context: command,
          sourceType: "package.json",
          sourcePath: relativePath,
          sourceKey: `scripts.${name}`,
          baseConfidence: 58,
          runnable: true,
          categoryHint: null,
          execution: executionSpec(relativeDir, runner, ["run", name])
        }));
    });
}

function detectComposerScripts(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => path.basename(relativePath) === "composer.json")
    .flatMap(({ filePath, relativePath }) => {
      const composer = readJson(filePath);
      if (!composer?.scripts || typeof composer.scripts !== "object") {
        return [];
      }

      const relativeDir = path.dirname(relativePath);
      return Object.entries(composer.scripts)
        .filter(([, command]) => typeof command === "string" || Array.isArray(command))
        .map(([name, command]) => ({
          name,
          runtime: "composer",
          command: commandInDir(relativeDir, `composer ${shellArg(name)}`),
          analysisCommand: `composer ${name}`,
          context: Array.isArray(command) ? command.join("\n") : command,
          sourceType: "composer.json",
          sourcePath: relativePath,
          sourceKey: `scripts.${name}`,
          baseConfidence: 56,
          runnable: true,
          categoryHint: null,
          execution: executionSpec(relativeDir, "composer", [name])
        }));
    });
}

function detectPyprojectScripts(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => path.basename(relativePath) === "pyproject.toml")
    .flatMap(({ filePath, relativePath }) => {
      const content = readSmallText(filePath);
      const relativeDir = path.dirname(relativePath);
      const dir = path.dirname(filePath);
      const runner = fs.existsSync(path.join(dir, "uv.lock")) ? "uv" : "python";
      const entries = [
        ...parseTomlEntries(content, "project.scripts").map((entry) => ({
          ...entry,
          commandPrefix: runner === "uv" ? "uv run" : "python -m",
          sourceKeyPrefix: "project.scripts",
          runtime: runner,
          executionCommand: runner === "uv" ? "uv" : "python",
          executionArgs: runner === "uv" ? ["run", entry.name] : ["-m", entry.name]
        })),
        ...parseTomlEntries(content, "tool.poetry.scripts").map((entry) => ({
          ...entry,
          commandPrefix: runner === "uv" ? "uv run" : "python -m",
          sourceKeyPrefix: "tool.poetry.scripts",
          runtime: runner,
          executionCommand: runner === "uv" ? "uv" : "python",
          executionArgs: runner === "uv" ? ["run", entry.name] : ["-m", entry.name]
        })),
        ...parseTomlEntries(content, "tool.poe.tasks").map((entry) => ({
          ...entry,
          commandPrefix: "poe",
          sourceKeyPrefix: "tool.poe.tasks",
          runtime: "poe",
          executionCommand: "poe",
          executionArgs: [entry.name]
        })),
        ...parseTomlEntries(content, "tool.taskipy.tasks").map((entry) => ({
          ...entry,
          commandPrefix: "task",
          sourceKeyPrefix: "tool.taskipy.tasks",
          runtime: "taskipy",
          executionCommand: "task",
          executionArgs: [entry.name]
        }))
      ];

      return entries.map((entry) => ({
        name: entry.name,
        runtime: entry.runtime,
        command: commandInDir(relativeDir, `${entry.commandPrefix} ${shellArg(entry.name)}`),
        analysisCommand: `${entry.commandPrefix} ${entry.name}`,
        context: entry.value,
        sourceType: "pyproject.toml",
        sourcePath: relativePath,
        sourceKey: `${entry.sourceKeyPrefix}.${entry.name}`,
        baseConfidence: 54,
        runnable: true,
        categoryHint: null,
        execution: executionSpec(relativeDir, entry.executionCommand, entry.executionArgs)
      }));
    });
}

function detectAutomationFiles(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath, filePath) => isAutomationScript(relativePath, filePath))
    .map(({ filePath, relativePath }) => {
      const content = readSmallText(filePath, CONTEXT_BYTES);
      const runtime = inferRuntime(relativePath, content);
      return {
        name: stripKnownExtension(path.basename(relativePath)),
        runtime,
        command: shellPath(relativePath),
        context: content,
        sourceType: "script-file",
        sourcePath: relativePath,
        sourceKey: null,
        baseConfidence: 48,
        runnable: runtime !== "sql",
        categoryHint: runtime === "sql" ? "db" : null,
        execution: runtime === "sql" ? null : scriptExecution(relativePath, runtime)
      };
    });
}

function detectMakefiles(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => /^makefile$/i.test(path.basename(relativePath)))
    .flatMap(({ filePath, relativePath }) => {
      const content = readSmallText(filePath);
      const relativeDir = path.dirname(relativePath);
      return parseMakeTargets(content).map((target) => ({
        name: target.name,
        runtime: "make",
        command: commandInDir(relativeDir, `make ${shellArg(target.name)}`),
        analysisCommand: `make ${target.name}`,
        context: target.recipe,
        sourceType: "Makefile",
        sourcePath: relativePath,
        sourceKey: target.name,
        baseConfidence: 55,
        runnable: true,
        categoryHint: null,
        execution: executionSpec(relativeDir, "make", [target.name])
      }));
    });
}

function detectJustfiles(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => /^justfile$/i.test(path.basename(relativePath)))
    .flatMap(({ filePath, relativePath }) => {
      const content = readSmallText(filePath);
      const relativeDir = path.dirname(relativePath);
      return parseJustRecipes(content).map((recipe) => ({
        name: recipe.name,
        runtime: "just",
        command: commandInDir(relativeDir, `just ${shellArg(recipe.name)}`),
        analysisCommand: `just ${recipe.name}`,
        context: recipe.body,
        sourceType: "justfile",
        sourcePath: relativePath,
        sourceKey: recipe.name,
        baseConfidence: 56,
        runnable: true,
        categoryHint: null,
        execution: executionSpec(relativeDir, "just", [recipe.name])
      }));
    });
}

function detectTaskfiles(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => /^taskfile\.(ya?ml)$/i.test(path.basename(relativePath)))
    .flatMap(({ filePath, relativePath }) => {
      const content = readSmallText(filePath);
      const relativeDir = path.dirname(relativePath);
      return parseTaskfileTasks(content).map((task) => ({
        name: task.name,
        runtime: "task",
        command: commandInDir(relativeDir, `task ${shellArg(task.name)}`),
        analysisCommand: `task ${task.name}`,
        context: task.body,
        sourceType: "Taskfile",
        sourcePath: relativePath,
        sourceKey: task.name,
        baseConfidence: 56,
        runnable: true,
        categoryHint: null,
        execution: executionSpec(relativeDir, "task", [task.name])
      }));
    });
}

function detectDockerFiles(root, maxDepth) {
  const files = findFiles(root, maxDepth, (relativePath) => {
    const base = path.basename(relativePath);
    return base === "Dockerfile" || base === "docker-compose.yml" || base === "compose.yml" || base === "docker-compose.yaml" || base === "compose.yaml";
  });

  return files.flatMap(({ filePath, relativePath }) => {
    const base = path.basename(relativePath);
    const relativeDir = path.dirname(relativePath);
    const content = readSmallText(filePath, CONTEXT_BYTES);

    if (base === "Dockerfile") {
      return [{
        name: "docker-build",
        runtime: "docker",
        command: commandInDir(relativeDir, `docker build -f ${shellQuote(base)} .`),
        analysisCommand: `docker build -f ${shellQuote(base)} .`,
        context: content,
        sourceType: "Dockerfile",
        sourcePath: relativePath,
        sourceKey: null,
        baseConfidence: 62,
        runnable: true,
        categoryHint: "docker",
        forceCategory: true,
        execution: executionSpec(relativeDir, "docker", ["build", "-f", base, "."])
      }];
    }

    return [
      {
        name: "compose-up",
        runtime: "docker",
        command: commandInDir(relativeDir, `docker compose -f ${shellQuote(base)} up`),
        analysisCommand: `docker compose -f ${shellQuote(base)} up`,
        context: content,
        sourceType: "compose",
        sourcePath: relativePath,
        sourceKey: "up",
        baseConfidence: 64,
        runnable: true,
        categoryHint: "docker",
        forceCategory: true,
        execution: executionSpec(relativeDir, "docker", ["compose", "-f", base, "up"])
      },
      {
        name: "compose-logs",
        runtime: "docker",
        command: commandInDir(relativeDir, `docker compose -f ${shellQuote(base)} logs`),
        analysisCommand: `docker compose -f ${shellQuote(base)} logs`,
        context: content,
        sourceType: "compose",
        sourcePath: relativePath,
        sourceKey: "logs",
        baseConfidence: 60,
        runnable: true,
        categoryHint: "diagnose",
        forceCategory: true,
        execution: executionSpec(relativeDir, "docker", ["compose", "-f", base, "logs"])
      }
    ];
  });
}

function detectGithubWorkflows(root, maxDepth) {
  return findFiles(root, maxDepth, (relativePath) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(relativePath))
    .map(({ filePath, relativePath }) => {
      const content = readSmallText(filePath, CONTEXT_BYTES);
      const workflowName = content.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") || stripKnownExtension(path.basename(relativePath));
      return {
        name: workflowName,
        runtime: "github-actions",
        command: `GitHub Actions workflow: ${workflowName}`,
        context: content,
        sourceType: "github-actions",
        sourcePath: relativePath,
        sourceKey: "workflow",
        baseConfidence: 66,
        runnable: false,
        categoryHint: "ci"
      };
    });
}

function detectFrameworkTasks(root, maxDepth) {
  const capabilities = [];

  for (const { filePath, relativePath } of findFiles(root, maxDepth, (relativePath) => frameworkMarker(relativePath))) {
    const base = path.basename(relativePath);
    const dir = path.dirname(filePath);
    const relativeDir = path.dirname(relativePath);

    if (base === "go.mod") {
      capabilities.push(inferred(relativePath, relativeDir, "go-test", "go", "go test ./...", "test", "Go module marker detected"));
      capabilities.push(inferred(relativePath, relativeDir, "go-build", "go", "go build ./...", "build", "Go module marker detected"));
    }

    if (base === "Cargo.toml") {
      capabilities.push(inferred(relativePath, relativeDir, "cargo-test", "cargo", "cargo test", "test", "Cargo manifest detected"));
      capabilities.push(inferred(relativePath, relativeDir, "cargo-build", "cargo", "cargo build", "build", "Cargo manifest detected"));
    }

    if (base === "pubspec.yaml") {
      capabilities.push(inferred(relativePath, relativeDir, "flutter-test", "flutter", "flutter test", "test", "Flutter manifest detected"));
      capabilities.push(inferred(relativePath, relativeDir, "flutter-build", "flutter", "flutter build", "build", "Flutter manifest detected"));
    }

    if (base === "pom.xml") {
      const mvn = fs.existsSync(path.join(dir, "mvnw")) ? "./mvnw" : "mvn";
      capabilities.push(inferred(relativePath, relativeDir, "maven-test", "maven", `${mvn} test`, "test", "Maven project marker detected"));
      capabilities.push(inferred(relativePath, relativeDir, "maven-package", "maven", `${mvn} package`, "build", "Maven project marker detected"));
    }

    if (/^build\.gradle(\.kts)?$/.test(base)) {
      const gradle = fs.existsSync(path.join(dir, "gradlew")) ? "./gradlew" : "gradle";
      capabilities.push(inferred(relativePath, relativeDir, "gradle-test", "gradle", `${gradle} test`, "test", "Gradle project marker detected"));
      capabilities.push(inferred(relativePath, relativeDir, "gradle-build", "gradle", `${gradle} build`, "build", "Gradle project marker detected"));
    }

    if (base === "pyproject.toml" || base === "requirements.txt") {
      const runner = fs.existsSync(path.join(dir, "uv.lock")) ? "uv run" : "python -m";
      if (fs.existsSync(path.join(dir, "tests")) || fs.existsSync(path.join(dir, "pytest.ini"))) {
        capabilities.push(inferred(relativePath, relativeDir, "pytest", runner.startsWith("uv") ? "uv" : "python", `${runner} pytest`, "test", "Python tests marker detected"));
      }
      if (fs.existsSync(path.join(dir, "ruff.toml")) || readSmallText(filePath, CONTEXT_BYTES).includes("ruff")) {
        capabilities.push(inferred(relativePath, relativeDir, "ruff-check", runner.startsWith("uv") ? "uv" : "python", `${runner} ruff check .`, "lint", "Ruff marker detected"));
      }
    }
  }

  for (const { relativePath } of findFiles(root, maxDepth, (relativePath) => path.basename(relativePath) === "manage.py")) {
    const relativeDir = path.dirname(relativePath);
    capabilities.push(inferred(relativePath, relativeDir, "django-runserver", "python", "python manage.py runserver", "dev", "Django manage.py detected"));
    capabilities.push(inferred(relativePath, relativeDir, "django-migrate", "python", "python manage.py migrate", "migration", "Django manage.py detected"));
  }

  for (const { relativePath } of findFiles(root, maxDepth, (relativePath) => path.basename(relativePath) === "artisan")) {
    const relativeDir = path.dirname(relativePath);
    capabilities.push(inferred(relativePath, relativeDir, "artisan-serve", "php", "php artisan serve", "dev", "Laravel artisan detected"));
    capabilities.push(inferred(relativePath, relativeDir, "artisan-migrate", "php", "php artisan migrate", "migration", "Laravel artisan detected"));
  }

  return capabilities;
}

function inferred(sourcePath, relativeDir, name, runtime, command, categoryHint, reason) {
  return {
    name,
    runtime,
    command: commandInDir(relativeDir, command),
    analysisCommand: command,
    context: `${name}\n${command}\n${reason}`,
    sourceType: "inferred",
    sourcePath,
    sourceKey: null,
    baseConfidence: 48,
    runnable: true,
    categoryHint,
    execution: simpleExecutionSpec(relativeDir, command)
  };
}

function matchHistoryCommands(root, commandHistory) {
  if (!commandHistory?.commands?.length) {
    return [];
  }

  const matches = [];
  for (const historyCommand of commandHistory.commands) {
    if (isSshCommand(historyCommand.command)) {
      continue;
    }

    for (const hint of historyCommand.cwdHints || []) {
      const cwd = path.resolve(hint.cwd);
      if (!isInside(root, cwd)) {
        continue;
      }

      const leadingCd = stripLeadingCdExecution(historyCommand.command, cwd);
      const command = leadingCd.command || historyCommand.command;
      if (!command || command === "cd" || command.startsWith("cd ")) {
        continue;
      }

      const relativeDir = path.relative(root, leadingCd.cwd || cwd).split(path.sep).join("/");
      if (relativeDir.startsWith("..")) {
        continue;
      }

      matches.push({
        command,
        originalCommand: historyCommand.command,
        relativeDir,
        cwd: leadingCd.cwd || cwd,
        count: hint.count || historyCommand.count || 1,
        firstRunAt: hint.firstRunAt || historyCommand.firstRunAt || null,
        lastRunAt: hint.lastRunAt || historyCommand.lastRunAt || null,
        lastSequence: hint.lastSequence ?? historyCommand.lastSequence ?? -1,
        sources: historyCommand.sources || []
      });
    }
  }

  return mergeHistoryMatches(matches);
}

function mergeHistoryMatches(matches) {
  const byKey = new Map();

  for (const match of matches) {
    const key = historyKey(match.relativeDir, match.command);
    const existing = byKey.get(key) || {
      ...match,
      count: 0,
      sources: new Set()
    };
    existing.count += match.count;
    existing.firstRunAt = earliestIso(existing.firstRunAt, match.firstRunAt);
    existing.lastRunAt = latestIso(existing.lastRunAt, match.lastRunAt);
    existing.lastSequence = Math.max(existing.lastSequence, match.lastSequence);
    for (const source of match.sources) {
      existing.sources.add(source);
    }
    byKey.set(key, existing);
  }

  return [...byKey.values()].map((match) => ({
    ...match,
    sources: [...match.sources].sort()
  }));
}

function annotateDetectedCandidates(candidates, historyMatches) {
  const historyByKey = new Map();
  for (const match of historyMatches) {
    historyByKey.set(historyKey(match.relativeDir, match.command), match);
  }

  return candidates.map((candidate) => {
    const command = commandForHistoryMatch(candidate);
    const key = historyKey(candidate.execution?.cwd || "", command);
    const match = historyByKey.get(key);
    if (!match) {
      return candidate;
    }

    return {
      ...candidate,
      baseConfidence: Math.min(86, candidate.baseConfidence + historyConfidenceBoost(match.count)),
      usage: usageFromHistoryMatch(match, "matched existing capability"),
      context: [
        candidate.context,
        `History usage: ${match.count} run${match.count === 1 ? "" : "s"}`,
        match.lastRunAt ? `Last run: ${match.lastRunAt}` : ""
      ].filter(Boolean).join("\n")
    };
  });
}

function historyCapabilityCandidate(match) {
  const relativeDir = match.relativeDir || "";
  return {
    name: historyCapabilityName(match.command),
    runtime: inferHistoryRuntime(match.command),
    command: match.command,
    analysisCommand: match.command,
    context: [
      "Shell history command",
      `Run count: ${match.count}`,
      match.lastRunAt ? `Last run: ${match.lastRunAt}` : "",
      match.originalCommand !== match.command ? `Original: ${match.originalCommand}` : ""
    ].filter(Boolean).join("\n"),
    sourceType: "shell-history",
    sourcePath: relativeDir || ".",
    sourceKey: match.command,
    baseConfidence: Math.min(88, 44 + historyConfidenceBoost(match.count)),
    runnable: true,
    categoryHint: null,
    execution: executionSpec(relativeDir, "shell", ["-lc", match.command]),
    usage: usageFromHistoryMatch(match, "observed in shell history")
  };
}

function commandForHistoryMatch(candidate) {
  return stripCommandInDir(candidate.command)?.command || candidate.analysisCommand || candidate.command;
}

function usageFromHistoryMatch(match, reason) {
  return {
    runCount: match.count,
    firstRunAt: match.firstRunAt,
    lastRunAt: match.lastRunAt,
    lastSequence: match.lastSequence,
    cwd: match.relativeDir || "",
    cwdPath: match.cwd,
    originalCommand: match.originalCommand,
    sources: match.sources,
    reason
  };
}

function historyConfidenceBoost(count) {
  return Math.min(36, Math.round(Math.log2(Math.max(1, count)) * 10) + Math.min(10, count));
}

function compareHistoryMatches(a, b) {
  return b.count - a.count ||
    b.lastSequence - a.lastSequence ||
    (b.lastRunAt || "").localeCompare(a.lastRunAt || "") ||
    a.command.localeCompare(b.command);
}

function isPromotableHistoryMatch(match) {
  const command = normalizeHistoryComparableCommand(match.command);
  if (isLowValueHistoryCapabilityCommand(command)) {
    return false;
  }

  if ((match.count || 0) > 1) {
    return true;
  }

  return /^(npm|pnpm|yarn|bun)\s+(run\s+)?[A-Za-z0-9:_@%+=,./-]+$/i.test(command) ||
    /^uv\s+run\s+\S+/i.test(command) ||
    /^python\s+-m\s+\S+/i.test(command) ||
    /^(make|just|task)\s+\S+/i.test(command) ||
    /^go\s+test\b/i.test(command) ||
    /^cargo\s+(test|build|run)\b/i.test(command) ||
    /^docker\s+compose\s+(up|logs|ps|build)\b/i.test(command);
}

function isLowValueHistoryCapabilityCommand(command) {
  return /^(git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files|describe|merge-base)|git\s+config\s+--get|docker\s+ps|docker\s+compose\s+ps|container\s+system\s+status)\b/i.test(command) ||
    /^tail\s+-f\b/i.test(command) ||
    /^open\b.*\.(xcworkspace|xcodeproj|workspace|code-workspace)\b/i.test(command) ||
    /^code\s+\.$/i.test(command) ||
    /^(go|git|docker|kubectl|helm|terraform|node|python|uv|npm|pnpm|yarn|bun|nvm)$/i.test(command);
}

function historyKey(relativeDir, command) {
  return `${normalizeRelativeDir(relativeDir)}\x1f${normalizeHistoryComparableCommand(command)}`;
}

function normalizeRelativeDir(relativeDir) {
  return !relativeDir || relativeDir === "." ? "" : relativeDir.split(path.sep).join("/");
}

function normalizeHistoryComparableCommand(command) {
  return String(command || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^npm run ([A-Za-z0-9:_@%+=,./-]+)$/i, "npm run $1")
    .replace(/^pnpm run ([A-Za-z0-9:_@%+=,./-]+)$/i, "pnpm run $1")
    .replace(/^yarn run ([A-Za-z0-9:_@%+=,./-]+)$/i, "yarn run $1");
}

function historyCapabilityName(command) {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "history-command";
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(parts[0]) && parts[1] === "run" && parts[2]) {
    return `history:${parts[2]}`;
  }
  if (parts[0] === "uv" && parts[1] === "run" && parts[2]) {
    return `history:uv ${parts[2]}`;
  }
  if (parts[0] === "python" && parts[1] === "-m" && parts[2]) {
    return `history:python ${parts[2]}`;
  }
  return `history:${parts.slice(0, 3).join(" ")}`.slice(0, 80);
}

function inferHistoryRuntime(command) {
  const first = command.trim().split(/\s+/)[0] || "shell";
  if (["npm", "pnpm", "yarn", "bun", "node", "python", "uv", "php", "composer", "go", "cargo", "docker", "kubectl", "make", "just", "task"].includes(first)) {
    return first;
  }
  if (first.startsWith("./")) {
    return "shell";
  }
  return "shell";
}

function stripLeadingCdExecution(command, fallbackCwd) {
  const stripped = stripCommandInDir(command);
  if (!stripped) {
    return { command, cwd: fallbackCwd };
  }
  return {
    command: stripped.command,
    cwd: path.resolve(fallbackCwd)
  };
}

function stripCommandInDir(command) {
  const match = String(command || "").match(/^cd\s+((?:'[^']+'|"[^"]+"|\\.|[^\s;&|])+)\s*(?:&&|;)\s*(.+)$/);
  if (!match) {
    return null;
  }
  return {
    dir: unquoteShellToken(match[1]),
    command: match[2].trim()
  };
}

function unquoteShellToken(value) {
  const text = String(value || "");
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\""))) {
    return text.slice(1, -1);
  }
  return text.replace(/\\(.)/g, "$1");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function buildCapability(candidate) {
  const contextForClassification = shouldUseContextForClassification(candidate) ? candidate.context : "";
  const contextForRisk = shouldUseContextForRisk(candidate) ? candidate.context : "";
  const analysisCommand = candidate.analysisCommand || candidate.command;
  const classificationText = [
    candidate.name,
    analysisCommand,
    contextForClassification,
    candidate.sourceKey
  ].filter(Boolean).join("\n");
  const riskText = [
    candidate.name,
    analysisCommand,
    contextForRisk,
    classificationText,
    candidate.sourcePath
  ].filter(Boolean).join("\n");

  const classification = candidate.forceCategory
    ? {
        category: candidate.categoryHint || "unknown",
        score: 34,
        reasons: [`source implies ${candidate.categoryHint || "unknown"}`]
      }
    : classifyText(classificationText, candidate.categoryHint);
  const risk = assessRisk(riskText, classification.category);
  const confidence = clamp(
    candidate.baseConfidence + Math.min(38, classification.score) - (classification.category === "unknown" ? 20 : 0),
    15,
    99
  );

  return {
    id: stableId(`${candidate.sourceType}:${candidate.sourcePath}:${candidate.sourceKey || candidate.name}:${candidate.command}`),
    name: candidate.name,
    category: classification.category,
    risk: risk.level,
    confidence,
    runtime: candidate.runtime,
    command: candidate.command,
    runnable: Boolean(candidate.runnable),
    execution: candidate.execution || null,
    usage: candidate.usage || null,
    source: {
      type: candidate.sourceType,
      path: candidate.sourcePath,
      key: candidate.sourceKey
    },
    reasons: unique(classification.reasons).slice(0, 5),
    riskSignals: unique(risk.signals).slice(0, 6),
    sideEffects: unique(risk.sideEffects).slice(0, 6)
  };
}

function shouldUseContextForClassification(candidate) {
  return !["Dockerfile", "compose"].includes(candidate.sourceType);
}

function shouldUseContextForRisk(candidate) {
  return !["Dockerfile", "compose"].includes(candidate.sourceType);
}

function classifyText(text, categoryHint) {
  const scores = new Map();
  const reasonsByCategory = new Map();

  if (categoryHint) {
    scores.set(categoryHint, 22);
    addReason(reasonsByCategory, categoryHint, `source implies ${categoryHint}`);
  }

  for (const categoryRule of CATEGORY_RULES) {
    for (const [pattern, weight, reason] of categoryRule.patterns) {
      if (pattern.test(text)) {
        scores.set(categoryRule.category, (scores.get(categoryRule.category) || 0) + weight);
        addReason(reasonsByCategory, categoryRule.category, reason);
      }
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [category = "unknown", score = 0] = ranked[0] || [];

  if (!ranked.length || score < 18) {
    return {
      category: "unknown",
      score,
      reasons: ["no strong task signal"]
    };
  }

  return { category, score, reasons: reasonsByCategory.get(category) || [`matched ${category} signal`] };
}

function addReason(reasonsByCategory, category, reason) {
  if (!reasonsByCategory.has(category)) {
    reasonsByCategory.set(category, []);
  }
  reasonsByCategory.get(category).push(reason);
}

function assessRisk(text, category) {
  const signals = [];
  const sideEffects = new Set();
  let level = "low";

  const highPatterns = [
    [/\brm\b(?=[^\n;&|]*\s-[^\n;&|]*r)(?=[^\n;&|]*\s-[^\n;&|]*f)/i, "recursive file removal", "filesystem"],
    [/\bfind\b[^\n;&|]*\s-delete\b/i, "find delete", "filesystem"],
    [/\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b/i, "privileged or recursive permission change", "filesystem"],
    [/\bgit\s+reset\b[^\n;&|]*\s--hard\b|\bgit\s+clean\b[^\n;&|]*\s-[^\n;&|]*[fxd]/i, "destructive git working tree reset", "filesystem"],
    [/\bgit\s+(restore\s+\.|checkout\s+--\s+\.)(?:\s|$)/i, "destructive git working tree reset", "filesystem"],
    [/\bgit\s+push\b|\bgit\s+tag\b/i, "writes to git remote or tags", "remote"],
    [/\b(npm|pnpm|yarn|bun|cargo)\s+publish\b/i, "publishes package artifact", "publish"],
    [/\bdocker\s+push\b/i, "pushes container image", "publish"],
    [/\b(kubectl\s+(apply|delete|scale|rollout)|helm\s+(upgrade|install|delete)|terraform\s+(apply|destroy)|wrangler\s+deploy|vercel\s+deploy|netlify\s+deploy|fly\s+deploy|serverless\s+deploy)\b/i, "changes remote infrastructure", "remote"],
    [/\b(ssh|scp|rsync)\b/i, "uses remote shell or file sync", "remote"],
    [/\bcurl\b[^\n]*(\-X\s*(POST|PUT|PATCH|DELETE)|\-\-request\s+(POST|PUT|PATCH|DELETE)|\s-d\s|--data)\b/i, "non-idempotent HTTP request", "network"],
    [/\bredis-cli\b[^\n;&|]*\bflush(all|db)\b/i, "redis flush", "database"],
    [/\b(drop\s+database|drop\s+table|truncate\s+table|delete\s+from|update\s+\w+\s+set)\b/i, "destructive SQL statement", "database"],
    [/\bdocker\s+(compose\s+)?(down|rm|system\s+prune|volume\s+(prune|rm))\b/i, "stops or removes containers/resources", "container"],
    [/\b(pm2\s+(delete|restart|reload|stop)|systemctl\s+(restart|stop|reload|start)|service\s+\S+\s+(restart|stop|reload|start)|supervisorctl\s+(restart|stop|reload|start))\b/i, "process or service lifecycle change", "process"],
    [/\bkill\s+-9\b/i, "force kills processes", "process"]
  ];

  const mediumPatterns = [
    [/\b(npm|pnpm|yarn|bun|pip|uv|composer|bundle)\s+install\b|\buv\s+sync\b/i, "installs dependencies", "filesystem"],
    [/\bdocker\s+(build|compose\s+up)\b/i, "builds or starts containers", "container"],
    [/\b(curl|wget)\b/i, "uses network access", "network"],
    [/\b(mkdir|cp|mv|touch|tee)\b/i, "writes local files", "filesystem"],
    [/\b(mysql|psql|sqlite3|redis-cli|mongo)\b/i, "connects to data service", "database"]
  ];

  for (const [pattern, signal, sideEffect] of highPatterns) {
    if (pattern.test(text)) {
      signals.push(signal);
      sideEffects.add(sideEffect);
      level = "high";
    }
  }

  for (const [pattern, signal, sideEffect] of mediumPatterns) {
    if (pattern.test(text)) {
      signals.push(signal);
      sideEffects.add(sideEffect);
      if (level !== "high") {
        level = "medium";
      }
    }
  }

  if (["deploy", "release", "migration"].includes(category)) {
    signals.push(`${category} capability`);
    sideEffects.add(category === "migration" ? "database" : "remote");
    level = "high";
  }

  if (category === "clean" && level !== "high") {
    signals.push("cleanup capability");
    sideEffects.add("filesystem");
    level = "medium";
  }

  if (category === "build" && level === "low") {
    signals.push("build writes artifacts");
    sideEffects.add("filesystem");
    level = "medium";
  }

  return {
    level,
    signals: signals.length ? signals : ["read-only or local developer task"],
    sideEffects: [...sideEffects]
  };
}

function findFiles(root, maxDepth, predicate) {
  const matches = [];

  function visit(dir, depth) {
    if (depth > maxDepth) {
      return;
    }

    for (const dirent of safeReaddirWithTypes(dir)) {
      if (dirent.isDirectory() && IGNORED_DIRS.has(dirent.name)) {
        continue;
      }

      const filePath = path.join(dir, dirent.name);
      const relativePath = path.relative(root, filePath).split(path.sep).join("/");

      if (dirent.isDirectory()) {
        visit(filePath, depth + 1);
        continue;
      }

      if (dirent.isFile() && predicate(relativePath, filePath)) {
        matches.push({ filePath, relativePath });
      }
    }
  }

  visit(root, 0);
  return matches.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function isAutomationScript(relativePath, filePath) {
  const segments = relativePath.split("/");
  const base = path.basename(relativePath);
  const ext = path.extname(base);

  if (segments.some((segment) => segment === "__pycache__" || segment === ".pytest_cache")) {
    return false;
  }

  if (!SCRIPT_EXTENSIONS.has(ext) && !hasShebang(filePath)) {
    return false;
  }

  if (segments.some((segment) => AUTOMATION_DIRS.has(segment))) {
    return true;
  }

  return segments.length === 1 && TASKISH_FILE.test(base);
}

function hasShebang(filePath) {
  const text = readSmallText(filePath, 256);
  return text.startsWith("#!");
}

function inferRuntime(relativePath, content) {
  const ext = path.extname(relativePath);
  if (ext === ".sh" || ext === ".bash") return "shell";
  if (ext === ".zsh") return "zsh";
  if (ext === ".py") return "python";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "node";
  if (ext === ".ts") return "typescript";
  if (ext === ".php") return "php";
  if (ext === ".rb") return "ruby";
  if (ext === ".sql") return "sql";
  if (/python/.test(content.slice(0, 120))) return "python";
  if (/(bash|sh|zsh)/.test(content.slice(0, 120))) return "shell";
  if (/node/.test(content.slice(0, 120))) return "node";
  return "script";
}

function parseMakeTargets(content) {
  const lines = content.split("\n");
  const targets = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_.-][A-Za-z0-9_. -]*):(?:\s|$)/);
    if (!match || line.includes(":=")) {
      continue;
    }

    for (const name of match[1].trim().split(/\s+/)) {
      if (!isPublicTaskName(name)) {
        continue;
      }
      targets.push({
        name,
        recipe: collectIndentedBlock(lines, index + 1)
      });
    }
  }

  return targets;
}

function parseJustRecipes(content) {
  const lines = content.split("\n");
  const recipes = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(#|set\s|export\s|import\s|mod\s|alias\s|[A-Za-z0-9_-]+\s*:=)/.test(line)) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:\s*$/);
    if (!match || !isPublicTaskName(match[1])) {
      continue;
    }

    recipes.push({
      name: match[1],
      body: collectIndentedBlock(lines, index + 1)
    });
  }

  return recipes;
}

function parseTaskfileTasks(content) {
  const lines = content.split("\n");
  const tasks = [];
  let inTasks = false;
  let tasksIndent = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const indent = line.search(/\S|$/);

    if (!inTasks && /^tasks:\s*$/.test(trimmed)) {
      inTasks = true;
      tasksIndent = indent;
      continue;
    }

    if (!inTasks || !trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (indent <= tasksIndent) {
      break;
    }

    const match = line.match(/^(\s{2,})([A-Za-z0-9_.-]+):\s*$/);
    if (match && isPublicTaskName(match[2])) {
      tasks.push({
        name: match[2],
        body: collectYamlBlock(lines, index + 1, match[1].length)
      });
    }
  }

  return tasks;
}

function parseTomlEntries(content, section) {
  const entries = [];
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (currentSection !== section) {
      continue;
    }

    const entryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!entryMatch) {
      continue;
    }

    const value = parseTomlValue(entryMatch[2]);
    if (value) {
      entries.push({ name: entryMatch[1], value });
    }
  }

  return entries;
}

function parseTomlValue(rawValue) {
  const value = rawValue.trim();
  const quoted = value.match(/^["'](.+)["']$/);
  if (quoted) {
    return quoted[1];
  }

  const cmd = value.match(/\bcmd\s*=\s*["']([^"']+)["']/);
  if (cmd) {
    return cmd[1];
  }

  const shell = value.match(/\bshell\s*=\s*["']([^"']+)["']/);
  if (shell) {
    return shell[1];
  }

  return "";
}

function stripTomlComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? "" : char;
    }
    if (char === "#" && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function collectIndentedBlock(lines, start) {
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    if (!/^\s/.test(line)) {
      break;
    }
    block.push(line.trim());
  }
  return block.join("\n").slice(0, 1200);
}

function collectYamlBlock(lines, start, parentIndent) {
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    const indent = line.search(/\S|$/);
    if (indent <= parentIndent) {
      break;
    }
    block.push(line.trim());
  }
  return block.join("\n").slice(0, 1200);
}

function frameworkMarker(relativePath) {
  const base = path.basename(relativePath);
  return base === "go.mod" ||
    base === "Cargo.toml" ||
    base === "pubspec.yaml" ||
    base === "pom.xml" ||
    /^build\.gradle(\.kts)?$/.test(base) ||
    base === "pyproject.toml" ||
    base === "requirements.txt";
}

function isPublicTaskName(name) {
  return Boolean(name) &&
    !name.startsWith(".") &&
    !name.includes("%") &&
    !name.includes("$") &&
    !["FORCE", "PHONY"].includes(name);
}

function inferPackageManager(dir, pkg) {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) {
    return declared;
  }
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "bun.lock")) || fs.existsSync(path.join(dir, "bun.lockb"))) return "bun";
  return "npm";
}

function commandInDir(relativeDir, command) {
  if (!relativeDir || relativeDir === ".") {
    return command;
  }
  return `cd ${shellQuote(relativeDir)} && ${command}`;
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }
  return shellQuote(text);
}

function shellPath(relativePath) {
  return shellArg(`./${relativePath}`);
}

function executionSpec(relativeDir, command, args = []) {
  return {
    cwd: !relativeDir || relativeDir === "." ? "" : relativeDir,
    command,
    args
  };
}

function scriptExecution(relativePath, runtime) {
  const dir = path.dirname(relativePath);
  const base = path.basename(relativePath);
  const cwd = dir === "." ? "" : dir;

  if (runtime === "shell" || runtime === "zsh" || runtime === "script") {
    return executionSpec(cwd, runtime === "zsh" ? "zsh" : "sh", [base]);
  }
  if (runtime === "python") {
    return executionSpec(cwd, "python", [base]);
  }
  if (runtime === "node") {
    return executionSpec(cwd, "node", [base]);
  }
  if (runtime === "typescript") {
    return executionSpec(cwd, "tsx", [base]);
  }
  if (runtime === "php") {
    return executionSpec(cwd, "php", [base]);
  }
  if (runtime === "ruby") {
    return executionSpec(cwd, "ruby", [base]);
  }
  if (runtime === "sql") {
    return null;
  }
  return executionSpec(cwd, "sh", [base]);
}

function simpleExecutionSpec(relativeDir, command) {
  if (/[;&|<>$*?`]/.test(command)) {
    return null;
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return null;
  }
  return executionSpec(relativeDir, parts[0], parts.slice(1));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function stripKnownExtension(fileName) {
  const ext = path.extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

function readJson(filePath) {
  const content = readSmallText(filePath);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readSmallText(filePath, limit = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return "";
    }
    const content = fs.readFileSync(filePath, "utf8");
    return content.slice(0, limit);
  } catch {
    return "";
  }
}

function safeReaddirWithTypes(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function dedupeCapabilities(capabilities) {
  const seen = new Set();
  const uniqueCapabilities = [];

  for (const capability of capabilities) {
    const key = `${capability.source.path}:${capability.source.key || capability.name}:${capability.command}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueCapabilities.push(capability);
  }

  return uniqueCapabilities;
}

function compareCapabilities(a, b) {
  return usageScore(b) - usageScore(a) ||
    sourceScore(b) - sourceScore(a) ||
    riskRank(a.risk) - riskRank(b.risk) ||
    (b.usage?.lastSequence || 0) - (a.usage?.lastSequence || 0) ||
    b.confidence - a.confidence ||
    a.category.localeCompare(b.category) ||
    a.name.localeCompare(b.name);
}

function usageScore(capability) {
  return capability.usage?.runCount || 0;
}

function sourceScore(capability) {
  if (capability.source?.type === "shell-history") {
    return 40;
  }
  if (capability.usage?.runCount) {
    return 30;
  }
  if (capability.source?.type === "package.json") {
    return 10;
  }
  return 0;
}

function riskRank(risk) {
  if (risk === "low") return 0;
  if (risk === "medium") return 1;
  return 2;
}

function stableId(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return `cap-${(hash >>> 0).toString(36)}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function rule(category, patterns) {
  return { category, patterns };
}
