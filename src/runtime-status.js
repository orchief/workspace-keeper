import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectRoot as defaultProjectRoot } from "./paths.js";

const CODE_STALE_GRACE_MS = 1000;
const SOURCE_DIRS = ["bin", "src", "web"];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css"]);
const PS_MONTHS = new Map([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11]
]);

export function createRuntimeSnapshot({
  root = "",
  dataDir = "",
  mode = "unknown",
  argv = process.argv,
  pid = process.pid,
  startedAt = new Date(),
  projectRoot = defaultProjectRoot
} = {}) {
  const packageVersion = readPackageVersion(projectRoot);
  const source = sourceFingerprint(projectRoot);
  return {
    pid,
    mode,
    root,
    dataDir,
    command: commandLabel(argv),
    startedAt: toIso(startedAt),
    projectRoot,
    packageVersion,
    startupCodeMtimeMs: source.maxMtimeMs,
    startupCodeMtimeAt: toIso(source.maxMtimeMs),
    sourceFileCount: source.fileCount
  };
}

export function buildRuntimeStatus(snapshot = {}, {
  now = new Date(),
  files = {},
  plan = null,
  scan = null,
  sentEvents = [],
  currentCodeMtimeMs,
  psOutput,
  includeProcesses = true
} = {}) {
  const nowMs = dateMs(now) || Date.now();
  const projectRoot = snapshot.projectRoot || defaultProjectRoot;
  const currentMtimeMs = Number.isFinite(currentCodeMtimeMs)
    ? currentCodeMtimeMs
    : sourceFingerprint(projectRoot).maxMtimeMs;
  const startupMtimeMs = Number(snapshot.startupCodeMtimeMs || 0);
  const processRows = includeProcesses
    ? (typeof psOutput === "string" ? parseWorkspaceKeeperProcesses(psOutput) : listWorkspaceKeeperProcesses())
    : [];

  return {
    pid: snapshot.pid || process.pid,
    mode: snapshot.mode || "unknown",
    root: snapshot.root || "",
    dataDir: snapshot.dataDir || "",
    command: snapshot.command || "",
    startedAt: snapshot.startedAt || null,
    uptimeSeconds: Math.max(0, Math.floor((nowMs - (dateMs(snapshot.startedAt) || nowMs)) / 1000)),
    packageVersion: snapshot.packageVersion || readPackageVersion(projectRoot),
    startupCodeMtimeAt: toIso(startupMtimeMs),
    currentCodeMtimeAt: toIso(currentMtimeMs),
    sourceFileCount: snapshot.sourceFileCount || 0,
    isCodeStale: Boolean(currentMtimeMs && startupMtimeMs && currentMtimeMs > startupMtimeMs + CODE_STALE_GRACE_MS),
    data: buildDataFreshness({ files, plan, scan, sentEvents, now }),
    otherProcesses: summarizeWorkspaceKeeperProcesses(processRows, {
      currentPid: snapshot.pid || process.pid,
      currentCodeMtimeMs: currentMtimeMs
    })
  };
}

export function buildDataFreshness({ files = {}, plan = null, scan = null, sentEvents = [], now = new Date() } = {}) {
  const planFileMtimeMs = statMtimeMs(files.planFile);
  const scanFileMtimeMs = statMtimeMs(files.scanFile);
  const sentEventsFileMtimeMs = statMtimeMs(files.sentEventsFile);
  const normalizedEvents = Array.isArray(sentEvents) ? sentEvents : [];
  const lastSentAt = normalizedEvents
    .map((event) => event?.sentAt)
    .filter((value) => Number.isFinite(dateMs(value)))
    .sort()
    .at(-1) || null;

  return {
    planGeneratedAt: plan?.generatedAt || null,
    scanGeneratedAt: plan?.scanGeneratedAt || scan?.generatedAt || null,
    planFileMtimeAt: toIso(planFileMtimeMs),
    scanFileMtimeAt: toIso(scanFileMtimeMs),
    sentEventsFileMtimeAt: toIso(sentEventsFileMtimeMs),
    sentEventCount: normalizedEvents.length,
    lastSentAt,
    labels: {
      plan: dataTimeLabel(plan?.generatedAt || planFileMtimeMs, now),
      scan: dataTimeLabel(plan?.scanGeneratedAt || scan?.generatedAt || scanFileMtimeMs, now),
      planFile: dataTimeLabel(planFileMtimeMs, now),
      scanFile: dataTimeLabel(scanFileMtimeMs, now),
      sent: sentEventsLabel({ count: normalizedEvents.length, lastSentAt, fileMtimeMs: sentEventsFileMtimeMs, now })
    }
  };
}

export function parseWorkspaceKeeperProcesses(output = "") {
  return String(output)
    .split(/\r?\n/)
    .map((line) => parseProcessLine(line))
    .filter(Boolean)
    .filter((processInfo) => processInfo.mode);
}

export function summarizeWorkspaceKeeperProcesses(processes = [], { currentPid = process.pid, currentCodeMtimeMs = 0 } = {}) {
  const current = Number(currentPid);
  const items = (processes || [])
    .filter((item) => Number(item.pid) !== current)
    .sort((a, b) => (a.startedAtMs || 0) - (b.startedAtMs || 0) || Number(a.pid) - Number(b.pid));
  const olderThanCode = Number.isFinite(currentCodeMtimeMs) && currentCodeMtimeMs > 0
    ? items.filter((item) => item.startedAtMs && currentCodeMtimeMs > item.startedAtMs + CODE_STALE_GRACE_MS).length
    : 0;
  const counts = {
    total: items.length,
    tui: items.filter((item) => item.mode === "tui").length,
    serve: items.filter((item) => item.mode === "serve").length,
    unknown: items.filter((item) => item.mode === "unknown").length,
    olderThanCode
  };
  return {
    ...counts,
    oldest: items[0] || null,
    items
  };
}

export function formatRuntimeHeader(status = {}, { now = new Date() } = {}) {
  const pid = status.pid || "?";
  const version = status.packageVersion ? `pkg ${status.packageVersion}` : "pkg ?";
  const started = timestampAgeLabel(status.startedAt, now);
  const code = status.currentCodeMtimeAt ? `code ${shortTimestamp(status.currentCodeMtimeAt)}` : "code unknown";
  return `PID ${pid} ${status.mode || "runtime"} started ${started} ${version} ${code}`;
}

export function formatRuntimeWarning(status = {}) {
  if (status.isCodeStale) {
    return "CODE UPDATED after this process started; restart TUI/serve to load latest.";
  }
  return "";
}

export function formatDataFreshness(status = {}, { now = new Date() } = {}) {
  const data = status.data || {};
  const labels = data.labels || {};
  const plan = labels.plan || dataTimeLabel(data.planGeneratedAt || data.planFileMtimeAt, now);
  const scan = labels.scan || dataTimeLabel(data.scanGeneratedAt || data.scanFileMtimeAt, now);
  const sent = labels.sent || sentEventsLabel({
    count: data.sentEventCount || 0,
    lastSentAt: data.lastSentAt,
    fileMtimeMs: dateMs(data.sentEventsFileMtimeAt),
    now
  });
  return `plan ${plan}  scan ${scan}  sent ${sent}  ${formatOtherProcessesLabel(status.otherProcesses)}`;
}

export function formatOtherProcessesLabel(summary = {}) {
  if (!summary?.total) {
    return "other none";
  }
  const parts = [`other tui:${summary.tui || 0}`, `serve:${summary.serve || 0}`];
  if (summary.olderThanCode) {
    parts.push(`older-code:${summary.olderThanCode}`);
  }
  if (summary.unknown) {
    parts.push(`unknown:${summary.unknown}`);
  }
  if (summary.oldest?.pid) {
    parts.push(`oldest ${summary.oldest.pid} ${shortTimestamp(summary.oldest.startedAt)}`);
  }
  return parts.join(" ");
}

export function timestampAgeLabel(value, now = new Date()) {
  const stamp = shortTimestamp(value);
  if (stamp === "unknown") {
    return "unknown";
  }
  return `${stamp} (${ageLabel(value, now)})`;
}

export function dataTimeLabel(value, now = new Date()) {
  if (!value) {
    return "unknown";
  }
  return timestampAgeLabel(value, now);
}

export function ageLabel(value, now = new Date()) {
  const time = dateMs(value);
  const nowTime = dateMs(now);
  if (!Number.isFinite(time) || !Number.isFinite(nowTime)) {
    return "unknown";
  }
  const deltaSeconds = Math.max(0, Math.floor((nowTime - time) / 1000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }
  return `${Math.floor(deltaHours / 24)}d ago`;
}

export function shortTimestamp(value) {
  const time = dateMs(value);
  if (!Number.isFinite(time)) {
    return "unknown";
  }
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

export function sourceFingerprint(root = defaultProjectRoot) {
  const files = collectSourceFiles(root);
  let maxMtimeMs = 0;
  for (const file of files) {
    maxMtimeMs = Math.max(maxMtimeMs, statMtimeMs(file) || 0);
  }
  return {
    maxMtimeMs,
    maxMtimeAt: toIso(maxMtimeMs),
    fileCount: files.length
  };
}

export function listWorkspaceKeeperProcesses() {
  if (process.platform === "win32") {
    return [];
  }
  try {
    const output = execFileSync("ps", ["-axo", "pid=,lstart=,command="], {
      encoding: "utf8",
      timeout: 1200,
      maxBuffer: 1024 * 1024
    });
    return parseWorkspaceKeeperProcesses(output);
  } catch {
    return [];
  }
}

function parseProcessLine(line = "") {
  const match = String(line).trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match) {
    return null;
  }

  const [, pidText, startedText, command] = match;
  const mode = workspaceKeeperMode(command);
  if (!mode) {
    return null;
  }

  const startedAtMs = parsePsLstart(startedText);
  return {
    pid: Number(pidText),
    mode,
    startedAt: toIso(startedAtMs),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
    command,
    port: processPort(command)
  };
}

function workspaceKeeperMode(command = "") {
  const value = String(command);
  if (value.includes("\\012") || value.includes("\\n")) {
    return "";
  }
  if (/(^|[\s/\\])workspace-keeper-ghostty-tui(?:$|\s)/.test(value)) {
    return "tui";
  }
  const launch = value.match(/(^|[\s/\\])workspace-keeper(?:\.js)?["']?\s+(tui|serve)\b/);
  return launch?.[2] || "";
}

function processPort(command = "") {
  const match = String(command).match(/(?:--port(?:=|\s+)|-p\s+)(\d+)/);
  return match ? Number(match[1]) : null;
}

function parsePsLstart(value = "") {
  const match = String(value).trim().match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!match) {
    return NaN;
  }

  const [, monthText, dayText, hourText, minuteText, secondText, yearText] = match;
  const month = PS_MONTHS.get(monthText);
  const year = Number(yearText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!Number.isInteger(month) || !validDateParts({ year, day, hour, minute, second })) {
    return NaN;
  }

  const date = new Date(year, month, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return NaN;
  }
  return date.getTime();
}

function validDateParts({ year, day, hour, minute, second }) {
  return (
    Number.isInteger(year) &&
    Number.isInteger(day) &&
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    Number.isInteger(second) &&
    year >= 1970 &&
    day >= 1 &&
    day <= 31 &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function sentEventsLabel({ count = 0, lastSentAt = null, fileMtimeMs = 0, now = new Date() } = {}) {
  if (count > 0 && lastSentAt) {
    return `${count}x last ${timestampAgeLabel(lastSentAt, now)}`;
  }
  if (fileMtimeMs) {
    return `none file ${timestampAgeLabel(fileMtimeMs, now)}`;
  }
  return "none";
}

function commandLabel(argv = []) {
  return (argv || []).map((item) => String(item)).join(" ").trim();
}

function readPackageVersion(root) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return String(json.version || "");
  } catch {
    return "";
  }
}

function collectSourceFiles(root) {
  const files = [];
  const packageFile = path.join(root, "package.json");
  if (isFile(packageFile)) {
    files.push(packageFile);
  }
  for (const dir of SOURCE_DIRS) {
    collectSourceDir(path.join(root, dir), files);
  }
  return files;
}

function collectSourceDir(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceDir(filePath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function statMtimeMs(filePath) {
  if (!filePath) {
    return 0;
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function toIso(value) {
  const time = dateMs(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

function dateMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}
