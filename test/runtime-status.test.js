import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRuntimeStatus,
  createRuntimeSnapshot,
  formatDataFreshness,
  formatOtherProcessesLabel,
  formatRuntimeHeader,
  formatRuntimeWarning,
  parseWorkspaceKeeperProcesses,
  sourceFingerprint,
  timestampAgeLabel
} from "../src/runtime-status.js";

test("runtime status detects source updates after process start", () => {
  const snapshot = {
    pid: 123,
    mode: "tui",
    root: "/workspaces",
    dataDir: "/data",
    startedAt: "2026-06-22T00:00:00.000Z",
    packageVersion: "0.1.0",
    startupCodeMtimeMs: Date.parse("2026-06-22T00:01:00.000Z"),
    projectRoot: "/missing"
  };

  const status = buildRuntimeStatus(snapshot, {
    now: "2026-06-22T01:00:00.000Z",
    currentCodeMtimeMs: Date.parse("2026-06-22T00:05:00.000Z"),
    includeProcesses: false
  });

  assert.equal(status.isCodeStale, true);
  assert.equal(status.uptimeSeconds, 3600);
  assert.match(formatRuntimeHeader(status, { now: "2026-06-22T01:00:00.000Z" }), /PID 123 tui started/);
  assert.match(formatRuntimeHeader(status, { now: "2026-06-22T01:00:00.000Z" }), /pkg 0\.1\.0/);
  assert.match(formatRuntimeWarning(status), /CODE UPDATED/);
});

test("runtime data freshness labels include plan, scan, sent, and other process state", () => {
  const snapshot = {
    pid: 123,
    mode: "serve",
    startedAt: "2026-06-22T01:00:00.000Z",
    packageVersion: "0.1.0",
    startupCodeMtimeMs: Date.parse("2026-06-22T01:00:00.000Z"),
    projectRoot: "/missing"
  };
  const psOutput = [
    "123 Mon Jun 22 09:00:00 2026 node ./bin/workspace-keeper.js serve --port 4789",
    "456 Mon Jun 22 08:00:00 2026 /opt/homebrew/bin/node ./bin/workspace-keeper.js tui --root /home/alice/workspaces",
    "789 Mon Jun 22 07:00:00 2026 /bin/sh -c workspace-keeper-ghostty-tui",
    "999 Mon Jun 22 07:00:00 2026 node other.js"
  ].join("\n");

  const status = buildRuntimeStatus(snapshot, {
    now: "2026-06-22T02:00:00.000Z",
    currentCodeMtimeMs: Date.parse("2026-06-22T23:00:00.000Z"),
    psOutput,
    plan: {
      generatedAt: "2026-06-22T01:50:00.000Z",
      scanGeneratedAt: "2026-06-22T01:40:00.000Z"
    },
    sentEvents: [
      { sentAt: "2026-06-22T01:55:00.000Z" },
      { sentAt: "2026-06-22T01:58:00.000Z" }
    ]
  });

  assert.equal(status.otherProcesses.total, 2);
  assert.equal(status.otherProcesses.tui, 2);
  assert.equal(status.otherProcesses.serve, 0);
  assert.equal(status.otherProcesses.olderThanCode, 2);
  assert.match(formatDataFreshness(status, { now: "2026-06-22T02:00:00.000Z" }), /plan 2026-06-22 01:50Z \(10m ago\)/);
  assert.match(formatDataFreshness(status, { now: "2026-06-22T02:00:00.000Z" }), /scan 2026-06-22 01:40Z \(20m ago\)/);
  assert.match(formatDataFreshness(status, { now: "2026-06-22T02:00:00.000Z" }), /sent 2x last 2026-06-22 01:58Z \(2m ago\)/);
  assert.match(formatOtherProcessesLabel(status.otherProcesses), /other tui:2 serve:0 older-code:2 oldest/);
});

test("ps parser recognizes workspace-keeper launch forms and ports", () => {
  const processes = parseWorkspaceKeeperProcesses([
    "38942 Mon Jun 22 02:27:54 2026 /opt/homebrew/bin/node ./bin/workspace-keeper.js tui --root /home/alice/workspaces --out /tmp/wk",
    "39191 Mon Jun 22 02:29:11 2026 node ./bin/workspace-keeper.js serve --port 4888",
    "39725 Mon Jun 22 02:30:00 2026 /bin/zsh /usr/local/bin/workspace-keeper-ghostty-tui",
    "48094 Mon Jun 22 02:31:00 2026 /bin/zsh -lc set -e\\012node ./bin/workspace-keeper.js serve --port 4899\\012curl http://127.0.0.1:4899/api/state",
    "1 Mon Jun 22 02:30:00 2026 /sbin/launchd"
  ].join("\n"));

  assert.deepEqual(processes.map((item) => [item.pid, item.mode, item.port]), [
    [38942, "tui", null],
    [39191, "serve", 4888],
    [39725, "tui", null]
  ]);
});

test("timestampAgeLabel renders absolute timestamp plus relative age", () => {
  assert.equal(
    timestampAgeLabel("2026-06-22T01:30:00.000Z", "2026-06-22T02:00:00.000Z"),
    "2026-06-22 01:30Z (30m ago)"
  );
  assert.equal(timestampAgeLabel("bad", "2026-06-22T02:00:00.000Z"), "unknown");
});

test("source fingerprint uses package and source files without git", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-runtime-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "bin"));
  const packageFile = path.join(root, "package.json");
  const sourceFile = path.join(root, "src", "main.js");
  fs.writeFileSync(packageFile, JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(sourceFile, "console.log('src');\n");
  fs.writeFileSync(path.join(root, "bin", "tool.txt"), "ignored\n");
  const packageTime = new Date("2026-06-22T00:30:00.000Z");
  const sourceTime = new Date("2026-06-22T01:00:00.000Z");
  fs.utimesSync(packageFile, packageTime, packageTime);
  fs.utimesSync(sourceFile, sourceTime, sourceTime);

  const snapshot = createRuntimeSnapshot({
    root: "/workspaces",
    dataDir: "/data",
    mode: "tui",
    pid: 321,
    argv: ["node", "wk", "tui"],
    startedAt: "2026-06-22T00:00:00.000Z",
    projectRoot: root
  });

  assert.equal(snapshot.packageVersion, "9.9.9");
  assert.equal(snapshot.sourceFileCount, 2);
  assert.equal(sourceFingerprint(root).fileCount, 2);
  assert.equal(snapshot.startupCodeMtimeAt, "2026-06-22T01:00:00.000Z");
  assert.equal(snapshot.command, "node wk tui");
});
