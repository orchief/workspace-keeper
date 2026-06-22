import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanProject } from "../src/scanner.js";

function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-risk-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scanPackageScripts(projectPath, scripts) {
  fs.writeFileSync(path.join(projectPath, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`);
  return scanProject(projectPath, { includeGenerated: false });
}

test("local capability risk detects destructive filesystem, container, data, and process commands", () => {
  withTempProject((projectPath) => {
    const project = scanPackageScripts(projectPath, {
      "clean:force": "rm -fr dist",
      "delete:generated": "find . -type f -delete",
      "docker:volumes": "docker volume prune -f",
      "redis:flush": "redis-cli flushall",
      "service:restart": "systemctl restart nginx",
      "pm2:delete": "pm2 delete api",
      "kill:hard": "kill -9 1234",
      "reset:hard": "git reset --hard && git clean -fd",
      "clean:x": "git clean -xdf",
      "restore:worktree": "git restore .",
      "checkout:worktree": "git checkout -- ."
    });
    const byName = new Map(project.capabilities.map((capability) => [capability.name, capability]));

    const expectations = [
      ["clean:force", "recursive file removal", "filesystem"],
      ["delete:generated", "find delete", "filesystem"],
      ["docker:volumes", "stops or removes containers/resources", "container"],
      ["redis:flush", "redis flush", "database"],
      ["service:restart", "process or service lifecycle change", "process"],
      ["pm2:delete", "process or service lifecycle change", "process"],
      ["kill:hard", "force kills processes", "process"],
      ["reset:hard", "destructive git working tree reset", "filesystem"],
      ["clean:x", "destructive git working tree reset", "filesystem"],
      ["restore:worktree", "destructive git working tree reset", "filesystem"],
      ["checkout:worktree", "destructive git working tree reset", "filesystem"]
    ];

    for (const [name, signal, sideEffect] of expectations) {
      const capability = byName.get(name);
      assert.equal(capability?.risk, "high", name);
      assert.equal(capability.riskSignals.includes(signal), true, `${name} signal`);
      assert.equal(capability.sideEffects.includes(sideEffect), true, `${name} side effect`);
    }
  });
});

test("local capability risk still keeps ordinary test commands low", () => {
  withTempProject((projectPath) => {
    const project = scanPackageScripts(projectPath, {
      test: "vitest run"
    });
    const capability = project.capabilities.find((item) => item.name === "test");

    assert.equal(capability?.risk, "low");
    assert.deepEqual(capability.sideEffects, []);
  });
});
