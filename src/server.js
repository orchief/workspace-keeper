import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { formatBytes, makePlan } from "./classifier.js";
import { capabilityActualExecutionCommand, resolveExecutionCwd } from "./execution.js";
import { openGhosttyTab, shellQuote } from "./ghostty.js";
import { ghosttySentEventsFile, loadGhosttySentEvents } from "./ghostty-usage.js";
import { ensureDir, projectRoot, resolveDataFiles, writeDataFile } from "./paths.js";
import { buildRuntimeStatus, createRuntimeSnapshot } from "./runtime-status.js";
import { scanWorkspace } from "./scanner.js";

const jobs = new Map();

export function serve({ root, port = 4789, host = "127.0.0.1", dataDir }) {
  const files = resolveDataFiles(dataDir);
  ensureDir(files.dataDir);
  const runtimeSnapshot = createRuntimeSnapshot({
    root,
    dataDir: files.dataDir,
    mode: "serve"
  });

  if (!fs.existsSync(files.scanFile)) {
    const scan = scanWorkspace({ root, includeGenerated: true, logger: () => {} });
    const plan = makePlan(scan);
    writeDataFile(files.scanFile, `${JSON.stringify(scan, null, 2)}\n`);
    writeDataFile(files.planFile, `${JSON.stringify(plan, null, 2)}\n`);
  }

  const server = http.createServer((request, response) => {
    routeRequest(request, response, { root, files, runtimeSnapshot }).catch((error) => {
      sendJson(response, error.statusCode || 500, { error: error.message || String(error) });
    });
  });

  server.listen(port, host, () => {
    console.log(`Workspace Keeper: http://${host}:${port}`);
    console.log(`workspace root: ${root}`);
  });

  return server;
}

async function routeRequest(request, response, context) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/api/state") {
    return sendJson(response, 200, readState(context));
  }

  if (request.method === "POST" && url.pathname === "/api/scan") {
    const scan = scanWorkspace({ root: context.root, includeGenerated: true, logger: () => {} });
    const plan = makePlan(scan);
    writeDataFile(context.files.scanFile, `${JSON.stringify(scan, null, 2)}\n`);
    writeDataFile(context.files.planFile, `${JSON.stringify(plan, null, 2)}\n`);
    return sendJson(response, 200, { scan, plan, runtime: readRuntime(context, scan, plan) });
  }

  if (request.method === "GET" && url.pathname === "/api/summary") {
    const state = readState(context);
    return sendJson(response, 200, {
      ...state.plan.summary,
      totalSizeLabel: formatBytes(state.plan.summary.totalBytes),
      generatedSizeLabel: formatBytes(state.plan.summary.generatedBytes)
    });
  }

  if (request.method === "POST" && url.pathname === "/api/capabilities/run") {
    const body = await readJsonBody(request);
    const state = readState(context);
    const result = startCapabilityJob(state.plan, body);
    return sendJson(response, 202, result);
  }

  if (request.method === "POST" && url.pathname === "/api/remote-control/run") {
    const body = await readJsonBody(request);
    const state = readState(context);
    const result = startRemoteControlJob(state.plan, body);
    return sendJson(response, 202, result);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/capabilities/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/capabilities/jobs/".length));
    const job = jobs.get(jobId);
    if (!job) {
      return sendJson(response, 404, { error: "job not found" });
    }
    return sendJson(response, 200, job);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/remote-control/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/api/remote-control/jobs/".length));
    const job = jobs.get(jobId);
    if (!job) {
      return sendJson(response, 404, { error: "job not found" });
    }
    return sendJson(response, 200, job);
  }

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  return serveStatic(response, url.pathname);
}

function readState(context) {
  const files = context.files;
  const scan = JSON.parse(fs.readFileSync(files.scanFile, "utf8"));
  const plan = fs.existsSync(files.planFile)
    ? JSON.parse(fs.readFileSync(files.planFile, "utf8"))
    : makePlan(scan);
  return { scan, plan, runtime: readRuntime(context, scan, plan) };
}

function readRuntime(context, scan, plan) {
  return buildRuntimeStatus(context.runtimeSnapshot, {
    files: {
      ...context.files,
      sentEventsFile: ghosttySentEventsFile(context.files.dataDir)
    },
    scan,
    plan,
    sentEvents: loadGhosttySentEvents(context.files.dataDir)
  });
}

function startCapabilityJob(plan, body) {
  const projectName = String(body?.projectName || "");
  const capabilityId = String(body?.capabilityId || "");
  const project = plan.projects.find((item) => item.name === projectName);
  if (!project) {
    throw new HttpError(404, "project not found");
  }

  const capability = (project.capabilities || []).find((item) => item.id === capabilityId);
  if (!capability) {
    throw new HttpError(404, "capability not found");
  }

  if (!capability.runnable || !capability.execution) {
    throw new HttpError(400, "capability is not runnable");
  }

  const requiredConfirmation = confirmationToken(project, capability);
  if (capability.risk === "high" && body?.confirmation !== requiredConfirmation) {
    throw new HttpError(409, `high risk capability requires confirmation: ${requiredConfirmation}`);
  }

  const cwd = resolveExecutionCwd(project.path, capability.execution.cwd);
  const terminalCommand = capabilityActualExecutionCommand(capability);
  try {
    openGhosttyTab(cwd, terminalCommand);
  } catch (error) {
    throw new HttpError(500, error.message || String(error));
  }

  const job = createJob(project, capability, cwd, `cd ${shellQuote(cwd)} && ${terminalCommand}`);
  jobs.set(job.id, job);
  trimJobs();

  return {
    jobId: job.id,
    job,
    confirmationRequired: false
  };
}

function createJob(project, capability, cwd, terminalCommand) {
  const now = new Date().toISOString();
  return {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "opened",
    projectName: project.name,
    capabilityId: capability.id,
    capabilityName: capability.name,
    category: capability.category,
    risk: capability.risk,
    command: capability.command,
    execution: {
      cwd,
      command: capability.execution.command,
      args: capability.execution.args || []
    },
    terminalCommand,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    exitCode: null,
    signal: null,
    error: null,
    startedAt: now,
    finishedAt: now
  };
}

function startRemoteControlJob(plan, body) {
  const deviceId = String(body?.deviceId || "");
  const commandId = String(body?.commandId || "");
  const device = (plan.remoteControl?.devices || []).find((item) => item.id === deviceId);
  if (!device) {
    throw new HttpError(404, "remote device not found");
  }

  const command = (device.commands || []).find((item) => item.id === commandId);
  if (!command) {
    throw new HttpError(404, "remote command not found");
  }

  const fullSshCommand = String(command.fullSshCommand || command.command || "").trim();
  if (!command.runnable || !fullSshCommand) {
    throw new HttpError(400, "remote command is not runnable");
  }

  const requiredConfirmation = remoteConfirmationToken(device, command);
  if (body?.confirmation !== requiredConfirmation) {
    throw new HttpError(409, `remote command requires confirmation: ${requiredConfirmation}`);
  }

  const cwd = resolveRemoteExecutionCwd(command.execution?.cwd || plan.root || os.homedir());
  try {
    openGhosttyTab(cwd, fullSshCommand);
  } catch (error) {
    throw new HttpError(500, error.message || String(error));
  }

  const job = createRemoteJob(device, command, cwd, `cd ${shellQuote(cwd)} && ${fullSshCommand}`);
  jobs.set(job.id, job);
  trimJobs();

  return {
    jobId: job.id,
    job,
    confirmationRequired: false
  };
}

function createRemoteJob(device, command, cwd, terminalCommand) {
  const now = new Date().toISOString();
  return {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "opened",
    type: "remote-control",
    deviceId: device.id,
    deviceAlias: device.alias,
    deviceTarget: device.target,
    commandId: command.id,
    commandName: command.name,
    category: "remote",
    risk: command.risk || "high",
    command: command.fullSshCommand || command.command,
    remoteCommand: command.remoteCommand || "",
    execution: {
      cwd,
      command: "ssh",
      args: []
    },
    terminalCommand,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    exitCode: null,
    signal: null,
    error: null,
    startedAt: now,
    finishedAt: now
  };
}

function resolveRemoteExecutionCwd(cwd) {
  const fallback = os.homedir();
  const resolved = path.resolve(String(cwd || fallback));
  return fs.existsSync(resolved) ? resolved : fallback;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function confirmationToken(project, capability) {
  return `RUN ${project.name}/${capability.name}`;
}

function remoteConfirmationToken(device, command) {
  return `RUN REMOTE ${device.alias}/${command.name}`;
}

function trimJobs() {
  const entries = [...jobs.entries()];
  if (entries.length <= 50) {
    return;
  }

  entries
    .sort((a, b) => String(a[1].startedAt).localeCompare(String(b[1].startedAt)))
    .slice(0, entries.length - 50)
    .forEach(([id]) => jobs.delete(id));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        request.destroy();
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function serveStatic(response, pathname) {
  const webRoot = path.join(projectRoot, "web");
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(webRoot, requestedPath));

  if (!filePath.startsWith(webRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "Content-Type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
