import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapperPath = path.join(projectRoot, "bin", "workspace-keeper-ghostty-tui");
const zshPath = "/bin/zsh";

function wrapperEnv(dataDir, extra = {}) {
  return {
    ...process.env,
    WORKSPACE_KEEPER_NODE_BIN: process.execPath,
    WORKSPACE_KEEPER_GHOSTTY_WRAPPER_DATA_DIR: dataDir,
    ...extra
  };
}

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-ghostty-wrapper-"));
}

function runWrapperCheck(dataDir, extraEnv = {}) {
  return runWrapperCheckWithArg(dataDir, "--workspace-keeper-wrapper-check", extraEnv);
}

function runWrapperCheckWithArg(dataDir, arg, extraEnv = {}) {
  return spawnSync(zshPath, [wrapperPath, arg], {
    cwd: projectRoot,
    env: wrapperEnv(dataDir, extraEnv),
    encoding: "utf8",
    timeout: 5000
  });
}

test("ghostty wrapper check mode validates entrypoint and releases lock", { skip: skipWrapperReason() }, () => {
  const dataDir = tempDataDir();
  const result = runWrapperCheck(dataDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(dataDir, "ghostty-tui.wrapper.lock")), false);

  const log = fs.readFileSync(path.join(dataDir, "ghostty-tui.log"), "utf8");
  assert.match(log, /event=wrapper_start/);
  assert.match(log, /event=cwd_ok/);
  assert.match(log, /event=node_ok/);
  assert.match(log, /event=tui_cli_ok/);
  assert.match(log, /event=check_mode_ok action=skip_tui/);
  assert.match(log, /event=lock_released/);
});

test("ghostty wrapper accepts public --check alias", { skip: skipWrapperReason() }, () => {
  const dataDir = tempDataDir();
  const result = runWrapperCheckWithArg(dataDir, "--check");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(readLog(dataDir), /event=check_mode_ok action=skip_tui/);
});

test("ghostty wrapper exits cleanly when a same-origin wrapper already holds the lock", { skip: skipWrapperReason(), timeout: 10000 }, async () => {
  const dataDir = tempDataDir();
  const first = spawn(zshPath, [wrapperPath, "--workspace-keeper-wrapper-check"], {
    cwd: projectRoot,
    env: wrapperEnv(dataDir, {
      WORKSPACE_KEEPER_GHOSTTY_WRAPPER_CHECK_HOLD_SECONDS: "2"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitFor(() => {
      const log = readLog(dataDir);
      return /event=lock_acquired/.test(log) && /event=check_mode_hold seconds=2/.test(log);
    });

    const second = runWrapperCheck(dataDir);
    assert.equal(second.status, 0, second.stderr || second.stdout);

    const [code] = await once(first, "exit");
    assert.equal(code, 0);

    const log = readLog(dataDir);
    assert.match(log, /event=lock_active_same_origin .* action=exit/);
    assert.match(log, /event=lock_released/);
  } finally {
    if (!first.killed) {
      first.kill("SIGTERM");
    }
  }
});

test("ghostty wrapper clears stale locks in check mode", { skip: skipWrapperReason() }, () => {
  const dataDir = tempDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "ghostty-tui.wrapper.lock"), [
    "version=1",
    "pid=99999999",
    "entry_id=stale-test",
    "created_at=2026-06-22T00:00:00Z"
  ].join("\n"));

  const result = runWrapperCheck(dataDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(dataDir, "ghostty-tui.wrapper.lock")), false);
  assert.match(readLog(dataDir), /event=lock_stale_cleared stale_pid=99999999/);
});

function readLog(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, "ghostty-tui.log"), "utf8");
  } catch {
    return "";
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for wrapper state");
}

function skipWrapperReason() {
  if (!fs.existsSync(zshPath)) {
    return "requires /bin/zsh";
  }
  if (!fs.existsSync(wrapperPath)) {
    return "requires Ghostty wrapper script";
  }
  return false;
}
