import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanProject } from "../src/scanner.js";

function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-scan-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function commandHistory(commands) {
  return {
    generatedAt: "2026-06-22T00:00:00.000Z",
    sources: [{ type: "zsh", path: "~/.zsh_history", entries: commands.length }],
    entryCount: commands.length,
    commandCount: commands.length,
    commands
  };
}

function historyCommand(command, cwd, { count = 1, lastSequence = 1, lastRunAt = "2026-06-22T00:00:00.000Z" } = {}) {
  return {
    command,
    count,
    firstRunAt: lastRunAt,
    lastRunAt,
    lastSequence,
    cwdHints: [{
      cwd,
      path: cwd,
      count,
      firstRunAt: lastRunAt,
      lastRunAt,
      lastSequence
    }],
    sources: ["~/.zsh_history"]
  };
}

test("project history usage records non-promotable local history without creating capabilities", () => {
  withTempProject((projectPath) => {
    const nested = path.join(projectPath, "tools");
    fs.mkdirSync(nested);
    const history = commandHistory([
      historyCommand("git status", projectPath, { lastSequence: 10 }),
      historyCommand("claude", projectPath, { lastSequence: 20 }),
      historyCommand("echo workspace-keeper-tui-smoke", nested, { lastSequence: 30 }),
      historyCommand("ssh app uptime", projectPath, { lastSequence: 40 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });

    assert.equal(project.historyUsage.runCount, 3);
    assert.equal(project.historyUsage.commandCount, 3);
    assert.equal(project.historyUsage.lastSequence, 30);
    assert.deepEqual(project.historyUsage.topCommands.map((command) => command.command), [
      "echo workspace-keeper-tui-smoke",
      "claude",
      "git status"
    ]);
    assert.equal(project.historyUsage.topCommands[0].relativeDir, "tools");
    assert.equal(project.capabilitySummary.history, 0);
    assert.equal(project.capabilitySummary.historyRunCount, 0);
    assert.equal(project.capabilities.some((capability) => capability.source?.type === "shell-history"), false);
  });
});

test("promotable history commands still count as project usage and capability usage", () => {
  withTempProject((projectPath) => {
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
      scripts: {
        build: "vite build"
      }
    }));
    const history = commandHistory([
      historyCommand("npm run build", projectPath, { lastSequence: 50 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });
    const build = project.capabilities.find((capability) => capability.name === "build");

    assert.equal(project.historyUsage.runCount, 1);
    assert.equal(project.historyUsage.commandCount, 1);
    assert.equal(project.capabilitySummary.historyMatched, 1);
    assert.equal(project.capabilitySummary.historyRunCount, 1);
    assert.equal(build?.usage?.runCount, 1);
  });
});

test("repeated low-value history commands do not become runnable capabilities", () => {
  withTempProject((projectPath) => {
    const history = commandHistory([
      historyCommand("git status", projectPath, { count: 3, lastSequence: 30 }),
      historyCommand("docker ps", projectPath, { count: 2, lastSequence: 20 }),
      historyCommand("npm run dev", projectPath, { count: 2, lastSequence: 40 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });
    const historyCapabilities = project.capabilities.filter((capability) => capability.source?.type === "shell-history");

    assert.equal(project.historyUsage.runCount, 7);
    assert.deepEqual(historyCapabilities.map((capability) => capability.command), ["npm run dev"]);
    assert.equal(project.capabilitySummary.history, 1);
    assert.equal(project.capabilitySummary.historyRunCount, 2);
  });
});

test("workflow viewer history counts as project usage without becoming capabilities", () => {
  withTempProject((projectPath) => {
    const history = commandHistory([
      historyCommand("tail -f logs/app.log", projectPath, { count: 2, lastSequence: 20 }),
      historyCommand("open ios/Runner.xcworkspace", projectPath, { count: 2, lastSequence: 30 }),
      historyCommand("code .", projectPath, { count: 2, lastSequence: 40 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });
    const historyCapabilities = project.capabilities.filter((capability) => capability.source?.type === "shell-history");

    assert.equal(project.historyUsage.runCount, 6);
    assert.equal(project.historyUsage.commandCount, 3);
    assert.equal(project.historyUsage.signalRunCount, 0);
    assert.equal(project.historyUsage.signalCommandCount, 0);
    assert.equal(project.historyUsage.weakRunCount, 6);
    assert.deepEqual(project.historyUsage.topSignalCommands, []);
    assert.deepEqual(project.historyUsage.topCommands.map((command) => command.command), [
      "code .",
      "open ios/Runner.xcworkspace",
      "tail -f logs/app.log"
    ]);
    assert.equal(historyCapabilities.length, 0);
    assert.equal(project.capabilitySummary.history, 0);
    assert.equal(project.capabilitySummary.historyRunCount, 0);
  });
});

test("strong project history is separated from weak inspection history", () => {
  withTempProject((projectPath) => {
    const history = commandHistory([
      historyCommand("git status", projectPath, { count: 1, lastSequence: 20 }),
      historyCommand("npm run dev", projectPath, { count: 2, lastSequence: 30 }),
      historyCommand("claude", projectPath, { count: 1, lastSequence: 40 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });

    assert.equal(project.historyUsage.runCount, 4);
    assert.equal(project.historyUsage.signalRunCount, 3);
    assert.equal(project.historyUsage.weakRunCount, 1);
    assert.equal(project.historyUsage.signalLastSequence, 40);
    assert.deepEqual(project.historyUsage.topSignalCommands.map((command) => command.command), [
      "npm run dev",
      "claude"
    ]);
  });
});

test("compound history commands use strong child commands without promoting all weak checks", () => {
  withTempProject((projectPath) => {
    const history = commandHistory([
      historyCommand("git status && npm test", projectPath, { count: 5, lastSequence: 50 }),
      historyCommand("git status && git diff", projectPath, { count: 4, lastSequence: 60 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });

    assert.equal(project.historyUsage.runCount, 9);
    assert.equal(project.historyUsage.signalRunCount, 5);
    assert.equal(project.historyUsage.weakRunCount, 4);
    assert.deepEqual(project.historyUsage.topSignalCommands.map((command) => command.command), [
      "git status && npm test"
    ]);
    assert.deepEqual(project.historyUsage.topCommands.map((command) => command.command), [
      "git status && npm test",
      "git status && git diff"
    ]);
  });
});

test("readonly git probe history stays weak and does not become runnable history capability", () => {
  withTempProject((projectPath) => {
    const history = commandHistory([
      historyCommand("git remote -v && git rev-parse --show-toplevel", projectPath, { count: 3, lastSequence: 80 })
    ]);

    const project = scanProject(projectPath, { includeGenerated: false, commandHistory: history });

    assert.equal(project.historyUsage.runCount, 3);
    assert.equal(project.historyUsage.signalRunCount, 0);
    assert.equal(project.historyUsage.weakRunCount, 3);
    assert.deepEqual(project.historyUsage.topSignalCommands, []);
    assert.equal(project.capabilities.some((capability) => capability.source?.type === "shell-history"), false);
  });
});
