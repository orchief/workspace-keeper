import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceKeeperTui } from "../src/tui.js";

function makeApp({ project, remoteDevice } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-tui-render-"));
  const projects = project ? [project] : [];
  const devices = remoteDevice ? [remoteDevice] : [];
  const plan = {
    generatedAt: "2026-06-22T00:00:00.000Z",
    scanGeneratedAt: "2026-06-22T00:00:00.000Z",
    root: os.tmpdir(),
    summary: {
      projectCount: projects.length,
      capabilityCount: projects.reduce((sum, item) => sum + (item.capabilities || []).length, 0),
      remoteDeviceCount: devices.length,
      remoteCommandCount: devices.reduce((sum, item) => sum + (item.commands || []).length, 0)
    },
    projects,
    remoteControl: { devices }
  };

  return new WorkspaceKeeperTui({
    root: os.tmpdir(),
    files: {
      dataDir,
      scanFile: path.join(dataDir, "latest-scan.json"),
      planFile: path.join(dataDir, "latest-plan.json")
    },
    plan
  });
}

test("capability row rendering uses selected project context without crashing", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-render-project");
  const project = {
    name: "api",
    path: projectPath,
    projectTypes: ["node"],
    archive: { status: "active" },
    capabilitySummary: { total: 1, highRisk: 0 },
    git: {},
    activity: {},
    capabilities: [{
      id: "dev",
      name: "dev",
      command: "cd packages/api && npm run dev",
      risk: "low",
      confidence: 90,
      runnable: true,
      source: { type: "package.json", path: "package.json", key: "dev" },
      usage: { runCount: 2, lastSequence: 9 },
      execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] },
      reasons: ["script command"],
      sideEffects: []
    }]
  };
  const app = makeApp({ project });

  const line = stripAnsi(app.renderCapabilityLine(0, 90, 6, 45));

  assert.match(line, /low dev: npm run dev/);
  assert.match(line, /src:manifest/);
  assert.match(line, /used:2x/);
  assert.match(line, /cwd:packages\/api/);
  assert.match(line, /\[Run\]/);
});

test("remote command row rendering and preview use selected device context", () => {
  const cwd = os.tmpdir();
  const remoteDevice = {
    id: "app",
    alias: "app",
    target: "app",
    hostName: "app.example.com",
    source: { type: "ssh-config", path: "~/.ssh/config" },
    commandCount: 1,
    runCount: 3,
    commands: [{
      id: "uptime",
      name: "uptime",
      kind: "history",
      command: "ssh app uptime",
      fullSshCommand: "ssh app uptime",
      sshTarget: "app",
      count: 3,
      lastSequence: 12,
      sources: ["~/.zsh_history"],
      localProjects: [
        { name: "api", source: "remote-command", count: 2 },
        { name: "launcher", source: "cwd", count: 1 }
      ],
      runnable: true,
      execution: { cwd }
    }]
  };
  const app = makeApp({ remoteDevice });
  app.mode = "remote";

  const line = stripAnsi(app.renderRemoteCommandLine(0, 90, 6, 45));

  assert.match(line, /ssh app > uptime: ssh app uptime/);
  assert.match(line, /history\/3x/);
  assert.match(line, /remote-project:api/);
  assert.match(line, /\[Run\]/);

  const inspector = app.renderRemoteInspectorRows(120).map(stripAnsi).join("\n");
  assert.match(inspector, /Command: ssh app uptime/);
  assert.match(inspector, /remote target:app/);
  assert.match(inspector, /local cwd:/);
  assert.match(inspector, /source:~\/\.zsh_history/);
  assert.match(inspector, /remote-project:api/);
  assert.match(inspector, /local-cwd-project:launcher/);

  assert.match(app.enterPreviewLabel(), /Enter: remote app target:app/);
  assert.match(app.enterPreviewLabel(), /target:app command:ssh app uptime/);
});

test("long remote command rows keep target context and run affordance", () => {
  const cwd = os.tmpdir();
  const remoteDevice = {
    id: "app",
    alias: "app",
    target: "app",
    commandCount: 1,
    commands: [{
      id: "deploy",
      name: "deploy",
      kind: "remote-command",
      command: "ssh app 'cd /srv/workspace/current && export RELEASE_SHA=0123456789abcdef0123456789abcdef0123456789abcdef && npm run migrate:status -- --tenant=critical-prod'",
      fullSshCommand: "ssh app 'cd /srv/workspace/current && export RELEASE_SHA=0123456789abcdef0123456789abcdef0123456789abcdef && npm run migrate:status -- --tenant=critical-prod'",
      sshTarget: "app",
      count: 1,
      runnable: true,
      execution: { cwd }
    }]
  };
  const app = makeApp({ remoteDevice });
  app.mode = "remote";

  const line = stripAnsi(app.renderRemoteCommandLine(0, 80, 6, 45)).trimEnd();

  assert.match(line, /app > deploy:/);
  assert.match(line, /\[Run\]$/);
});

test("typed local pending snapshot shows exact token, cwd, and command", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-render-manual");
  const app = makeApp();
  app.pendingHighRisk = {
    type: "manual",
    manual: {
      typeLabel: "Typed local command",
      target: "api",
      locationLabel: "cwd",
      location: projectPath,
      cwd: projectPath,
      command: "rm -rf dist"
    }
  };

  const snapshot = app.renderPendingSnapshot(100).map(stripAnsi).join("\n");

  assert.match(snapshot, /Type: Typed local command/);
  assert.match(snapshot, /cwd: .*workspace-keeper-render-manual/);
  assert.match(snapshot, /Command: rm -rf dist/);
  assert.match(snapshot, /Risk: high - recursive file removal/);
  assert.match(snapshot, /Required token: RUN LOCAL api/);
  assert.match(snapshot, /Confirm typed local command: exact token then Enter/);
});

test("pasted token does not execute until Enter submits it", () => {
  const app = makeApp();
  let confirmed = 0;
  app.render = () => {};
  app.confirmPendingExecution = () => {
    confirmed += 1;
  };
  app.pendingHighRisk = {
    type: "manual",
    manual: {
      target: "api",
      cwd: os.tmpdir(),
      command: "npm test"
    }
  };

  app.handlePendingConfirmationInput("RUN LOCAL api");

  assert.equal(confirmed, 0);
  assert.equal(app.pendingConfirmationInput, "RUN LOCAL api");

  app.handlePendingConfirmationInput("\r");

  assert.equal(confirmed, 1);
});

test("remote pending snapshot shows resolved execution cwd", () => {
  const missingCwd = path.join(os.tmpdir(), "workspace-keeper-missing-cwd", "gone");
  const app = makeApp();
  app.pendingHighRisk = {
    type: "remote",
    cwd: os.tmpdir(),
    device: {
      alias: "app",
      target: "app"
    },
    command: {
      name: "uptime",
      command: "ssh app uptime",
      fullSshCommand: "ssh app uptime",
      sshTarget: "app",
      runnable: true,
      sources: ["~/.zsh_history"],
      execution: { cwd: missingCwd }
    }
  };

  const snapshot = app.renderPendingSnapshot(120).map(stripAnsi).join("\n");

  assert.match(snapshot, new RegExp(`Local cwd: ${escapeRegExp(os.tmpdir())}`));
  assert.doesNotMatch(snapshot, new RegExp(escapeRegExp(missingCwd)));
});

test("runtimeStatus uses short cache and can be invalidated", () => {
  const app = makeApp();
  const cached = { pid: 123, mode: "cached" };
  app.runtimeStatusCache = { untilMs: Date.now() + 10_000, value: cached };

  assert.equal(app.runtimeStatus(), cached);

  app.runtimeStatusCache = { untilMs: 0, value: null };
  const fresh = app.runtimeStatus();

  assert.equal(fresh.mode, "tui");
  assert.equal(app.runtimeStatusCache.value, fresh);
  assert.equal(app.runtimeStatus(), fresh);
});

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
