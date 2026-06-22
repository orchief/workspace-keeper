import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cachedPlanCompatibilityIssue, loadPlan } from "../src/tui.js";

function withTempWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-plan-root-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-plan-data-"));
  try {
    return fn(root, dataDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("cached plan compatibility requires remote control and strong/weak history fields", () => {
  const root = os.tmpdir();

  assert.equal(cachedPlanCompatibilityIssue(null, { root }), "cached plan is not an object");
  assert.equal(cachedPlanCompatibilityIssue({ root, projects: [] }, { root }), "cached plan is missing remote control data");
  assert.equal(cachedPlanCompatibilityIssue({
    root,
    remoteControl: { devices: [] },
    projects: [{ name: "api" }]
  }, { root }), "cached plan is missing project history data");
  assert.equal(cachedPlanCompatibilityIssue({
    root,
    remoteControl: { devices: [] },
    projects: [{ name: "api", historyUsage: { runCount: 1 } }]
  }, { root }), "cached plan is missing strong/weak history data");
  assert.equal(cachedPlanCompatibilityIssue({
    root,
    remoteControl: { devices: [] },
    projects: [{ name: "api", historyUsage: { runCount: 1, signalRunCount: 0 } }]
  }, { root }), "");
  assert.equal(cachedPlanCompatibilityIssue({
    root,
    remoteControl: {
      devices: [{
        alias: "app",
        commands: [{
          runnable: true,
          command: "ssh app 'cd /srv/api && npm test'",
          fullSshCommand: "ssh app 'cd /srv/api && npm test'",
          execution: { cwd: root },
          localProjects: [{ name: "api", count: 1 }]
        }]
      }]
    },
    projects: [{ name: "api", historyUsage: { runCount: 1, signalRunCount: 0 } }]
  }, { root }), "cached remote control command is missing project source");
  assert.equal(cachedPlanCompatibilityIssue({
    root,
    remoteControl: {
      devices: [{
        alias: "app",
        commands: [{
          runnable: true,
          command: "ssh app uptime",
          fullSshCommand: "ssh app uptime",
          localProjects: [{ name: "api", source: "remote-command", count: 1 }]
        }]
      }]
    },
    projects: [{ name: "api", historyUsage: { runCount: 1, signalRunCount: 0 } }]
  }, { root }), "cached remote control command is missing execution cwd");
});

test("loadPlan refreshes incompatible cached plan instead of using it silently", () => {
  withTempWorkspace((root, dataDir) => {
    const projectPath = path.join(root, "api");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
      scripts: { test: "node --test" }
    }));

    const files = {
      dataDir,
      scanFile: path.join(dataDir, "latest-scan.json"),
      planFile: path.join(dataDir, "latest-plan.json")
    };
    fs.writeFileSync(files.planFile, `${JSON.stringify({
      schemaVersion: 1,
      root,
      projects: [{ name: "api", path: projectPath }],
      summary: { projectCount: 1 }
    }, null, 2)}\n`);

    const plan = loadPlan({ root, files, refresh: false });
    const persistedPlan = JSON.parse(fs.readFileSync(files.planFile, "utf8"));

    assert.equal(plan.cacheRefreshReason, "cached plan is missing remote control data");
    assert.equal(plan.projects[0].name, "api");
    assert.equal(Object.hasOwn(plan.projects[0], "historyUsage"), true);
    assert.equal(Object.hasOwn(plan.projects[0].historyUsage, "signalRunCount"), true);
    assert.equal(Array.isArray(plan.remoteControl.devices), true);
    assert.equal(Object.hasOwn(persistedPlan, "cacheRefreshReason"), false);
    assert.equal(Object.hasOwn(persistedPlan.projects[0].historyUsage, "signalRunCount"), true);
  });
});

test("loadPlan refreshes unreadable cached plan instead of crashing", () => {
  withTempWorkspace((root, dataDir) => {
    const projectPath = path.join(root, "api");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
      scripts: { test: "node --test" }
    }));

    const files = {
      dataDir,
      scanFile: path.join(dataDir, "latest-scan.json"),
      planFile: path.join(dataDir, "latest-plan.json")
    };
    fs.writeFileSync(files.planFile, "{not-json");

    const plan = loadPlan({ root, files, refresh: false });
    const persistedPlan = JSON.parse(fs.readFileSync(files.planFile, "utf8"));

    assert.equal(plan.cacheRefreshReason, "cached plan is unreadable");
    assert.equal(plan.projects[0].name, "api");
    assert.equal(Object.hasOwn(plan.projects[0].historyUsage, "signalRunCount"), true);
    assert.equal(Object.hasOwn(persistedPlan, "cacheRefreshReason"), false);
  });
});
