import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  capabilityActualExecutionCommand,
  resolveExecutionCwd
} from "../src/execution.js";

test("resolveExecutionCwd keeps execution inside the project", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-execution");

  assert.equal(resolveExecutionCwd(projectPath), projectPath);
  assert.equal(resolveExecutionCwd(projectPath, "packages/api"), path.join(projectPath, "packages/api"));
  assert.throws(() => resolveExecutionCwd(projectPath, ".."), /escapes project path/);
});

test("capabilityActualExecutionCommand uses structured execution command", () => {
  assert.equal(capabilityActualExecutionCommand({
    command: "cd packages/api && npm run dev",
    execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] }
  }), "npm run dev");
  assert.equal(capabilityActualExecutionCommand({
    command: "legacy",
    execution: { cwd: ".", command: "node", args: ["scripts/run task.js", "--name", "foo bar"] }
  }), "node 'scripts/run task.js' --name 'foo bar'");
  assert.equal(capabilityActualExecutionCommand({
    command: "legacy",
    execution: { cwd: ".", command: "shell", args: ["-lc", "cd tools && ./run.sh"] }
  }), "cd tools && ./run.sh");
});
