import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeDataFile } from "./paths.js";

const GHOSTTY_SENT_EVENTS_FILE = "ghostty-sent-events.json";
const MAX_GHOSTTY_SENT_EVENTS = 500;

export function ghosttySentEventsFile(dataDir) {
  return path.join(dataDir, GHOSTTY_SENT_EVENTS_FILE);
}

export function loadGhosttySentEvents(dataDir) {
  const filePath = ghosttySentEventsFile(dataDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  protectExistingFile(filePath);

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const events = Array.isArray(parsed) ? parsed : parsed.events;
    if (!Array.isArray(events)) {
      return [];
    }
    return events
      .map(normalizeSentEvent)
      .filter(Boolean)
      .slice(-MAX_GHOSTTY_SENT_EVENTS);
  } catch {
    return [];
  }
}

export function recordGhosttyRequestEvent(dataDir, event) {
  const events = loadGhosttySentEvents(dataDir);
  const key = normalizeUsageKey(event);
  if (event?.status !== "sent" || !key) {
    return {
      recorded: false,
      events,
      summary: summarizeGhosttySentEvents(events, event)
    };
  }

  const sentEvent = {
    status: "sent",
    sentAt: event.sentAt || new Date().toISOString(),
    cwd: key.cwd,
    command: key.command
  };
  const nextEvents = [...events, sentEvent].slice(-MAX_GHOSTTY_SENT_EVENTS);
  ensureDir(dataDir);
  writeDataFile(ghosttySentEventsFile(dataDir), `${JSON.stringify({
    version: 1,
    events: nextEvents
  }, null, 2)}\n`);

  return {
    recorded: true,
    events: nextEvents,
    summary: summarizeGhosttySentEvents(nextEvents, sentEvent)
  };
}

export function summarizeGhosttySentEvents(events, target) {
  const key = normalizeUsageKey(target);
  if (!key) {
    return { count: 0, lastSentAt: null };
  }

  let count = 0;
  let lastSentAt = null;
  for (const event of events || []) {
    const eventKey = normalizeUsageKey(event);
    if (!eventKey || eventKey.cwd !== key.cwd || eventKey.command !== key.command) {
      continue;
    }
    count += 1;
    if (!lastSentAt || String(event.sentAt || "") > lastSentAt) {
      lastSentAt = event.sentAt || null;
    }
  }

  return { count, lastSentAt };
}

function normalizeSentEvent(event) {
  if (event?.status !== "sent") {
    return null;
  }
  const key = normalizeUsageKey(event);
  if (!key || !event.sentAt || !Number.isFinite(Date.parse(event.sentAt))) {
    return null;
  }
  return {
    status: "sent",
    sentAt: new Date(event.sentAt).toISOString(),
    cwd: key.cwd,
    command: key.command
  };
}

function normalizeUsageKey(value = {}) {
  const command = String(value.command || "");
  const cwd = String(value.cwd || "");
  if (!command || !cwd) {
    return null;
  }
  return {
    cwd: path.resolve(cwd),
    command
  };
}

function protectExistingFile(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort: command-bearing event files should not remain world-readable.
  }
}
