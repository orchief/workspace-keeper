const state = {
  scan: null,
  plan: null,
  runtime: null,
  view: "projects",
  filter: "all",
  query: "",
  selected: null,
  selectedRemoteDevice: null,
  jobs: {}
};

const labels = {
  all: "All",
  active: "Active",
  review: "Needs review",
  "archive-ready": "Archive ready",
  snapshot: "Snapshot",
  cleanup: "Cleanup"
};

const statusRank = {
  review: 0,
  active: 1,
  snapshot: 2,
  "archive-ready": 3,
  cleanup: 4
};

const riskRank = {
  high: 0,
  medium: 1,
  low: 2
};

const categoryLabels = {
  backup: "Backup",
  build: "Build",
  ci: "CI",
  clean: "Clean",
  db: "DB",
  deploy: "Deploy",
  dev: "Dev",
  diagnose: "Diagnose",
  docker: "Docker",
  format: "Format",
  lint: "Lint",
  migration: "Migration",
  package: "Package",
  release: "Release",
  seed: "Seed",
  serve: "Serve",
  setup: "Setup",
  sync: "Sync",
  test: "Test",
  unknown: "Unknown"
};

const nodes = {
  rootPath: document.querySelector("#rootPath"),
  lastScan: document.querySelector("#lastScan"),
  runtimeStatus: document.querySelector("#runtimeStatus"),
  dataFreshness: document.querySelector("#dataFreshness"),
  filters: document.querySelector("#filters"),
  metrics: document.querySelector("#metrics"),
  rows: document.querySelector("#projectRows"),
  inspector: document.querySelector("#inspector"),
  search: document.querySelector("#search"),
  rescan: document.querySelector("#rescan"),
  title: document.querySelector(".topbar h2"),
  eyebrow: document.querySelector(".topbar .eyebrow")
};

nodes.inspector.addEventListener("click", (event) => {
  const capabilityButton = event.target.closest("[data-run-capability]");
  if (capabilityButton) {
    runCapability(capabilityButton.dataset.runCapability);
    return;
  }

  const remoteButton = event.target.closest("[data-run-remote-command]");
  if (remoteButton) {
    runRemoteCommand(remoteButton.dataset.remoteDevice, remoteButton.dataset.runRemoteCommand);
  }
});

nodes.search.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

nodes.rescan.addEventListener("click", async () => {
  nodes.rescan.disabled = true;
  nodes.rescan.textContent = "Scanning...";
  try {
    const response = await fetch("/api/scan", { method: "POST" });
    const payload = await response.json();
    state.scan = payload.scan;
    state.plan = payload.plan;
    state.runtime = payload.runtime || null;
    state.selected = null;
    state.selectedRemoteDevice = null;
    state.jobs = {};
    render();
  } finally {
    nodes.rescan.disabled = false;
    nodes.rescan.textContent = "Rescan";
  }
});

await load();

async function load() {
  const response = await fetch("/api/state");
  const payload = await response.json();
  state.scan = payload.scan;
  state.plan = payload.plan;
  state.runtime = payload.runtime || null;
  render();
}

function render() {
  renderChrome();
  renderFilters();
  renderMetrics();
  renderRows();
  renderInspector();
}

function renderChrome() {
  nodes.rootPath.textContent = state.plan.root;
  nodes.lastScan.textContent = timestampAgeLabel(state.plan.scanGeneratedAt);
  nodes.runtimeStatus.textContent = runtimeHeaderLabel(state.runtime);
  nodes.dataFreshness.textContent = runtimeDataLabel(state.runtime);
  nodes.title.textContent = state.view === "remote" ? "Remote Control" : "Projects";
  nodes.eyebrow.textContent = runtimeWarningLabel(state.runtime) || (state.view === "remote" ? "SSH command control" : "Local archive control");
  nodes.search.placeholder = state.view === "remote" ? "Search devices or ssh commands" : "Search projects";
}

function renderFilters() {
  const counts = { all: state.plan.projects.length, ...state.plan.summary.buckets };
  const remoteControl = state.plan.remoteControl || {};
  const projectButtons = Object.keys(labels)
    .map((key) => {
      const active = state.view === "projects" && state.filter === key ? " active" : "";
      return `<button class="filter-button${active}" type="button" data-filter="${key}">
        <span>${labels[key]}</span>
        <span class="filter-count">${counts[key] || 0}</span>
      </button>`;
    })
    .join("");
  const remoteActive = state.view === "remote" ? " active" : "";
  const remoteButton = `<button class="filter-button${remoteActive}" type="button" data-view="remote">
    <span>Remote Control</span>
    <span class="filter-count">${remoteControl.commandCount || 0}</span>
  </button>`;
  nodes.filters.innerHTML = `${projectButtons}${remoteButton}`;

  nodes.filters.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view === "remote") {
        state.view = "remote";
        state.selectedRemoteDevice = state.selectedRemoteDevice || remoteDevices()[0]?.id || null;
      } else {
        state.view = "projects";
        state.filter = button.dataset.filter;
      }
      render();
    });
  });
}

function renderMetrics() {
  const summary = state.plan.summary;
  const metrics = [
    ["Projects", summary.projectCount],
    ["Capabilities", summary.capabilityCount || 0],
    ["History runs", planProjectHistoryRunCount(summary)],
    ["Remote", `${summary.remoteDeviceCount || 0}/${summary.remoteCommandCount || 0}`],
    ["High risk", summary.highRiskCapabilityCount || 0],
    ["Dirty git", summary.dirtyGit],
    ["Local config", summary.secretish],
    ["Total size", formatBytes(summary.totalBytes)],
    ["Generated", formatBytes(summary.generatedBytes)]
  ];

  nodes.metrics.innerHTML = metrics
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderRows() {
  if (state.view === "remote") {
    renderRemoteRows();
    return;
  }

  const projects = filteredProjects();
  nodes.rows.innerHTML = projects
    .map((project) => {
      const selected = state.selected === project.name ? " selected" : "";
      const capabilitySummary = project.capabilitySummary || {};
      const capabilityTotal = capabilitySummary.total || 0;
      const topCategory = capabilitySummary.topCategories?.[0];
      const capabilityLabel = capabilityTotal
        ? `${capabilityTotal} ${topCategory ? categoryLabel(topCategory.category) : "tasks"}`
        : "none";
      const historyRuns = projectHistoryRunCount(project);
      const capabilityRisk = capabilityRiskSummary(capabilitySummary);
      const gitLabel = project.isGit
        ? `${escapeHtml(project.git.branch || "git")} ${project.git.dirtyTotal ? `+${project.git.dirtyTotal}` : ""}`
        : "no git";
      const localRisk = [
        project.secretCount ? `${project.secretCount} local` : "",
        project.gitRepoCount > 1 ? `${project.gitRepoCount} repos` : "",
        project.archive.blockers.length ? `${project.archive.blockers.length} blockers` : ""
      ]
        .filter(Boolean)
        .join(" / ");

      return `<tr class="${selected}" data-project="${escapeAttr(project.name)}">
        <td>
          <div class="project-name">
            <strong>${escapeHtml(project.name)}</strong>
            <span>${escapeHtml(project.projectTypes.join(", ") || "untyped")}</span>
          </div>
        </td>
        <td><span class="badge ${project.archive.status}">${labels[project.archive.status]}</span></td>
        <td class="${capabilityTotal ? "" : "muted"}">${escapeHtml(historyRuns ? `${capabilityLabel} / ${historyRuns} runs` : capabilityLabel)}</td>
        <td><span class="risk-pill ${capabilityRisk.risk}">${escapeHtml(capabilityRisk.label)}</span></td>
        <td>${formatBytes(project.sizeBytes)}</td>
        <td>${formatBytes(project.generatedBytes)}</td>
        <td>${gitLabel}</td>
        <td class="${localRisk ? "" : "muted"}">${escapeHtml(localRisk || "clear")}</td>
        <td>${formatDate(project.modifiedAt)}</td>
      </tr>`;
    })
    .join("");

  nodes.rows.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selected = row.dataset.project;
      render();
    });
  });
}

function renderInspector() {
  if (state.view === "remote") {
    renderRemoteInspector();
    return;
  }

  const project = state.plan.projects.find((item) => item.name === state.selected);
  if (!project) {
    nodes.inspector.innerHTML = `<div class="empty-state">
      <h3>Select a project</h3>
      <p>Inspect blockers, generated folders, and discovered capabilities.</p>
    </div>`;
    return;
  }

  const capabilities = project.capabilities || [];
  const capabilitySummary = project.capabilitySummary || {};
  const blockers = project.archive.blockers.length
    ? project.archive.blockers
    : ["No blockers recorded"];
  const reasons = project.archive.reasons.length
    ? project.archive.reasons
    : ["No extra notes"];
  const capabilitySignals = riskNotes(capabilities);
  const generated = project.generatedDirs.slice(0, 8).map((item) => `${item.relativePath} - ${formatBytes(item.sizeBytes)}`);
  const statusPreview = project.git?.statusPreview?.length ? project.git.statusPreview : ["Clean or not a git repo"];
  const archiveCommand = `node ./bin/workspace-keeper.js archive --project ${shellToken(project.name)}`;

  nodes.inspector.innerHTML = `<div class="detail">
    <div>
      <h3>${escapeHtml(project.name)}</h3>
      <p class="muted">${escapeHtml(project.path)}</p>
    </div>

    <div><span class="badge ${project.archive.status}">${labels[project.archive.status]}</span></div>

    <div class="detail-section">
      <h4>Profile</h4>
      ${kv("Size", formatBytes(project.sizeBytes))}
      ${kv("Generated", formatBytes(project.generatedBytes))}
      ${kv("Modified", formatDate(project.modifiedAt))}
      ${kv("Types", project.projectTypes.join(", ") || "untyped")}
      ${kv("Capabilities", capabilityProfile(capabilitySummary))}
      ${kv("Git", project.isGit ? `${project.git.branch || "unknown"} / ${project.git.remote || "no remote"}` : "no git")}
    </div>

    <div class="detail-section">
      <h4>Blockers</h4>
      ${list(blockers)}
    </div>

    <div class="detail-section">
      <h4>Reasoning</h4>
      ${list(reasons)}
    </div>

    <div class="detail-section">
      <h4>Capabilities</h4>
      ${capabilityList(project, capabilities)}
    </div>

    <div class="detail-section">
      <h4>Capability risk</h4>
      ${list(capabilitySignals.length ? capabilitySignals : ["No capability risk signals recorded"])}
    </div>

    <div class="detail-section">
      <h4>Generated folders</h4>
      ${list(generated.length ? generated : ["No generated folders recorded"])}
    </div>

    <div class="detail-section">
      <h4>Git preview</h4>
      ${list(statusPreview)}
    </div>

    <div class="detail-section">
      <h4>Archive CLI</h4>
      <code class="command">${escapeHtml(archiveCommand)}</code>
    </div>
  </div>`;
}

function renderRemoteRows() {
  const devices = filteredRemoteDevices();
  const selectedDevice = selectedRemoteDevice(devices);
  nodes.rows.innerHTML = devices
    .map((device) => {
      const selected = selectedDevice?.id === device.id ? " selected" : "";
      const commandCount = device.commandCount || 0;
      const runCount = device.runCount || 0;
      const source = device.source?.type === "ssh-config" ? device.source.path : "history";
      const aliases = (device.aliases || []).filter((alias) => alias !== device.alias).join(", ");

      return `<tr class="${selected}" data-remote-device="${escapeAttr(device.id)}">
        <td>
          <div class="project-name">
            <strong>${escapeHtml(device.alias)}</strong>
            <span>${escapeHtml([device.target, aliases ? `aliases ${aliases}` : ""].filter(Boolean).join(" / "))}</span>
          </div>
        </td>
        <td><span class="badge active">Remote</span></td>
        <td class="${commandCount ? "" : "muted"}">${escapeHtml(commandCount ? `${commandCount} commands / ${runCount} runs` : "no history")}</td>
        <td><span class="risk-pill ${commandCount ? "high" : "medium"}">${escapeHtml(commandCount ? "ssh" : "login")}</span></td>
        <td class="muted">--</td>
        <td class="muted">--</td>
        <td>${escapeHtml(device.user ? `${device.user}@${device.hostName}` : device.hostName || device.alias)}</td>
        <td class="muted">${escapeHtml(source)}</td>
        <td>${device.lastRunAt ? formatDate(device.lastRunAt) : "--"}</td>
      </tr>`;
    })
    .join("");

  nodes.rows.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedRemoteDevice = row.dataset.remoteDevice;
      render();
    });
  });
}

function renderRemoteInspector() {
  const devices = filteredRemoteDevices();
  const device = selectedRemoteDevice(devices);
  if (!device) {
    const config = state.plan.remoteControl?.sshConfig;
    nodes.inspector.innerHTML = `<div class="empty-state">
      <h3>No remote devices</h3>
      <p>Remote Control reads ${escapeHtml(config?.path || "~/.ssh/config")} and shell history for ssh commands.</p>
    </div>`;
    return;
  }

  nodes.inspector.innerHTML = `<div class="detail">
    <div>
      <h3>${escapeHtml(device.alias)}</h3>
      <p class="muted">${escapeHtml(device.target || device.hostName || device.alias)}</p>
    </div>

    <div><span class="badge active">Remote Control</span></div>

    <div class="detail-section">
      <h4>Device</h4>
      ${kv("Host", device.hostName || device.alias)}
      ${kv("User", device.user || "default")}
      ${kv("Port", device.port || "22/default")}
      ${kv("Aliases", (device.aliases || []).join(", ") || device.alias)}
      ${kv("Source", sourceLabel(device.source))}
      ${device.config?.identityFile ? kv("Identity", device.config.identityFile) : ""}
      ${device.config?.proxyJump ? kv("ProxyJump", device.config.proxyJump) : ""}
    </div>

    <div class="detail-section">
      <h4>Commands</h4>
      ${remoteCommandList(device)}
    </div>
  </div>`;
}

function filteredProjects() {
  return [...state.plan.projects]
    .filter((project) => state.filter === "all" || project.archive.status === state.filter)
    .filter((project) => {
      if (!state.query) {
        return true;
      }
      return `${project.name} ${project.path} ${project.projectTypes.join(" ")} ${capabilitySearchText(project)}`
        .toLowerCase()
        .includes(state.query);
    })
    .sort((a, b) => {
      const historySequenceDelta = projectHistoryLastSequence(b) - projectHistoryLastSequence(a);
      if (historySequenceDelta !== 0) {
        return historySequenceDelta;
      }
      const historyDelta = projectHistoryRunCount(b) - projectHistoryRunCount(a);
      if (historyDelta !== 0) {
        return historyDelta;
      }
      const statusDelta = statusRank[a.archive.status] - statusRank[b.archive.status];
      if (statusDelta !== 0) {
        return statusDelta;
      }
      return b.sizeBytes - a.sizeBytes;
    });
}

function filteredRemoteDevices() {
  return remoteDevices()
    .filter((device) => {
      if (!state.query) {
        return true;
      }
      return remoteSearchText(device).toLowerCase().includes(state.query);
    })
    .sort((a, b) =>
      (b.runCount || 0) - (a.runCount || 0) ||
      (b.lastSequence || 0) - (a.lastSequence || 0) ||
      a.alias.localeCompare(b.alias)
    );
}

function remoteDevices() {
  return state.plan?.remoteControl?.devices || [];
}

function selectedRemoteDevice(devices = remoteDevices()) {
  const selected = devices.find((device) => device.id === state.selectedRemoteDevice) || devices[0] || null;
  if (selected && state.selectedRemoteDevice !== selected.id) {
    state.selectedRemoteDevice = selected.id;
  }
  return selected;
}

function remoteSearchText(device) {
  return [
    device.alias,
    ...(device.aliases || []),
    device.hostName,
    device.user,
    device.target,
    device.source?.path,
    ...(device.commands || []).flatMap((command) => [
      command.name,
      command.fullSshCommand,
      command.remoteCommand,
      ...(command.localProjects || []).map((project) => project.name)
    ])
  ].filter(Boolean).join(" ");
}

function kv(key, value) {
  return `<div class="kv"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`;
}

function list(items) {
  return `<ul class="list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

async function runCapability(capabilityId) {
  const project = state.plan.projects.find((item) => item.name === state.selected);
  const capability = project?.capabilities?.find((item) => item.id === capabilityId);
  if (!project || !capability || !capability.runnable || !capability.execution) {
    return;
  }

  let confirmation = "";
  if (capability.risk === "high") {
    const token = `RUN ${project.name}/${capability.name}`;
    confirmation = window.prompt(`High risk command. Type exactly: ${token}`) || "";
    if (confirmation !== token) {
      return;
    }
  }

    state.jobs[capabilityId] = {
      status: "starting",
      stdout: "",
      stderr: "",
    command: capability.command
  };
  renderInspector();

  try {
    const response = await fetch("/api/capabilities/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: project.name,
        capabilityId,
        confirmation
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Failed to start command");
    }
    state.jobs[capabilityId] = payload.job;
    renderInspector();
    pollJob(capabilityId, payload.jobId);
  } catch (error) {
    state.jobs[capabilityId] = {
      status: "error",
      error: error.message || String(error),
      stdout: "",
      stderr: "",
      command: capability.command
    };
    renderInspector();
  }
}

async function runRemoteCommand(deviceId, commandId) {
  const device = remoteDevices().find((item) => item.id === deviceId);
  const command = device?.commands?.find((item) => item.id === commandId);
  if (!device || !command || !command.runnable) {
    return;
  }

  const jobKey = remoteJobKey(command.id);
  const token = `RUN REMOTE ${device.alias}/${command.name}`;
  const confirmation = window.prompt(`Remote ssh command. Type exactly: ${token}`) || "";
  if (confirmation !== token) {
    return;
  }

  state.jobs[jobKey] = {
    status: "starting",
    stdout: "",
    stderr: "",
    command: command.fullSshCommand || command.command
  };
  renderInspector();

  try {
    const response = await fetch("/api/remote-control/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        commandId,
        confirmation
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Failed to start remote command");
    }
    state.jobs[jobKey] = payload.job;
    renderInspector();
    pollJob(jobKey, payload.jobId, "/api/remote-control/jobs/");
  } catch (error) {
    state.jobs[jobKey] = {
      status: "error",
      error: error.message || String(error),
      stdout: "",
      stderr: "",
      command: command.fullSshCommand || command.command
    };
    renderInspector();
  }
}

async function pollJob(jobKey, jobId, endpoint = "/api/capabilities/jobs/") {
  while (state.jobs[jobKey]?.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(`${endpoint}${encodeURIComponent(jobId)}`);
    const job = await response.json();
    state.jobs[jobKey] = job;
    renderInspector();
    if (!["running", "starting"].includes(job.status)) {
      return;
    }
  }
}

function capabilityList(project, capabilities) {
  if (!capabilities.length) {
    return `<p class="muted compact-copy">No capabilities discovered from scripts or manifests.</p>`;
  }

  const sortedCapabilities = [...capabilities]
    .sort((a, b) => capabilityUsageRank(b) - capabilityUsageRank(a) || sourceRank(a) - sourceRank(b) || riskRank[a.risk] - riskRank[b.risk] || (b.usage?.lastSequence || 0) - (a.usage?.lastSequence || 0) || b.confidence - a.confidence)
    .slice(0, 18);
  const moreCount = capabilities.length - sortedCapabilities.length;

  return `<div class="capability-list">${sortedCapabilities
    .map((capability) => `<div class="capability-item">
      <div class="capability-main">
        <div>
          <strong>${escapeHtml(capability.name)}</strong>
          <span>${escapeHtml(categoryLabel(capability.category))} / ${escapeHtml(capability.runtime || "unknown")} / ${escapeHtml(usageLabel(capability))} / ${escapeHtml(String(capability.confidence || 0))}%</span>
        </div>
        <div class="capability-actions">
          <span class="risk-pill ${capability.risk}">${escapeHtml(riskLabel(capability.risk))}</span>
          ${runButton(capability)}
        </div>
      </div>
      <code class="command small">${escapeHtml(capability.command)}</code>
      <div class="source-line">${escapeHtml(sourceLabel(capability.source))}</div>
      ${capability.usage?.runCount ? `<div class="source-line">${escapeHtml(historyUsageLine(capability.usage))}</div>` : ""}
      ${capability.reasons?.length ? `<div class="source-line">${escapeHtml(capability.reasons.slice(0, 2).join(" / "))}</div>` : ""}
      ${jobPanel(state.jobs[capability.id])}
    </div>`)
    .join("")}${moreCount > 0 ? `<p class="source-line">+ ${moreCount} more capabilities</p>` : ""}</div>`;
}

function remoteCommandList(device) {
  const commands = (device.commands || []).slice(0, 30);
  if (!commands.length) {
    return `<p class="muted compact-copy">No ssh command history for this device yet. A plain ssh login still appears after it is used.</p>`;
  }

  return `<div class="capability-list">${commands
    .map((command) => {
      const jobKey = remoteJobKey(command.id);
      const localProjects = (command.localProjects || []).map((item) => `${item.name} ${item.count}x`).join(", ");
      const cwd = command.cwdHints?.[0]?.path || "";
      return `<div class="capability-item">
        <div class="capability-main">
          <div>
            <strong>${escapeHtml(command.name)}</strong>
            <span>${escapeHtml(`${command.kind === "login" ? "login" : "remote command"} / ${command.count || 0} runs`)}</span>
          </div>
          <div class="capability-actions">
            <span class="risk-pill high">SSH</span>
            ${remoteRunButton(device, command)}
          </div>
        </div>
        ${command.remoteCommand ? `<code class="command small">${escapeHtml(command.remoteCommand)}</code>` : ""}
        <code class="command small">${escapeHtml(command.fullSshCommand || command.command)}</code>
        <div class="source-line">${escapeHtml(remoteUsageLine(command, cwd, localProjects))}</div>
        ${jobPanel(state.jobs[jobKey])}
      </div>`;
    })
    .join("")}</div>`;
}

function runButton(capability) {
  if (!capability.runnable || !capability.execution) {
    return `<button class="run-button" type="button" disabled>Not runnable</button>`;
  }
  const job = state.jobs[capability.id];
  const running = job && ["starting", "running"].includes(job.status);
  return `<button class="run-button ${capability.risk === "high" ? "danger" : ""}" type="button" data-run-capability="${escapeAttr(capability.id)}" ${running ? "disabled" : ""}>
    ${running ? "Running" : "Run"}
  </button>`;
}

function remoteRunButton(device, command) {
  const job = state.jobs[remoteJobKey(command.id)];
  const running = job && ["starting", "running"].includes(job.status);
  return `<button class="run-button danger" type="button" data-remote-device="${escapeAttr(device.id)}" data-run-remote-command="${escapeAttr(command.id)}" ${running ? "disabled" : ""}>
    ${running ? "Running" : "Run"}
  </button>`;
}

function jobPanel(job) {
  if (!job) {
    return "";
  }

  const output = [job.stdout, job.stderr, job.error].filter(Boolean).join("\n");
  const openedInTerminal = job.status === "opened";
  const summary = [
    openedInTerminal ? "opened in Ghostty tab" : `status: ${job.status}`,
    Number.isInteger(job.exitCode) ? `exit: ${job.exitCode}` : "",
    job.signal ? `signal: ${job.signal}` : "",
    job.outputTruncated ? "output truncated" : ""
  ].filter(Boolean).join(" / ");

  return `<div class="job-panel">
    <div class="source-line">${escapeHtml(summary)}</div>
    ${openedInTerminal && job.terminalCommand ? `<code class="command small">${escapeHtml(job.terminalCommand)}</code>` : ""}
    ${output ? `<pre>${escapeHtml(output.slice(-6000))}</pre>` : ""}
  </div>`;
}

function capabilityRiskSummary(summary = {}) {
  const high = summary.highRisk || summary.byRisk?.high || 0;
  const medium = summary.mediumRisk || summary.byRisk?.medium || 0;
  if (high) {
    return { risk: "high", label: `${high} high` };
  }
  if (medium) {
    return { risk: "medium", label: `${medium} med` };
  }
  if (summary.total) {
    return { risk: "low", label: "low" };
  }
  return { risk: "low muted-risk", label: "clear" };
}

function capabilityProfile(summary = {}) {
  const total = summary.total || 0;
  if (!total) {
    return "none";
  }
  const high = summary.highRisk || summary.byRisk?.high || 0;
  const medium = summary.mediumRisk || summary.byRisk?.medium || 0;
  const historyRuns = summary.historyRunCount || 0;
  const top = summary.topCategories?.map((item) => `${categoryLabel(item.category)} ${item.count}`).join(", ");
  return `${total} total / ${historyRuns} history runs / ${high} high / ${medium} medium${top ? ` / ${top}` : ""}`;
}

function planProjectHistoryRunCount(summary = {}) {
  return summary.projectHistoryRunCount ?? summary.historyRunCount ?? 0;
}

function projectHistoryRunCount(project = {}) {
  return project.historyUsage?.runCount ?? project.capabilitySummary?.historyRunCount ?? 0;
}

function projectHistoryLastSequence(project = {}) {
  return project.historyUsage?.lastSequence ?? -1;
}

function riskNotes(capabilities) {
  return unique(capabilities
    .filter((capability) => capability.risk !== "low")
    .flatMap((capability) => (capability.riskSignals || []).map((signal) => `${capability.name}: ${signal}`)))
    .slice(0, 10);
}

function capabilitySearchText(project) {
  return (project.capabilities || [])
    .map((capability) => [
      capability.name,
      capability.category,
      capability.runtime,
      capability.command,
      capability.source?.path,
      capability.usage?.originalCommand,
      capability.usage?.cwdPath
    ].filter(Boolean).join(" "))
    .join(" ");
}

function capabilityUsageRank(capability) {
  return capability.usage?.runCount || 0;
}

function sourceRank(capability) {
  if (capability.source?.type === "shell-history") return 0;
  if (capability.usage?.runCount) return 1;
  if (capability.source?.type === "package.json") return 2;
  return 3;
}

function usageLabel(capability) {
  return capability.usage?.runCount ? `${capability.usage.runCount} runs` : "not run";
}

function historyUsageLine(usage = {}) {
  const parts = [`history ${usage.runCount || 0} run${usage.runCount === 1 ? "" : "s"}`];
  if (usage.lastRunAt) {
    parts.push(`last ${formatDate(usage.lastRunAt)}`);
  }
  if (usage.cwd) {
    parts.push(`cwd ${usage.cwd}`);
  }
  return parts.join(" / ");
}

function remoteUsageLine(command, cwd, localProjects) {
  const parts = [`history ${command.count || 0} run${command.count === 1 ? "" : "s"}`];
  if (command.lastRunAt) {
    parts.push(`last ${formatDate(command.lastRunAt)}`);
  }
  if (localProjects) {
    parts.push(`local project ${localProjects}`);
  }
  if (cwd) {
    parts.push(`cwd ${cwd}`);
  }
  return parts.join(" / ");
}

function remoteJobKey(commandId) {
  return `remote:${commandId}`;
}

function categoryLabel(category) {
  return categoryLabels[category] || titleCase(category || "unknown");
}

function riskLabel(risk) {
  if (risk === "high") return "High";
  if (risk === "medium") return "Medium";
  return "Low";
}

function sourceLabel(source = {}) {
  const key = source.key ? `:${source.key}` : "";
  return `${source.type || "source"} ${source.path || "unknown"}${key}`;
}

function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "--";
  }
  return date.toLocaleString();
}

function runtimeHeaderLabel(runtime) {
  if (!runtime) {
    return "runtime unavailable";
  }
  const parts = [
    `PID ${runtime.pid || "?"}`,
    runtime.mode || "",
    runtime.packageVersion ? `pkg ${runtime.packageVersion}` : "",
    runtime.startedAt ? `started ${timestampAgeLabel(runtime.startedAt)}` : ""
  ].filter(Boolean);
  return parts.join(" / ");
}

function runtimeDataLabel(runtime) {
  if (!runtime) {
    return "plan unknown / scan unknown / sent none";
  }
  const data = runtime.data || {};
  const other = runtime.otherProcesses || {};
  const sent = data.sentEventCount && data.lastSentAt
    ? `${data.sentEventCount} sent / ${timestampAgeLabel(data.lastSentAt)}`
    : "sent none";
  return [
    `plan ${timestampAgeLabel(data.planGeneratedAt || data.planFileMtimeAt)}`,
    `scan ${timestampAgeLabel(data.scanGeneratedAt || data.scanFileMtimeAt)}`,
    sent,
    other.total ? `other tui:${other.tui || 0} serve:${other.serve || 0}` : "other none"
  ].join(" / ");
}

function runtimeWarningLabel(runtime) {
  return runtime?.isCodeStale ? "CODE UPDATED; restart serve to load latest" : "";
}

function timestampAgeLabel(value) {
  const stamp = shortTimestamp(value);
  if (stamp === "unknown") {
    return "unknown";
  }
  return `${stamp} (${ageLabel(value)})`;
}

function shortTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "unknown";
  }
  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function ageLabel(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return "unknown";
  }
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function shellToken(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
