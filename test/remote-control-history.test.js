import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCommandHistory } from "../src/command-history.js";
import { discoverRemoteControl } from "../src/remote-control.js";

function withTempWorkspace(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-remote-home-"));
  try {
    const workspaceRoot = path.join(homeDir, "workspaces");
    const projectPath = path.join(workspaceRoot, "api");
    fs.mkdirSync(projectPath, { recursive: true });
    return fn({ homeDir, workspaceRoot, projectPath });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test("remote control links leading-cd ssh history to the local project cwd", () => {
  withTempWorkspace(({ homeDir, workspaceRoot, projectPath }) => {
    fs.mkdirSync(path.join(homeDir, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".ssh", "config"), [
      "Host app",
      "  HostName app.example.com",
      "  User deploy"
    ].join("\n"));
    fs.writeFileSync(path.join(homeDir, ".zsh_history"), [
      `: 1782070000:0;cd "${projectPath}" && ssh app uptime`,
      `: 1782070001:0;cd "${projectPath}" && ssh app uptime`
    ].join("\n"));

    const commandHistory = collectCommandHistory({ homeDir });
    const remoteControl = discoverRemoteControl(commandHistory, {
      homeDir,
      workspaceRoot,
      workspaceProjects: [{ name: "api", path: projectPath }]
    });
    const device = remoteControl.devices.find((item) => item.alias === "app");
    const command = device?.commands.find((item) => item.fullSshCommand === "ssh app uptime");

    assert.equal(device?.source?.type, "ssh-config");
    assert.equal(command?.count, 2);
    assert.equal(command?.execution.cwd, projectPath);
    assert.deepEqual(command?.localProjects.map((project) => ({
      name: project.name,
      count: project.count,
      source: project.source
    })), [{
      name: "api",
      count: 2,
      source: "cwd"
    }]);
    assert.equal(command.cwdHints[0].cwd, projectPath);
  });
});
