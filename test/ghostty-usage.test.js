import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ghosttySentEventsFile,
  loadGhosttySentEvents,
  recordGhosttyRequestEvent,
  summarizeGhosttySentEvents
} from "../src/ghostty-usage.js";

function withTempDataDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-keeper-usage-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("recordGhosttyRequestEvent records only complete sent events", () => {
  withTempDataDir((dataDir) => {
    const filePath = ghosttySentEventsFile(dataDir);

    assert.equal(recordGhosttyRequestEvent(dataDir, {
      status: "failed",
      cwd: dataDir,
      command: "npm test"
    }).recorded, false);
    assert.equal(fs.existsSync(filePath), false);

    assert.equal(recordGhosttyRequestEvent(dataDir, {
      status: "sent",
      cwd: dataDir
    }).recorded, false);
    assert.equal(fs.existsSync(filePath), false);

    assert.equal(recordGhosttyRequestEvent(dataDir, {
      status: "sent",
      command: "npm test"
    }).recorded, false);
    assert.equal(fs.existsSync(filePath), false);

    const result = recordGhosttyRequestEvent(dataDir, {
      status: "sent",
      cwd: dataDir,
      command: "npm test",
      sentAt: "2026-06-22T01:02:03.000Z"
    });

    assert.equal(result.recorded, true);
    assert.deepEqual(result.summary, {
      count: 1,
      lastSentAt: "2026-06-22T01:02:03.000Z"
    });
    assert.deepEqual(loadGhosttySentEvents(dataDir), [{
      status: "sent",
      sentAt: "2026-06-22T01:02:03.000Z",
      cwd: path.resolve(dataDir),
      command: "npm test"
    }]);
  });
});

test("summarizeGhosttySentEvents matches cwd and command exactly", () => {
  const baseCwd = path.join(os.tmpdir(), "workspace-keeper-project");
  const events = [
    {
      status: "sent",
      sentAt: "2026-06-22T01:00:00.000Z",
      cwd: baseCwd,
      command: "npm test"
    },
    {
      status: "sent",
      sentAt: "2026-06-22T02:00:00.000Z",
      cwd: `${baseCwd}-other`,
      command: "npm test"
    },
    {
      status: "sent",
      sentAt: "2026-06-22T03:00:00.000Z",
      cwd: baseCwd,
      command: "npm test -- --watch"
    },
    {
      status: "sent",
      sentAt: "2026-06-22T04:00:00.000Z",
      cwd: baseCwd,
      command: "npm test"
    }
  ];

  assert.deepEqual(summarizeGhosttySentEvents(events, {
    cwd: baseCwd,
    command: "npm test"
  }), {
    count: 2,
    lastSentAt: "2026-06-22T04:00:00.000Z"
  });
});

test("recordGhosttyRequestEvent keeps the latest 500 events", () => {
  withTempDataDir((dataDir) => {
    for (let index = 0; index < 505; index += 1) {
      recordGhosttyRequestEvent(dataDir, {
        status: "sent",
        cwd: dataDir,
        command: `command-${index}`,
        sentAt: new Date(Date.UTC(2026, 5, 22, 0, 0, index)).toISOString()
      });
    }

    const events = loadGhosttySentEvents(dataDir);
    assert.equal(events.length, 500);
    assert.equal(events[0].command, "command-5");
    assert.equal(events.at(-1).command, "command-504");
  });
});

test("ghostty sent events file is written with 0600 permissions", () => {
  withTempDataDir((dataDir) => {
    const filePath = ghosttySentEventsFile(dataDir);
    recordGhosttyRequestEvent(dataDir, {
      status: "sent",
      cwd: dataDir,
      command: "npm test",
      sentAt: "2026-06-22T01:02:03.000Z"
    });

    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });
});
