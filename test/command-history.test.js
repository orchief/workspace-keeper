import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCommandHistory } from "../src/command-history.js";

function withTempHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-history-home-"));
  try {
    return fn(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test("command history normalizes leading cd execution into target cwd and tail command", () => {
  withTempHome((homeDir) => {
    const projectPath = path.join(homeDir, "My Project");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(homeDir, ".zsh_history"), [
      `: 1782070000:0;cd "${projectPath}" && npm run dev -- --name 'foo bar'`,
      `: 1782070001:0;cd "${projectPath}" && ls`,
      `: 1782070002:0;cd "${projectPath}" && ssh app uptime`
    ].join("\n"));

    const history = collectCommandHistory({ homeDir });
    const dev = history.commands.find((command) => command.command === "npm run dev -- --name 'foo bar'");
    const ssh = history.commands.find((command) => command.command === "ssh app uptime");

    assert.equal(dev?.count, 1);
    assert.equal(dev.cwdHints[0].cwd, projectPath);
    assert.equal(dev.cwdHints[0].path, "~/My Project");
    assert.equal(dev.lastRunAt, "2026-06-21T19:26:40.000Z");
    assert.equal(ssh?.cwdHints[0].cwd, projectPath);
    assert.equal(history.commands.some((command) => command.command === "cd \"~/My Project\" && ls"), false);
    assert.equal(history.commands.some((command) => command.command === "ls"), false);
  });
});

test("command history merges direct and leading-cd executions by normalized command", () => {
  withTempHome((homeDir) => {
    const projectPath = path.join(homeDir, "api");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(homeDir, ".zsh_history"), [
      `: 1782070000:0;cd "${projectPath}"`,
      ": 1782070001:0;npm test",
      `: 1782070002:0;cd "${projectPath}" && npm test`
    ].join("\n"));

    const history = collectCommandHistory({ homeDir });
    const testCommand = history.commands.find((command) => command.command === "npm test");

    assert.equal(testCommand?.count, 2);
    assert.equal(testCommand.cwdHints[0].cwd, projectPath);
    assert.equal(testCommand.cwdHints[0].count, 2);
    assert.equal(history.commands.some((command) => command.command.includes("cd ") && command.command.includes("npm test")), false);
  });
});

test("command history orders multiple source files by timestamp before assigning sequence", () => {
  withTempHome((homeDir) => {
    fs.writeFileSync(path.join(homeDir, ".zsh_history"), [
      ": 1782070300:0;npm run zsh-newer"
    ].join("\n"));
    fs.writeFileSync(path.join(homeDir, ".bash_history"), [
      "#1782070200",
      "npm run bash-older"
    ].join("\n"));

    const history = collectCommandHistory({ homeDir });
    const zsh = history.commands.find((command) => command.command === "npm run zsh-newer");
    const bash = history.commands.find((command) => command.command === "npm run bash-older");

    assert.equal(bash?.lastSequence, 0);
    assert.equal(zsh?.lastSequence, 1);
    assert.deepEqual(history.commands.slice(0, 2).map((command) => command.command), [
      "npm run zsh-newer",
      "npm run bash-older"
    ]);
  });
});

test("command history ignores failed or missing cd paths when inferring cwd", () => {
  withTempHome((homeDir) => {
    const projectPath = path.join(homeDir, "api");
    const missingPath = path.join(homeDir, "missing");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(homeDir, ".zsh_history"), [
      `: 1782070000:0;cd "${projectPath}"`,
      `: 1782070001:0;cd "${missingPath}"`,
      ": 1782070002:0;npm test",
      `: 1782070003:0;cd "${missingPath}" && npm run dev`
    ].join("\n"));

    const history = collectCommandHistory({ homeDir });
    const testCommand = history.commands.find((command) => command.command === "npm test");

    assert.equal(testCommand?.cwdHints[0].cwd, projectPath);
    assert.equal(history.commands.some((command) => command.command === "npm run dev"), false);
    assert.equal(history.commands.some((command) => command.command.includes(missingPath)), false);
  });
});

test("command history keeps project workflow viewers but filters low-value plain viewers", () => {
  withTempHome((homeDir) => {
    const projectPath = path.join(homeDir, "ios-app");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(homeDir, ".zsh_history"), [
      `: 1782070000:0;cd "${projectPath}"`,
      ": 1782070001:0;tail -f logs/app.log",
      ": 1782070002:0;open ios/Runner.xcworkspace",
      ": 1782070003:0;code .",
      ": 1782070004:0;tail logs/app.log",
      ": 1782070005:0;open README.md",
      ": 1782070006:0;vim README.md"
    ].join("\n"));

    const history = collectCommandHistory({ homeDir });
    const commands = history.commands.map((command) => command.command);

    assert.equal(commands.includes("tail -f logs/app.log"), true);
    assert.equal(commands.includes("open ios/Runner.xcworkspace"), true);
    assert.equal(commands.includes("code ."), true);
    assert.equal(commands.includes("tail logs/app.log"), false);
    assert.equal(commands.includes("open README.md"), false);
    assert.equal(commands.includes("vim README.md"), false);
  });
});
