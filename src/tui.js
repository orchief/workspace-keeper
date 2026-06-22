import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { makePlan } from "./classifier.js";
import {
  capabilityActualExecutionCommand as sharedCapabilityActualExecutionCommand,
  resolveExecutionCwd as sharedResolveExecutionCwd
} from "./execution.js";
import { openGhosttyTab, shellQuote } from "./ghostty.js";
import {
  ghosttySentEventsFile,
  loadGhosttySentEvents,
  recordGhosttyRequestEvent,
  summarizeGhosttySentEvents
} from "./ghostty-usage.js";
import { ensureDir, findDefaultWorkspaceRoot, projectRoot, resolveDataFiles, writeDataFile } from "./paths.js";
import { isSshCommand, parseSshCommand } from "./remote-control.js";
import {
  buildRuntimeStatus,
  createRuntimeSnapshot,
  formatDataFreshness,
  formatRuntimeHeader,
  formatRuntimeWarning,
  timestampAgeLabel
} from "./runtime-status.js";
import { scanWorkspace } from "./scanner.js";

const RESET = "\x1b[0m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ALT_SCREEN = "\x1b[?1049h";
const MAIN_SCREEN = "\x1b[?1049l";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const PROJECT_SCAN_STALE_DAYS = 7;
const PROJECT_LIVE_ACTIVITY_HOURS = 2;
const REFRESH_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const REFRESH_SPINNER_INTERVAL_MS = 120;
const REFRESH_STATUS_VISIBLE_MS = 5000;
const REFRESH_ERROR_VISIBLE_MS = 10000;
const MOUSE_WHEEL_STEP = 3;

const colors = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  inverse: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

export async function runTui(options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tui requires an interactive terminal");
  }

  const root = path.resolve(options.root || findDefaultWorkspaceRoot());
  const files = resolveDataFiles(options.out);
  const plan = loadPlan({ root, files, refresh: Boolean(options.refresh) });
  const app = new WorkspaceKeeperTui({ root, files, plan });
  return app.start();
}

export class WorkspaceKeeperTui {
  constructor({ root, files, plan }) {
    this.root = root;
    this.files = files;
    this.plan = plan;
    this.input = "";
    this.inputFocused = false;
    this.selectedProjectIndex = Math.max(0, this.projects.findIndex((project) => project.capabilitySummary?.total));
    this.selectedCapabilityIndex = 0;
    this.selectedRemoteDeviceIndex = Math.max(0, this.remoteDevices.findIndex((device) => device.commandCount));
    this.selectedRemoteCommandIndex = 0;
    this.projectScroll = 0;
    this.capabilityScroll = 0;
    this.remoteDeviceScroll = 0;
    this.remoteCommandScroll = 0;
    this.focus = "capabilities";
    this.mode = "projects";
    this.status = plan.cacheRefreshReason
      ? `Cached plan refreshed: ${plan.cacheRefreshReason}.`
      : "Input is filter-only. Type text to narrow lists; Ctrl+X turns non-empty text into a pending execution snapshot.";
    this.pendingHighRisk = null;
    this.pendingConfirmationInput = "";
    this.hitboxes = [];
    this.disposed = false;
    this.refreshing = false;
    this.refreshStartedAt = 0;
    this.refreshFrame = 0;
    this.refreshTimer = null;
    this.refreshProcess = null;
    this.statusPriorityUntilMs = 0;
    this.ghosttySentEvents = loadGhosttySentEvents(this.files.dataDir);
    this.runtimeStatusCache = { untilMs: 0, value: null };
    this.runtimeSnapshot = createRuntimeSnapshot({
      root: this.root,
      dataDir: this.files.dataDir,
      mode: "tui"
    });
  }

  get projects() {
    const query = this.searchQuery;
    return [...this.plan.projects]
      .filter((project) => matchesQuery(projectSearchText(project), query))
      .sort(compareProjectsByActivity);
  }

  get selectedProject() {
    return this.projects[this.selectedProjectIndex] || this.projects[0] || null;
  }

  get capabilities() {
    const query = this.searchQuery;
    const selectedProject = this.selectedProject;
    const projectMatches = selectedProject ? matchesQuery(projectOwnSearchText(selectedProject), query) : false;
    return [...(this.selectedProject?.capabilities || [])]
      .filter((capability) => !query || projectMatches || matchesQuery(capabilitySearchText(capability), query))
      .sort((a, b) => compareCapabilitiesByTuiOrder(a, b, {
        project: selectedProject,
        ghosttySentEvents: this.ghosttySentEvents
      }));
  }

  get remoteDevices() {
    const query = this.searchQuery;
    return [...(this.plan.remoteControl?.devices || [])]
      .filter((device) => matchesQuery(remoteDeviceSearchText(device), query))
      .sort(compareRemoteDevices);
  }

  get selectedRemoteDevice() {
    return this.remoteDevices[this.selectedRemoteDeviceIndex] || this.remoteDevices[0] || null;
  }

  get remoteCommands() {
    const query = this.searchQuery;
    const selectedDevice = this.selectedRemoteDevice;
    const deviceMatches = selectedDevice ? matchesQuery(remoteDeviceOwnSearchText(selectedDevice), query) : false;
    return [...(this.selectedRemoteDevice?.commands || [])]
      .filter((command) => !query || deviceMatches || matchesQuery(remoteCommandSearchText(command), query))
      .sort((a, b) => compareRemoteCommandsByTuiOrder(a, b, {
        root: this.root,
        ghosttySentEvents: this.ghosttySentEvents
      }));
  }

  get searchQuery() {
    return normalizeSearch(this.input);
  }

  runtimeStatus() {
    const nowMs = Date.now();
    if (this.runtimeStatusCache?.value && nowMs < this.runtimeStatusCache.untilMs) {
      return this.runtimeStatusCache.value;
    }
    const status = buildRuntimeStatus(this.runtimeSnapshot, {
      files: {
        ...this.files,
        sentEventsFile: ghosttySentEventsFile(this.files.dataDir)
      },
      plan: this.plan,
      sentEvents: this.ghosttySentEvents
    });
    this.runtimeStatusCache = { untilMs: nowMs + 2000, value: status };
    return status;
  }

  async start() {
    this.setupTerminal();
    this.render();
    await new Promise((resolve) => {
      this.resolve = resolve;
      process.stdin.on("data", this.onInput);
      process.stdout.on("resize", this.render);
    });
  }

  setupTerminal() {
    this.originalRawMode = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE}`);
    process.on("SIGINT", this.dispose);
    process.on("SIGTERM", this.dispose);
  }

  dispose = () => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopRefreshAnimation();
    if (this.refreshProcess && !this.refreshProcess.killed) {
      this.refreshProcess.kill();
    }
    this.refreshProcess = null;
    process.stdin.off("data", this.onInput);
    process.stdout.off("resize", this.render);
    process.off("SIGINT", this.dispose);
    process.off("SIGTERM", this.dispose);
    process.stdin.setRawMode(Boolean(this.originalRawMode));
    process.stdin.pause();
    process.stdout.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${MAIN_SCREEN}${RESET}`);
    this.resolve?.();
  };

  onInput = (chunk) => {
    const text = chunk.toString("utf8");
    const mouse = parseMouse(text);
    if (mouse) {
      this.handleMouse(mouse);
      return;
    }
    if (text === "\u0003") {
      this.dispose();
      return;
    }

    if (this.pendingHighRisk) {
      this.handlePendingConfirmationInput(text);
      return;
    }

    if (!text.startsWith("\x1b") && Array.from(text).length > 1) {
      for (const char of Array.from(text)) {
        this.onInput(Buffer.from(char));
      }
      return;
    }

    if (!this.inputFocused && text === "q") {
      this.dispose();
      return;
    }
    if (this.refreshing) {
      this.status = this.refreshStatusLabel(text === "r" || text === "R" ? "already running" : "scanning");
      this.render();
      return;
    }
    if (!this.inputFocused && text.startsWith("/") && isPrintableInput(text)) {
      this.inputFocused = true;
      this.input += text.slice(1);
      this.resetFilteredSelection();
      this.status = this.inputStatus();
      this.render();
      return;
    }
    if (text === "\x1b") {
      if (this.input || this.inputFocused) {
        this.input = "";
        this.inputFocused = false;
        this.resetFilteredSelection();
        this.status = "Input cleared. Empty input is filter mode and leaves lists unfiltered.";
        this.render();
      }
      return;
    }
    if (text === "\u0018") {
      this.executeInputCommand();
      return;
    }
    if (text === "\u0015") {
      this.input = "";
      this.resetFilteredSelection();
      this.status = "Input cleared. Empty input is filter mode and leaves lists unfiltered.";
      this.render();
      return;
    }
    if ((text === "\x7f" || text === "\b") && this.inputFocused) {
      this.input = Array.from(this.input).slice(0, -1).join("");
      this.resetFilteredSelection();
      this.status = this.inputStatus();
      this.render();
      return;
    }
    if (!this.inputFocused && isPrintableInput(text) && !isReservedShortcut(text)) {
      this.inputFocused = true;
      this.input += text;
      this.resetFilteredSelection();
      this.status = this.inputStatus();
      this.render();
      return;
    }
    if (text === "\t") {
      this.focus = this.focus === "projects" ? "capabilities" : "projects";
      this.status = `Focus: ${focusLabel(this.mode, this.focus)}`;
      this.render();
      return;
    }
    if (!this.inputFocused && (text === "r" || text === "R")) {
      this.refresh();
      return;
    }
    if (!this.inputFocused && text === "g") {
      this.mode = this.mode === "projects" ? "remote" : "projects";
      this.pendingHighRisk = null;
      this.status = this.mode === "remote" ? "Remote Control: devices on the left, ssh commands on the right." : "Projects: local project capabilities.";
      this.render();
      return;
    }
    if (text === "\r" || text === "\n") {
      if (this.inputFocused || this.input.trim()) {
        this.inputFocused = false;
        this.status = this.input.trim()
          ? `Filter applied. Ctrl+X opens a pending execution snapshot; Esc clears "${shortDisplayValue(this.input.trim(), 64)}".`
          : "Input filter submitted. Empty input leaves lists unfiltered.";
        this.render();
        return;
      }
      this.runSelected();
      return;
    }
    if ((!this.inputFocused && text === "j") || text === "\x1b[B") {
      this.move(1);
      return;
    }
    if ((!this.inputFocused && text === "k") || text === "\x1b[A") {
      this.move(-1);
      return;
    }
    if (text === "\x1b[C") {
      this.focus = "capabilities";
      this.render();
      return;
    }
    if (text === "\x1b[D") {
      this.focus = "projects";
      this.render();
      return;
    }
    if (this.inputFocused && isPrintableInput(text)) {
      this.input += text;
      this.resetFilteredSelection();
      this.status = this.inputStatus();
      this.render();
    }
  };

  handlePendingConfirmationInput(text) {
    const pending = this.pendingHighRisk;
    const requirement = pendingConfirmationRequirement(pending);
    if (requirement.type === "token") {
      if (text === "\x1b" || ((text === "n" || text === "N") && !this.pendingConfirmationInput)) {
        this.cancelPendingExecution();
        return;
      }
      if ((text === "y" || text === "Y") && !this.pendingConfirmationInput) {
        this.status = pendingLockedStatus(requirement);
        this.render();
        return;
      }
      if (text === "\r" || text === "\n") {
        const bufferedAction = parsePendingConfirmationInput(this.pendingConfirmationInput.trim(), requirement);
        if (bufferedAction === "confirm") {
          this.confirmPendingExecution();
          return;
        }
        this.pendingConfirmationInput = "";
        this.status = `Token mismatch. Type exact token to execute in a new Ghostty tab: ${requirement.token}`;
        this.render();
        return;
      }
      if (text === "\x7f" || text === "\b") {
        this.pendingConfirmationInput = Array.from(this.pendingConfirmationInput).slice(0, -1).join("");
        this.status = pendingTokenEntryStatus(requirement, this.pendingConfirmationInput);
        this.render();
        return;
      }
      if (isPrintableInput(text)) {
        this.pendingConfirmationInput += text;
        this.status = pendingTokenEntryStatus(requirement, this.pendingConfirmationInput);
        this.render();
        return;
      }
      this.status = pendingLockedStatus(requirement);
      this.render();
      return;
    }

    const action = parsePendingConfirmationInput(text, requirement);
    if (action === "confirm") {
      this.confirmPendingExecution();
      return;
    }
    if (action === "cancel") {
      this.cancelPendingExecution();
      return;
    }

    this.status = pendingLockedStatus(requirement);
    this.render();
  }

  confirmPendingExecution() {
    const pending = this.pendingHighRisk;
    this.pendingHighRisk = null;
    this.pendingConfirmationInput = "";
    if (pending.type === "remote") {
      void this.executeRemoteCommand(pending.command, { confirmed: true, device: pending.device });
    } else if (pending.type === "manual") {
      void this.executeManualCommand(pending.manual, { confirmed: true });
    } else {
      void this.executeCapability(pending.capability, { confirmed: true });
    }
  }

  cancelPendingExecution() {
    const pending = this.pendingHighRisk;
    this.pendingHighRisk = null;
    this.pendingConfirmationInput = "";
    this.restoreUiSnapshot(pending.uiSnapshot);
    this.status = "Cancelled command. Context restored; Enter/Ctrl+X now follows main-screen selection/input.";
    this.render();
  }

  move(delta) {
    if (this.mode === "remote") {
      if (this.focus === "projects") {
        this.selectedRemoteDeviceIndex = clamp(this.selectedRemoteDeviceIndex + delta, 0, this.remoteDevices.length - 1);
        this.selectedRemoteCommandIndex = 0;
        this.remoteCommandScroll = 0;
        this.keepRemoteDeviceVisible();
      } else {
        this.selectedRemoteCommandIndex = clamp(this.selectedRemoteCommandIndex + delta, 0, Math.max(0, this.remoteCommands.length - 1));
        this.keepRemoteCommandVisible();
      }
      this.pendingHighRisk = null;
      this.render();
      return;
    }

    if (this.focus === "projects") {
      this.selectedProjectIndex = clamp(this.selectedProjectIndex + delta, 0, this.projects.length - 1);
      this.selectedCapabilityIndex = 0;
      this.capabilityScroll = 0;
      this.keepProjectVisible();
    } else {
      this.selectedCapabilityIndex = clamp(this.selectedCapabilityIndex + delta, 0, Math.max(0, this.capabilities.length - 1));
      this.keepCapabilityVisible();
    }
    this.pendingHighRisk = null;
    this.render();
  }

  handleMouse(mouse) {
    if (this.refreshing) {
      this.status = this.refreshStatusLabel("scanning");
      this.render();
      return;
    }
    if (!mouse.down) {
      if (mouse.scroll) {
        this.handleMouseWheel(mouse);
      }
      return;
    }
    if (this.pendingHighRisk) {
      this.status = `Pending command is locked. ${pendingLockedStatus(pendingConfirmationRequirement(this.pendingHighRisk))}`;
      this.render();
      return;
    }
    const hit = this.hitboxes.findLast((item) => mouse.x >= item.x1 && mouse.x <= item.x2 && mouse.y >= item.y1 && mouse.y <= item.y2);
    if (!hit) {
      return;
    }
    if (hit.type === "project") {
      this.selectedProjectIndex = hit.index;
      this.selectedCapabilityIndex = 0;
      this.focus = "capabilities";
      this.pendingHighRisk = null;
      this.render();
      return;
    }
    if (hit.type === "capability") {
      this.selectedCapabilityIndex = hit.index;
      this.focus = "capabilities";
      this.render();
      return;
    }
    if (hit.type === "run") {
      this.selectedCapabilityIndex = hit.index;
      this.focus = "capabilities";
      void this.executeCapability(hit.capability);
      return;
    }
    if (hit.type === "remote-device") {
      this.selectedRemoteDeviceIndex = hit.index;
      this.selectedRemoteCommandIndex = 0;
      this.focus = "projects";
      this.pendingHighRisk = null;
      this.render();
      return;
    }
    if (hit.type === "remote-command") {
      this.selectedRemoteCommandIndex = hit.index;
      this.focus = "capabilities";
      this.render();
      return;
    }
    if (hit.type === "remote-run") {
      this.selectedRemoteCommandIndex = hit.index;
      this.focus = "capabilities";
      void this.executeRemoteCommand(hit.command);
    }
  }

  handleMouseWheel(mouse) {
    if (this.pendingHighRisk) {
      this.status = `Pending command is locked. ${pendingLockedStatus(pendingConfirmationRequirement(this.pendingHighRisk))}`;
      this.render();
      return;
    }

    const targetFocus = this.mouseFocusTarget(mouse);
    const delta = mouse.scroll * MOUSE_WHEEL_STEP;
    this.focus = targetFocus;
    if (this.mode === "remote") {
      if (targetFocus === "projects") {
        this.selectedRemoteDeviceIndex = clamp(this.selectedRemoteDeviceIndex + delta, 0, Math.max(0, this.remoteDevices.length - 1));
        this.selectedRemoteCommandIndex = 0;
        this.remoteCommandScroll = 0;
        this.keepRemoteDeviceVisible();
      } else {
        this.selectedRemoteCommandIndex = clamp(this.selectedRemoteCommandIndex + delta, 0, Math.max(0, this.remoteCommands.length - 1));
        this.keepRemoteCommandVisible();
      }
      this.render();
      return;
    }

    if (targetFocus === "projects") {
      this.selectedProjectIndex = clamp(this.selectedProjectIndex + delta, 0, Math.max(0, this.projects.length - 1));
      this.selectedCapabilityIndex = 0;
      this.capabilityScroll = 0;
      this.keepProjectVisible();
    } else {
      this.selectedCapabilityIndex = clamp(this.selectedCapabilityIndex + delta, 0, Math.max(0, this.capabilities.length - 1));
      this.keepCapabilityVisible();
    }
    this.render();
  }

  mouseFocusTarget(mouse) {
    const layout = this.layout || {};
    if (mouse.x <= (layout.leftWidth || 42)) {
      return "projects";
    }
    if (layout.rightStart && mouse.x >= layout.rightStart) {
      return "capabilities";
    }
    return this.focus;
  }

  runSelected() {
    if (this.mode === "remote") {
      this.runSelectedRemoteCommand();
      return;
    }

    const capability = this.capabilities[this.selectedCapabilityIndex];
    if (!capability) {
      this.status = "No capability selected.";
      this.render();
      return;
    }
    void this.executeCapability(capability);
  }

  runSelectedRemoteCommand() {
    if (this.focus !== "capabilities") {
      this.status = "Remote device selected. Switch to the command list with Tab/Right, or click a command [Run] button.";
      this.render();
      return;
    }

    const command = this.remoteCommands[this.selectedRemoteCommandIndex];
    if (!command) {
      this.status = "No remote command selected.";
      this.render();
      return;
    }
    void this.executeRemoteCommand(command);
  }

  executeInputCommand() {
    const typedCommand = this.input.trim();
    if (!typedCommand) {
      this.status = "Input is empty filter/search text. Type text first; Ctrl+X prepares non-empty input for confirmation.";
      this.render();
      return;
    }

    if (this.mode === "remote") {
      const device = this.selectedRemoteDevice;
      const remoteCwd = resolveRemoteExecutionCwd(this.remoteCommands[this.selectedRemoteCommandIndex]?.execution?.cwd || this.root);
      const typedRemote = buildTypedRemoteCommand(typedCommand, device, {
        cwd: remoteCwd,
        devices: this.remoteDevices
      });
      if (!typedRemote) {
        this.status = "Remote Ctrl+X requires a complete ssh ... command; plain text is not wrapped for the selected device.";
        this.render();
        return;
      }
      void this.executeRemoteCommand(typedRemote.command, { device: typedRemote.device });
      return;
    }

    const project = this.selectedProject;
    const cwd = project?.path || this.root;
    const command = typedCommand;
    const label = project ? `${project.name}: ${typedCommand}` : typedCommand;
    const locationLabel = "cwd";
    const location = cwd;
    const target = project?.name || "workspace";
    const typeLabel = "Typed local command";
    void this.executeManualCommand({ command, cwd, label, locationLabel, location, target, typeLabel });
  }

  async executeManualCommand(manual, { confirmed = false } = {}) {
    if (!manual?.command || !manual?.cwd) {
      this.status = "Manual command is not runnable.";
      this.render();
      return;
    }
    if (confirmationGateAction({ type: "manual", confirmed }) === "pending") {
      this.pendingConfirmationInput = "";
      this.pendingHighRisk = {
        type: "manual",
        manual,
        uiSnapshot: this.captureUiSnapshot()
      };
      const requirement = pendingConfirmationRequirement(this.pendingHighRisk);
      this.status = `Review the pending typed command snapshot. Type exact token to execute in a new Ghostty tab: ${requirement.token}`;
      this.render();
      return;
    }

    await this.requestGhosttyTab(manual.cwd, manual.command);
  }

  async executeCapability(capability, { confirmed = false } = {}) {
    const project = this.selectedProject;
    if (!project || capability?.runnable !== true || !capability.execution) {
      this.status = "Selected capability is not runnable.";
      this.render();
      return;
    }
    let cwd;
    try {
      cwd = resolveExecutionCwd(project.path, capability.execution.cwd);
    } catch (error) {
      this.status = `Ghostty request failed: ${error.message || String(error)}`;
      this.render();
      return;
    }
    const command = capabilityActualExecutionCommand(capability);
    if (confirmationGateAction({ type: "capability", risk: capability.risk, confirmed }) === "pending") {
      this.pendingConfirmationInput = "";
      this.pendingHighRisk = {
        type: "capability",
        capability,
        project,
        cwd,
        command,
        locationLabel: "cwd",
        location: cwd,
        target: `${project.name} / ${capability.name}`,
        typeLabel: "Project capability",
        uiSnapshot: this.captureUiSnapshot()
      };
      this.status = "Review the pending project capability snapshot. Press y to immediately execute in a new Ghostty tab, or n/Esc to cancel.";
      this.render();
      return;
    }

    await this.requestGhosttyTab(cwd, command);
  }

  async executeRemoteCommand(command, { confirmed = false, device = null } = {}) {
    const remoteDevice = device || command?.device || this.selectedRemoteDevice;
    const fullSshCommand = command?.fullSshCommand || command?.command;
    if (!remoteDevice || command?.runnable !== true || !fullSshCommand) {
      this.status = "Selected remote command is not runnable.";
      this.render();
      return;
    }
    const cwd = resolveRemoteExecutionCwd(command.execution?.cwd || this.root);
    const remoteDanger = assessRemoteCommandDanger(command, remoteDevice);
    if (confirmationGateAction({ type: "remote", confirmed }) === "pending") {
      this.pendingConfirmationInput = "";
      this.pendingHighRisk = {
        type: "remote",
        command,
        device: remoteDevice,
        cwd,
        fullSshCommand,
        locationLabel: "remote target",
        location: command.sshTarget || remoteDevice.target || remoteDevice.alias,
        target: `${remoteDevice.alias || remoteDevice.target || command.sshTarget || "remote"} / ${command.name || "ssh command"}`,
        typeLabel: "Remote command",
        remoteDanger,
        uiSnapshot: this.captureUiSnapshot()
      };
      const requirement = pendingConfirmationRequirement(this.pendingHighRisk);
      this.status = requirement.type === "token"
        ? `Review the pending remote command snapshot. Confirming immediately executes in a new Ghostty tab. Type exact token: ${requirement.token}`
        : "Review the pending remote command snapshot. Press y to immediately execute in a new Ghostty tab, or n/Esc to cancel.";
      this.render();
      return;
    }

    await this.requestGhosttyTab(cwd, fullSshCommand);
  }

  async requestGhosttyTab(cwd, command) {
    const requestLabel = `cd ${shellQuote(cwd)} && ${command}`;
    this.status = `Opening Ghostty new tab: ${requestLabel}`;
    this.render();
    try {
      const result = await openGhosttyTab(cwd, command);
      if (this.disposed) {
        return;
      }
      if (result.status === "timeout") {
        const detail = scriptOutputSummary(result) || "osascript did not finish before the timeout.";
        this.status = `Ghostty request timeout after ${result.timeoutMs}ms: ${detail}`;
      } else if (result.status === "sent") {
        const usage = recordGhosttyRequestEvent(this.files.dataDir, {
          status: result.status,
          cwd,
          command
        });
        this.ghosttySentEvents = usage.events;
        this.runtimeStatusCache = { untilMs: 0, value: null };
        this.status = `Ghostty command sent (${ghosttyLauncherLabel(result)}): ${requestLabel}`;
      } else {
        const detail = scriptOutputSummary(result) || "osascript returned a non-zero status.";
        this.status = `Ghostty request failed (${exitStatusLabel(result)}): ${detail}`;
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.status = `Ghostty request failed: ${errorSummary(error)}`;
    }
    this.render();
  }

  captureUiSnapshot() {
    return {
      mode: this.mode,
      focus: this.focus,
      input: this.input,
      inputFocused: this.inputFocused,
      selectedProjectIndex: this.selectedProjectIndex,
      selectedCapabilityIndex: this.selectedCapabilityIndex,
      selectedRemoteDeviceIndex: this.selectedRemoteDeviceIndex,
      selectedRemoteCommandIndex: this.selectedRemoteCommandIndex,
      scrolls: {
        projectScroll: this.projectScroll,
        capabilityScroll: this.capabilityScroll,
        remoteDeviceScroll: this.remoteDeviceScroll,
        remoteCommandScroll: this.remoteCommandScroll
      }
    };
  }

  restoreUiSnapshot(snapshot = {}) {
    this.mode = snapshot.mode || this.mode;
    this.focus = snapshot.focus || this.focus;
    this.input = snapshot.input ?? this.input;
    this.inputFocused = snapshot.inputFocused ?? this.inputFocused;
    this.selectedProjectIndex = Math.max(0, snapshot.selectedProjectIndex ?? this.selectedProjectIndex);
    this.selectedCapabilityIndex = Math.max(0, snapshot.selectedCapabilityIndex ?? this.selectedCapabilityIndex);
    this.selectedRemoteDeviceIndex = Math.max(0, snapshot.selectedRemoteDeviceIndex ?? this.selectedRemoteDeviceIndex);
    this.selectedRemoteCommandIndex = Math.max(0, snapshot.selectedRemoteCommandIndex ?? this.selectedRemoteCommandIndex);
    this.projectScroll = Math.max(0, snapshot.scrolls?.projectScroll ?? this.projectScroll);
    this.capabilityScroll = Math.max(0, snapshot.scrolls?.capabilityScroll ?? this.capabilityScroll);
    this.remoteDeviceScroll = Math.max(0, snapshot.scrolls?.remoteDeviceScroll ?? this.remoteDeviceScroll);
    this.remoteCommandScroll = Math.max(0, snapshot.scrolls?.remoteCommandScroll ?? this.remoteCommandScroll);
  }

  refresh() {
    if (this.refreshing) {
      this.status = this.refreshStatusLabel("already running");
      this.render();
      return;
    }

    this.pendingHighRisk = null;
    this.startRefreshAnimation();
    const child = spawn(process.execPath, [
      path.join(projectRoot, "bin", "workspace-keeper.js"),
      "scan",
      "--root",
      this.root,
      "--out",
      this.files.dataDir,
      "--json"
    ], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.refreshProcess = child;

    let stdout = "";
    let stderr = "";
    let settled = false;
    const appendOutput = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-8192);
    const finish = (error, result = {}) => {
      if (settled || this.refreshProcess !== child) {
        return;
      }
      settled = true;
      this.refreshProcess = null;
      this.finishRefresh(error, {
        ...result,
        stdout,
        stderr
      });
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(null, { code, signal }));
  }

  startRefreshAnimation() {
    this.refreshing = true;
    this.refreshStartedAt = Date.now();
    this.refreshFrame = 0;
    this.statusPriorityUntilMs = 0;
    this.status = this.refreshStatusLabel("scanning");
    this.render();
    this.refreshTimer = setInterval(() => {
      if (this.disposed || !this.refreshing) {
        return;
      }
      this.refreshFrame += 1;
      this.status = this.refreshStatusLabel("scanning");
      this.render();
    }, REFRESH_SPINNER_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  stopRefreshAnimation() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  finishRefresh(error, { code = 0, signal = null, stderr = "" } = {}) {
    this.stopRefreshAnimation();
    this.refreshing = false;
    if (this.disposed) {
      return;
    }

    if (error || code !== 0) {
      const detail = error?.message || lastOutputLine(stderr) || `exit ${code}${signal ? ` signal ${signal}` : ""}`;
      this.status = `Refresh failed: ${detail}`;
      this.statusPriorityUntilMs = Date.now() + REFRESH_ERROR_VISIBLE_MS;
      this.render();
      return;
    }

    try {
      const refreshedPlan = JSON.parse(fs.readFileSync(this.files.planFile, "utf8"));
      this.applyRefreshedPlan(refreshedPlan);
      const durationSeconds = ((Date.now() - this.refreshStartedAt) / 1000).toFixed(1);
      this.status = `Refresh complete in ${durationSeconds}s: ${this.plan.summary.projectCount} projects / ${this.plan.summary.capabilityCount || 0} capabilities / ${this.plan.summary.remoteCommandCount || 0} remote commands.`;
      this.statusPriorityUntilMs = Date.now() + REFRESH_STATUS_VISIBLE_MS;
    } catch (readError) {
      this.status = `Refresh failed: ${readError.message || String(readError)}`;
      this.statusPriorityUntilMs = Date.now() + REFRESH_ERROR_VISIBLE_MS;
    }
    this.render();
  }

  applyRefreshedPlan(plan) {
    this.plan = plan;
    this.ghosttySentEvents = loadGhosttySentEvents(this.files.dataDir);
    this.selectedProjectIndex = Math.max(0, this.projects.findIndex((project) => project.capabilitySummary?.total));
    this.selectedCapabilityIndex = 0;
    this.selectedRemoteDeviceIndex = Math.max(0, this.remoteDevices.findIndex((device) => device.commandCount));
    this.selectedRemoteCommandIndex = 0;
    this.projectScroll = 0;
    this.capabilityScroll = 0;
    this.remoteDeviceScroll = 0;
    this.remoteCommandScroll = 0;
    this.runtimeStatusCache = { untilMs: 0, value: null };
  }

  refreshStatusLabel(phase = "scanning") {
    const frame = REFRESH_SPINNER_FRAMES[this.refreshFrame % REFRESH_SPINNER_FRAMES.length];
    const elapsedSeconds = this.refreshStartedAt ? ((Date.now() - this.refreshStartedAt) / 1000).toFixed(1) : "0.0";
    const phaseLabel = phase === "already running" ? "already running" : "scanning projects, shell history, and remote commands";
    return `${colors.cyan}${frame}${RESET} Refresh ${phaseLabel} (${elapsedSeconds}s)`;
  }

  resetFilteredSelection() {
    this.selectedProjectIndex = 0;
    this.selectedCapabilityIndex = 0;
    this.selectedRemoteDeviceIndex = 0;
    this.selectedRemoteCommandIndex = 0;
    this.projectScroll = 0;
    this.capabilityScroll = 0;
    this.remoteDeviceScroll = 0;
    this.remoteCommandScroll = 0;
    this.pendingHighRisk = null;
  }

  render = () => {
    if (this.disposed) {
      return;
    }

    const width = Math.max(100, process.stdout.columns || 120);
    const height = Math.max(28, process.stdout.rows || 36);
    const leftWidth = Math.min(42, Math.max(30, Math.floor(width * 0.32)));
    const rightWidth = width - leftWidth - 3;
    const listTop = 6;
    const pendingSnapshotRows = this.pendingHighRisk ? this.renderPendingSnapshot(width) : [];
    const inspectorRows = this.pendingHighRisk ? [] : this.renderInspectorRows(width);
    const pendingSnapshotHeight = pendingSnapshotRows.length;
    const inspectorHeight = inspectorRows.length;
    const listBottom = height - 4 - pendingSnapshotHeight - inspectorHeight;
    const minListHeight = this.pendingHighRisk ? 4 : 8;
    const listHeight = Math.max(minListHeight, listBottom - listTop + 1);
    this.layout = {
      leftWidth,
      rightStart: leftWidth + 4,
      listTop,
      listHeight,
      width,
      height
    };
    this.projectViewport = { top: listTop, height: listHeight };
    this.capabilityViewport = { top: listTop, height: listHeight };
    if (this.mode === "remote") {
      this.keepRemoteDeviceVisible(listHeight);
      this.keepRemoteCommandVisible(listHeight);
    } else {
      this.keepProjectVisible(listHeight);
      this.keepCapabilityVisible(listHeight);
    }

    this.hitboxes = [];
    const lines = [];
    const runtime = this.runtimeStatus();
    lines.push(`${colors.bold}Workspace Keeper TUI${RESET} ${colors.gray}${this.root}${RESET} ${colors.gray}${formatRuntimeHeader(runtime)}${RESET}`);
    lines.push(`${colors.gray}${"─".repeat(width)}${RESET}`);
    const historyRunTotal = planProjectHistoryRunCount(this.plan.summary);
    lines.push(`Projects ${colors.bold}${this.plan.summary.projectCount}${RESET}  Capabilities ${colors.bold}${this.plan.summary.capabilityCount || 0}${RESET}  History runs ${colors.bold}${historyRunTotal}${RESET}  Remote ${colors.bold}${this.plan.summary.remoteDeviceCount || 0}/${this.plan.summary.remoteCommandCount || 0}${RESET}  High risk ${riskColor("high")}${this.plan.summary.highRiskCapabilityCount || 0}${RESET}  ${colors.gray}${formatDataFreshness(runtime)}${RESET}`);
    const runtimeWarning = formatRuntimeWarning(runtime);
    lines.push(runtimeWarning
      ? `${colors.yellow}${runtimeWarning}${RESET} ${colors.gray}q quit  r refresh  g projects/remote  / filter  Ctrl+X pending  Esc clear${RESET}`
      : `${colors.gray}q quit  r refresh  g projects/remote  / filter  Ctrl+X pending  Esc clear${RESET}`);
    const leftTitle = this.mode === "remote" ? "Devices" : "Projects";
    const rightTitle = this.mode === "remote" ? `Commands for ${this.selectedRemoteDevice?.alias || "remote"}` : (this.selectedProject?.name || "Capabilities");
    lines.push(`${paneTitle(leftTitle, this.focus === "projects", leftWidth)} ${paneTitle(rightTitle, this.focus === "capabilities", rightWidth)}`);

    for (let row = 0; row < listHeight; row += 1) {
      const y = listTop + row;
      const left = this.mode === "remote"
        ? this.renderRemoteDeviceLine(this.remoteDeviceScroll + row, leftWidth, y)
        : this.renderProjectLine(this.projectScroll + row, leftWidth, y);
      const right = this.mode === "remote"
        ? this.renderRemoteCommandLine(this.remoteCommandScroll + row, rightWidth, y, leftWidth + 3)
        : this.renderCapabilityLine(this.capabilityScroll + row, rightWidth, y, leftWidth + 3);
      lines.push(`${left} │ ${right}`);
    }

    lines.push(`${colors.gray}${"─".repeat(width)}${RESET}`);
    if (this.pendingHighRisk) {
      lines.push(...pendingSnapshotRows);
    } else {
      lines.push(...inspectorRows);
    }
    lines.push(trimToWidth(this.bottomStatusLine(), width));
    lines.push(this.renderInputLine(width));
    process.stdout.write(`${CLEAR}${lines.slice(0, height).join("\n")}`);
  };

  bottomStatusLine() {
    if (this.pendingHighRisk || this.refreshing || Date.now() < this.statusPriorityUntilMs) {
      return this.status;
    }
    return this.enterPreviewLabel();
  }

  enterPreviewLabel() {
    if (this.mode === "remote") {
      const device = this.selectedRemoteDevice;
      const command = this.remoteCommands[this.selectedRemoteCommandIndex];
      return enterRemotePreviewLabel(device, command, {
        cwd: resolveRemoteExecutionCwd(command?.execution?.cwd || this.root)
      });
    }
    return enterCapabilityPreviewLabel(this.selectedProject, this.capabilities[this.selectedCapabilityIndex]);
  }

  renderPendingSnapshot(width) {
    const pending = this.pendingHighRisk || {};
    const manual = pending.manual || {};
    const type = pending.typeLabel || manual.typeLabel || "Project capability";
    const target = pending.target || manual.target || pending.capability?.name || pending.command?.name || manual.label || "selected command";
    const locationLabel = pending.locationLabel || manual.locationLabel || (pending.type === "remote" ? "remote target" : "cwd");
    const location = pending.location || manual.location || pending.cwd || manual.cwd || "unknown";
    const command = pending.fullSshCommand ||
      pending.command?.fullSshCommand ||
      pending.command?.command ||
      (typeof pending.command === "string" ? pending.command : "") ||
      manual.command ||
      pending.capability?.command ||
      "unknown";
    const remoteDanger = pending.type === "remote" ? (pending.remoteDanger || assessRemoteCommandDanger(pending.command || { fullSshCommand: command }, pending.device)) : null;
    const manualDanger = pending.type === "manual" ? assessManualCommandDanger(command) : null;
    const confirmationRequirement = pendingConfirmationRequirement({ ...pending, remoteDanger });
    const rows = [
      `${colors.bold}${colors.yellow}Pending execution snapshot${RESET}`,
      `Type: ${type}`,
      `Target: ${target}`,
      "Action: immediately execute in Ghostty",
      inlineField(locationLabel, location, width)
    ];
    if (pending.type === "remote") {
      rows.push(...remotePendingSnapshotRows(pending.device, pending.command, { cwd: pending.cwd }));
    }
    rows.push(...snapshotFieldRows("Command", command, width, {
      maxLines: pending.type === "remote" ? 4 : 3
    }));
    if (remoteDanger) {
      rows.push(`Risk: ${remoteDanger.level} - ${remoteDanger.reason}`);
    }
    if (manualDanger) {
      rows.push(`Risk: ${manualDanger.level} - ${manualDanger.reason}`);
    }
    if (confirmationRequirement.type === "token") {
      rows.push(...snapshotFieldRows("Required token", confirmationRequirement.token, width, { maxLines: 2 }));
      if (this.pendingConfirmationInput) {
        rows.push(`Typed token: ${this.pendingConfirmationInput}`);
      }
      rows.push(`${confirmationVerbLabel(confirmationRequirement)}: exact token then Enter runs in new Ghostty tab; n/Esc cancels`);
    } else {
      rows.push("Confirm: y runs in new Ghostty tab; n/Esc cancels");
    }
    return rows.map((row) => trimToWidth(row, width));
  }

  renderInspectorRows(width) {
    let rows;
    if (this.mode === "remote") {
      rows = this.renderRemoteInspectorRows(width);
    } else if (this.focus === "projects") {
      rows = this.renderProjectInspectorRows();
    } else {
      rows = this.renderCapabilityInspectorRows(width);
    }
    const limit = this.mode === "remote" || this.focus === "projects" ? 4 : 3;
    return rows.slice(0, limit).map((row) => trimToWidth(row, width));
  }

  renderProjectInspectorRows() {
    return projectInspectorRows(this.selectedProject, this.plan, { query: this.searchQuery })
      .map((row, index) => index === 0 ? row.replace(/^Inspector:/, `${colors.bold}Inspector${RESET}:`) : row);
  }

  renderCapabilityInspectorRows(width = 120) {
    const project = this.selectedProject;
    const capability = this.capabilities[this.selectedCapabilityIndex];
    if (!capability) {
      return [
        `${colors.bold}Inspector${RESET}: ${project?.name || "no project selected"}`,
        `Command: none`,
        `cwd: ${project?.path || "unknown"}`
      ];
    }

    const projectMatches = project ? matchesQuery(projectOwnSearchText(project), this.searchQuery) : false;
    const matchReason = capabilityMatchReason(capability, this.searchQuery, projectMatches);
    const cwd = capabilityExecutionCwd(project, capability) || "unknown";
    const command = capabilityActualExecutionCommand(capability);
    const signal = summarizeGhosttySentEvents(this.ghosttySentEvents, {
      cwd,
      command
    });
    return [
      `${colors.bold}Inspector${RESET}: ${project?.name || "workspace"} / ${capability.name || "capability"}`,
      inlineField("Command", command || "unknown", width),
      `rank: ${capabilityRankExplanation(capability, project, signal)}  reason: ${listLabel(capability.reasons)}  match: ${matchReason || "none"}`
    ];
  }

  renderRemoteInspectorRows(width = 120) {
    const device = this.selectedRemoteDevice;
    const command = this.remoteCommands[this.selectedRemoteCommandIndex];
    if (!command) {
      return [
        `${colors.bold}Inspector${RESET}: ${device?.alias || "no remote device selected"}`,
        `Command: none`,
        `remote target: ${device?.target || device?.alias || "unknown"}`
      ];
    }

    const fullSshCommand = command.fullSshCommand || command.command || "unknown";
    const target = command.sshTarget || device?.target || device?.alias || "unknown";
    const cwd = resolveRemoteExecutionCwd(command.execution?.cwd || this.root);
    const deviceMatches = device ? matchesQuery(remoteDeviceOwnSearchText(device), this.searchQuery) : false;
    const matchReason = remoteCommandMatchReason(command, this.searchQuery, deviceMatches);
    const project = remoteCommandProjectHint(command);
    const danger = assessRemoteCommandDanger(command, device);
    const source = (command.sources || []).slice(0, 1).join(", ") || sourceLabel(device?.source);
    const reason = [command.kind || "ssh", command.count ? `${command.count}x` : ""].filter(Boolean).join("/");
    const dangerLabel = danger ? `${danger.level} - ${danger.reason}` : "none";
    const context = remoteCommandContextLabel(command, device, { cwd, target, source });
    const signal = summarizeGhosttySentEvents(this.ghosttySentEvents, {
      cwd,
      command: fullSshCommand
    });
    return [
      `${colors.bold}Inspector${RESET}: ${device?.alias || "remote"} / ${command.name || "ssh command"}`,
      inlineField("Command", fullSshCommand, width),
      context,
      `rank: ${remoteCommandRankExplanation(command, device, signal, { cwd, target, source, dangerLabel })}  ${project || "project:none"}  reason: ${reason}  match: ${matchReason || "none"}`
    ];
  }

  renderInputLine(width) {
    const query = this.searchQuery;
    const leftCount = this.mode === "remote" ? this.remoteDevices.length : this.projects.length;
    const rightCount = this.mode === "remote" ? this.remoteCommands.length : this.capabilities.length;
    const focus = this.inputFocused ? `${colors.cyan}${colors.bold}` : colors.gray;
    const marker = this.inputFocused ? ">" : "/";
    const cursor = this.inputFocused ? "|" : "";
    const counts = query ? ` ${leftCount}/${rightCount}` : "";
    const modeLabel = "filter";
    const context = this.inputContextLabel();
    const value = this.input ? `${this.input}${cursor}` : `${colors.gray}${this.inputFocused ? cursor : "type / to filter"}${RESET}`;
    return trimToWidth(`${focus}${marker} ${modeLabel}${RESET}${counts}${colors.gray} ${context}${RESET} ${value}`, width);
  }

  inputStatus() {
    if (!this.input.trim()) {
      return "Input is filter/search text. Empty input leaves lists unfiltered.";
    }
    return `Typing filters only; Ctrl+X opens a pending execution snapshot for non-empty text. ${this.inputContextLabel()}`;
  }

  inputContextLabel() {
    const typedCommand = this.input.trim();
    if (this.mode === "remote") {
      if (typedCommand && isSshCommand(typedCommand)) {
        return "Remote input: filtering now; Ctrl+X opens pending snapshot for full ssh command";
      }
      if (typedCommand) {
        return "Remote input: filtering only; Ctrl+X requires full ssh ... command";
      }
      return `Remote device: ${this.selectedRemoteDevice?.alias || "none"}`;
    }
    const project = this.selectedProject;
    if (typedCommand) {
      return `Project input: filtering now; Ctrl+X opens pending snapshot in cwd:${compactPathLabel(project?.path || this.root)}`;
    }
    return `Project: ${project?.name || "workspace"} cwd:${compactPathLabel(project?.path || this.root)}`;
  }

  renderProjectLine(index, width, y) {
    const project = this.projects[index];
    if (!project) {
      return this.renderSearchEmptyLine(index, width, "projects", this.projects.length);
    }
    this.hitboxes.push({ type: "project", index, x1: 1, x2: width, y1: y, y2: y });
    const selected = index === this.selectedProjectIndex;
    const reason = projectMatchReason(project, this.searchQuery);
    const cap = projectCapabilityCount(project);
    const high = project.capabilitySummary?.highRisk || 0;
    const age = activityAgeLabel(project);
    const meta = [
      projectSortTags(project).join(" "),
      reason ? `match:${reason}` : "",
      age,
      `${cap} cap`,
      high ? `${high} high` : ""
    ].filter(Boolean).join(" ");
    const name = project.name || "project";
    const metaWidth = meta ? Math.min(Math.max(stripAnsi(meta).length, 12), Math.max(0, width - 8)) : 0;
    const nameWidth = meta ? Math.max(6, width - metaWidth - 1) : width;
    const label = meta
      ? `${trimToWidth(name, nameWidth)} ${colors.gray}${trimToWidth(meta, metaWidth)}${RESET}`
      : trimToWidth(name, width);
    return stylizeSelection(pad(label, width), selected);
  }

  renderCapabilityLine(index, width, y, xOffset) {
    const capability = this.capabilities[index];
    if (!capability) {
      return this.renderSearchEmptyLine(index, width, "capabilities", this.capabilities.length);
    }

    const selected = index === this.selectedCapabilityIndex;
    const runLabel = capabilityRunLabel(capability);
    const canRun = canRunCapability(capability);
    const runStart = Math.max(1, width - runLabel.length + 1);
    this.hitboxes.push({ type: "capability", index, x1: xOffset, x2: xOffset + width - 1, y1: y, y2: y });
    if (canRun) {
      this.hitboxes.push({ type: "run", index, capability, x1: xOffset + runStart - 1, x2: xOffset + width - 1, y1: y, y2: y });
    }

    const risk = `${riskColor(capability.risk)}${capability.risk}${RESET}`;
    const meta = capabilityMetaLabels(capability, this.selectedProject).join(" ");
    const commandWidth = Math.max(10, width - runLabel.length - 2);
    const command = `${capability.name}: ${capabilityListCommandLabel(capability)}`;
    const text = `${risk} ${colors.bold}${command}${RESET}${meta ? ` ${colors.gray}${meta}${RESET}` : ""}`;
    const line = `${trimToWidth(text, commandWidth)} ${button(runLabel, capability.risk)}`;
    return stylizeSelection(pad(line, width), selected);
  }

  renderRemoteDeviceLine(index, width, y) {
    const device = this.remoteDevices[index];
    if (!device) {
      return this.renderSearchEmptyLine(index, width, "remote devices", this.remoteDevices.length);
    }

    this.hitboxes.push({ type: "remote-device", index, x1: 1, x2: width, y1: y, y2: y });
    const selected = index === this.selectedRemoteDeviceIndex;
    const reason = remoteDeviceMatchReason(device, this.searchQuery);
    const commandCount = device.commandCount || 0;
    const runCount = device.runCount || 0;
    const match = reason ? ` match:${reason}` : "";
    const label = `${device.alias} ${colors.gray}${match} ${commandCount} cmd${runCount ? ` ${runCount} runs` : ""} ${device.target || ""}${RESET}`;
    return stylizeSelection(pad(trimToWidth(label, width), width), selected);
  }

  renderRemoteCommandLine(index, width, y, xOffset) {
    const command = this.remoteCommands[index];
    if (!command) {
      return this.renderSearchEmptyLine(index, width, "remote commands", this.remoteCommands.length);
    }

    const selected = index === this.selectedRemoteCommandIndex;
    const runLabel = remoteCommandRunLabel(command);
    const canRun = canRunRemoteCommand(command);
    const runStart = Math.max(1, width - runLabel.length + 1);
    this.hitboxes.push({ type: "remote-command", index, x1: xOffset, x2: xOffset + width - 1, y1: y, y2: y });
    if (canRun) {
      this.hitboxes.push({ type: "remote-run", index, command, x1: xOffset + runStart - 1, x2: xOffset + width - 1, y1: y, y2: y });
    }

    const fullSshCommand = command.fullSshCommand || command.command || "";
    const meta = [command.kind || "ssh", command.count ? `${command.count}x` : ""].filter(Boolean).join("/");
    const danger = assessRemoteCommandDanger(command, this.selectedRemoteDevice);
    const riskLabel = danger ? `${remoteDangerColor(danger.level)}${colors.bold}${danger.level}${RESET}` : `${riskColor("high")}ssh${RESET}`;
    const commandWidth = Math.max(10, width - runLabel.length - 2);
    const target = command.sshTarget || this.selectedRemoteDevice?.target || this.selectedRemoteDevice?.alias || "unknown";
    const projectHint = remoteCommandProjectHint(command);
    const summary = `${target} > ${command.name}: ${fullSshCommand}`;
    const contextMeta = [meta, projectHint].filter(Boolean).join(" ");
    const contextualText = `${riskLabel} ${colors.bold}${summary}${RESET}${contextMeta ? ` ${colors.gray}${contextMeta}${RESET}` : ""}`;
    const line = `${trimToWidth(contextualText, commandWidth)} ${button(runLabel, "high")}`;
    return stylizeSelection(pad(line, width), selected);
  }

  renderSearchEmptyLine(index, width, label, count) {
    const query = this.searchQuery;
    if (!query || count > 0) {
      return " ".repeat(width);
    }
    const scan = this.plan.scanGeneratedAt || this.plan.generatedAt;
    const rows = [
      `No ${label} match "${query}".`,
      "Esc clears search; g switches Projects/Remote.",
      scan ? `Last scan: ${scan}` : ""
    ];
    return pad(trimToWidth(`${colors.gray}${rows[index] || ""}${RESET}`, width), width);
  }

  keepProjectVisible(viewHeight = this.projectViewport?.height || 12) {
    if (this.selectedProjectIndex < this.projectScroll) {
      this.projectScroll = this.selectedProjectIndex;
    }
    if (this.selectedProjectIndex >= this.projectScroll + viewHeight) {
      this.projectScroll = this.selectedProjectIndex - viewHeight + 1;
    }
  }

  keepCapabilityVisible(viewHeight = this.capabilityViewport?.height || 12) {
    if (this.selectedCapabilityIndex < this.capabilityScroll) {
      this.capabilityScroll = this.selectedCapabilityIndex;
    }
    if (this.selectedCapabilityIndex >= this.capabilityScroll + viewHeight) {
      this.capabilityScroll = this.selectedCapabilityIndex - viewHeight + 1;
    }
  }

  keepRemoteDeviceVisible(viewHeight = this.projectViewport?.height || 12) {
    if (this.selectedRemoteDeviceIndex < this.remoteDeviceScroll) {
      this.remoteDeviceScroll = this.selectedRemoteDeviceIndex;
    }
    if (this.selectedRemoteDeviceIndex >= this.remoteDeviceScroll + viewHeight) {
      this.remoteDeviceScroll = this.selectedRemoteDeviceIndex - viewHeight + 1;
    }
  }

  keepRemoteCommandVisible(viewHeight = this.capabilityViewport?.height || 12) {
    if (this.selectedRemoteCommandIndex < this.remoteCommandScroll) {
      this.remoteCommandScroll = this.selectedRemoteCommandIndex;
    }
    if (this.selectedRemoteCommandIndex >= this.remoteCommandScroll + viewHeight) {
      this.remoteCommandScroll = this.selectedRemoteCommandIndex - viewHeight + 1;
    }
  }
}

export function loadPlan({ root, files, refresh }) {
  if (!refresh && fs.existsSync(files.planFile)) {
    let cachedPlan;
    try {
      cachedPlan = JSON.parse(fs.readFileSync(files.planFile, "utf8"));
    } catch {
      return scanAndWritePlan({ root, files, cacheRefreshReason: "cached plan is unreadable" });
    }
    const compatibilityIssue = cachedPlanCompatibilityIssue(cachedPlan, { root });
    if (!compatibilityIssue) {
      return cachedPlan;
    }
    return scanAndWritePlan({ root, files, cacheRefreshReason: compatibilityIssue });
  }

  return scanAndWritePlan({ root, files });
}

function scanAndWritePlan({ root, files, cacheRefreshReason = "" }) {
  ensureDir(files.dataDir);
  const scan = scanWorkspace({ root, includeGenerated: true, logger: () => {} });
  const plan = makePlan(scan);
  writeDataFile(files.scanFile, `${JSON.stringify(scan, null, 2)}\n`);
  writeDataFile(files.planFile, `${JSON.stringify(plan, null, 2)}\n`);
  if (cacheRefreshReason) {
    plan.cacheRefreshReason = cacheRefreshReason;
  }
  return plan;
}

export function cachedPlanCompatibilityIssue(plan, { root = "" } = {}) {
  if (!plan || typeof plan !== "object") {
    return "cached plan is not an object";
  }
  if (root && plan.root && path.resolve(String(plan.root)) !== path.resolve(String(root))) {
    return "cached plan root mismatch";
  }
  if (!Array.isArray(plan.projects)) {
    return "cached plan is missing projects";
  }
  if (!plan.remoteControl || !Array.isArray(plan.remoteControl.devices)) {
    return "cached plan is missing remote control data";
  }
  const remoteIssue = cachedRemoteControlCompatibilityIssue(plan.remoteControl);
  if (remoteIssue) {
    return remoteIssue;
  }
  if (plan.projects.length > 0 && plan.projects.some((project) => !hasOwn(project, "historyUsage"))) {
    return "cached plan is missing project history data";
  }
  if (plan.projects.some((project) => project.historyUsage && !hasOwn(project.historyUsage, "signalRunCount"))) {
    return "cached plan is missing strong/weak history data";
  }
  return "";
}

function cachedRemoteControlCompatibilityIssue(remoteControl = {}) {
  for (const device of remoteControl.devices || []) {
    if (!Array.isArray(device.commands)) {
      continue;
    }
    for (const command of device.commands) {
      if (command?.runnable === true && (!command.execution || !hasOwn(command.execution, "cwd"))) {
        return "cached remote control command is missing execution cwd";
      }
      if (command?.runnable === true && !(command.fullSshCommand || command.command)) {
        return "cached remote control command is missing command text";
      }
      if ((command?.localProjects || []).some((project) => !project?.source)) {
        return "cached remote control command is missing project source";
      }
    }
  }
  return "";
}

export function resolveExecutionCwd(projectPath, relativeCwd = "") {
  return sharedResolveExecutionCwd(projectPath, relativeCwd);
}

export function capabilityActualExecutionCommand(capability = {}) {
  return sharedCapabilityActualExecutionCommand(capability);
}

export function confirmationGateAction({ type, risk, confirmed = false } = {}) {
  if (confirmed) {
    return "direct";
  }
  if (type === "manual" || type === "remote") {
    return "pending";
  }
  if (type === "capability" && risk === "high") {
    return "pending";
  }
  return "direct";
}

export function remoteConfirmationToken(command = {}, device = {}) {
  const target = String(device?.alias || device?.target || command?.sshTarget || command?.target || "remote").trim() || "remote";
  const name = String(command?.name || command?.remoteCommand || command?.command || "ssh command").trim() || "ssh command";
  return `RUN REMOTE ${target}/${name}`;
}

export function manualConfirmationToken(manual = {}) {
  const target = String(manual?.target || manual?.label || "workspace")
    .replace(/\s+/g, " ")
    .trim() || "workspace";
  return `RUN LOCAL ${target}`;
}

export function pendingConfirmationRequirement(pending = {}) {
  if (pending?.type === "manual") {
    return {
      type: "token",
      token: manualConfirmationToken(pending.manual),
      level: "typed",
      reason: "typed local command",
      label: "typed local command"
    };
  }
  if (pending?.type === "remote") {
    const danger = pending.remoteDanger || assessRemoteCommandDanger(pending.command, pending.device);
    if (requiresRemoteConfirmationToken(danger)) {
      return {
        type: "token",
        token: remoteConfirmationToken(pending.command, pending.device),
        level: danger.level,
        reason: danger.reason,
        label: `remote ${danger.level} risk`
      };
    }
  }
  return { type: "simple" };
}

export function parsePendingConfirmationInput(text, requirement = { type: "simple" }) {
  const value = String(text ?? "");
  if (value === "n" || value === "N" || value === "\x1b") {
    return "cancel";
  }
  if (requirement?.type === "token") {
    return value === requirement.token ? "confirm" : "locked";
  }
  if (value === "y" || value === "Y") {
    return "confirm";
  }
  return "locked";
}

function requiresRemoteConfirmationToken(danger) {
  return danger?.level === "critical" || danger?.level === "destructive";
}

function pendingLockedStatus(requirement = { type: "simple" }) {
  if (requirement.type === "token") {
    const label = requirement.label || `${requirement.level || "selected"} command`;
    return `${capitalize(label)} requires exact token: ${requirement.token}`;
  }
  return "Review the pending snapshot. Press y to immediately execute in a new Ghostty tab, or n/Esc to cancel.";
}

function pendingTokenEntryStatus(requirement, value) {
  const length = Array.from(value || "").length;
  const total = Array.from(requirement.token || "").length;
  return `Token entry ${length}/${total}. Exact token then Enter runs in new Ghostty tab; n/Esc cancels.`;
}

function confirmationVerbLabel(requirement = {}) {
  return requirement.label ? `Confirm ${requirement.label}` : "Confirm";
}

export function buildTypedRemoteCommand(typedCommand, device = null, { cwd = "", devices = [] } = {}) {
  const input = String(typedCommand || "").trim();
  if (!input) {
    return null;
  }

  const parsed = parseSshCommand(input);
  const executionCwd = cwd || os.homedir();
  if (parsed) {
    const target = parsed.sshTarget || parsed.target || parsed.host || "ssh target";
    const label = typedRemoteCommandLabel(parsed.remoteCommand || "login");
    const matchedDevice = resolveTypedRemoteDevice(parsed, device, devices);
    const typedDevice = matchedDevice || {
      alias: target,
      aliases: [target],
      hostName: parsed.host || target,
      user: parsed.user || "",
      port: parsed.port || "",
      target,
      source: { type: "typed-input" }
    };
    return {
      device: typedDevice,
      command: {
        name: label,
        kind: parsed.remoteCommand ? "remote-command" : "login",
        command: input,
        fullSshCommand: input,
        sshTarget: target,
        remoteCommand: parsed.remoteCommand || "",
        risk: "high",
        runnable: true,
        count: 0,
        sources: ["typed-input"],
        cwdHints: [],
        localProjects: [],
        execution: {
          cwd: executionCwd,
          command: "shell",
          args: ["-lc", input]
        }
      }
    };
  }

  return null;
}

function typedRemoteCommandMatchesDevice(parsed = {}, device = null) {
  if (!device || device.source?.type !== "ssh-config") {
    return false;
  }
  const candidates = new Set([
    device.alias,
    ...(device.aliases || []),
    device.hostName,
    device.target,
    device.user && device.hostName ? `${device.user}@${device.hostName}` : "",
    device.user && device.alias ? `${device.user}@${device.alias}` : ""
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  return [
    parsed.target,
    parsed.sshTarget,
    parsed.host,
    parsed.user && parsed.host ? `${parsed.user}@${parsed.host}` : ""
  ].filter(Boolean).some((value) => candidates.has(String(value).toLowerCase()));
}

function resolveTypedRemoteDevice(parsed = {}, selectedDevice = null, devices = []) {
  if (typedRemoteCommandMatchesDevice(parsed, selectedDevice)) {
    return selectedDevice;
  }
  const matches = (devices || []).filter((device) => typedRemoteCommandMatchesDevice(parsed, device));
  return matches.length === 1 ? matches[0] : null;
}

function typedRemoteCommandLabel(value) {
  const label = String(value || "ssh command").replace(/\s+/g, " ").trim() || "ssh command";
  return label.length > 72 ? `${label.slice(0, 69)}...` : label;
}

function resolveRemoteExecutionCwd(cwd) {
  const fallback = os.homedir();
  const resolved = path.resolve(String(cwd || fallback));
  return fs.existsSync(resolved) ? resolved : fallback;
}

function capabilityGhosttySentTarget(project, capability) {
  return {
    cwd: capabilityExecutionCwd(project, capability),
    command: capabilityActualExecutionCommand(capability)
  };
}

function remoteCommandGhosttySentTarget(command, root) {
  return {
    cwd: resolveRemoteExecutionCwd(command?.execution?.cwd || root),
    command: command?.fullSshCommand || command?.command || ""
  };
}

function capabilityExecutionCwd(project, capability) {
  if (!project?.path) {
    return "";
  }
  try {
    return resolveExecutionCwd(project.path, capability?.execution?.cwd);
  } catch {
    return "";
  }
}

function parseMouse(input) {
  const match = input.match(/\x1b\[<(\d+);(\d+);(\d+)([mM])/);
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  const isWheel = (code & 64) === 64;
  const wheelDirection = isWheel && (code & 3) <= 1 ? ((code & 1) === 0 ? -1 : 1) : 0;
  return {
    code,
    x: Number(match[2]),
    y: Number(match[3]),
    down: !isWheel && match[4] === "M" && (code & 3) === 0,
    scroll: wheelDirection
  };
}

function isPrintableInput(text) {
  return Boolean(text) &&
    !text.startsWith("\x1b") &&
    Array.from(text).every((char) => {
      const code = char.codePointAt(0);
      return code >= 0x20 && code !== 0x7f;
    });
}

function isReservedShortcut(text) {
  return text.length === 1 && (new Set(["q", "r", "g", "j", "k"]).has(text) || text === "R");
}

function focusLabel(mode, focus) {
  if (mode === "remote") {
    return focus === "projects" ? "devices" : "commands";
  }
  return focus === "projects" ? "projects" : "capabilities";
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesQuery(text, query) {
  if (!query) {
    return true;
  }
  const haystack = String(text || "").toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((part) => haystack.includes(part));
}

function projectOwnSearchText(project) {
  return [
    project.name,
    project.path,
    ...(project.projectTypes || []),
    project.git?.branch,
    project.git?.remote,
    project.archive?.status
  ].filter(Boolean).join(" ");
}

function projectSearchText(project) {
  return [
    projectOwnSearchText(project),
    ...(project.capabilities || []).map(capabilitySearchText)
  ].filter(Boolean).join(" ");
}

function capabilitySearchText(capability) {
  return [
    capability.name,
    capability.category,
    capability.runtime,
    capability.command,
    capability.source?.path,
    capability.source?.key,
    capability.usage?.originalCommand,
    capability.usage?.cwdPath,
    ...(capability.reasons || [])
  ].filter(Boolean).join(" ");
}

function remoteDeviceOwnSearchText(device) {
  return [
    device.alias,
    ...(device.aliases || []),
    device.hostName,
    device.user,
    device.target,
    device.source?.path
  ].filter(Boolean).join(" ");
}

function remoteDeviceSearchText(device) {
  return [
    remoteDeviceOwnSearchText(device),
    ...(device.commands || []).map(remoteCommandSearchText)
  ].filter(Boolean).join(" ");
}

function remoteCommandSearchText(command) {
  return [
    command.name,
    command.kind,
    command.command,
    command.fullSshCommand,
    command.remoteCommand,
    command.sshTarget,
    ...(command.localProjects || []).map((project) => project.name),
    ...(command.cwdHints || []).map((hint) => hint.path || hint.cwd)
  ].filter(Boolean).join(" ");
}

function projectMatchReason(project, query) {
  return firstMatchReason(query, [
    ["name", project.name],
    ["path", project.path],
    ["type", project.projectTypes],
    ["branch", project.git?.branch],
    ["remote", project.git?.remote],
    ["archive", project.archive?.status],
    ["capability", (project.capabilities || []).map(capabilitySearchText)]
  ], "project");
}

function capabilityMatchReason(capability, query, projectMatches) {
  return firstMatchReason(query, [
    ["name", capability.name],
    ["command", capability.command],
    ["source", [capability.source?.path, capability.source?.key]],
    ["runtime", capability.runtime],
    ["category", capability.category],
    ["history", [capability.usage?.originalCommand, capability.usage?.cwdPath]],
    ["reason", capability.reasons]
  ], projectMatches ? "project" : "capability");
}

function remoteDeviceMatchReason(device, query) {
  return firstMatchReason(query, [
    ["name", [device.alias, ...(device.aliases || [])]],
    ["ssh host", [device.hostName, device.target]],
    ["user", device.user],
    ["source", device.source?.path],
    ["command", (device.commands || []).map(remoteCommandSearchText)]
  ], "remote device");
}

function remoteCommandMatchReason(command, query, deviceMatches) {
  return firstMatchReason(query, [
    ["name", command.name],
    ["command", [command.command, command.fullSshCommand, command.remoteCommand]],
    ["ssh host", command.sshTarget],
    ["project", (command.localProjects || []).map((project) => project.name)],
    ["cwd", (command.cwdHints || []).map((hint) => hint.path || hint.cwd)]
  ], deviceMatches ? "ssh host" : "remote command");
}

function firstMatchReason(query, fields, fallback) {
  if (!query) {
    return "";
  }
  for (const [label, value] of fields) {
    const values = Array.isArray(value) ? value : [value];
    if (values.filter(Boolean).some((item) => matchesQuery(String(item), query))) {
      return label;
    }
  }
  return fallback;
}

function scriptOutputSummary(result) {
  const text = String(result.stderr || result.stdout || "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function exitStatusLabel(result) {
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return `exit ${result.code ?? "unknown"}`;
}

function ghosttyLauncherLabel(result = {}) {
  if (result.launcher === "ghostty-cli") {
    return "ghostty cli";
  }
  return "osascript exit 0";
}

function errorSummary(error) {
  return error?.message || String(error);
}

function lastOutputLine(output = "") {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || "";
}

const LOW_SIGNAL_PROJECT_NAMES = new Set([
  ".currentspaces-assistant",
  ".obsidian",
  ".pytest_cache",
  ".workspace-tools",
  ".cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage"
]);

const SCRIPT_CAPABILITY_SOURCES = new Set([
  "package.json",
  "composer.json",
  "pyproject.toml",
  "script-file",
  "Makefile",
  "justfile",
  "Taskfile"
]);

export function compareProjectsByActivity(a, b) {
  return projectSignalTier(a) - projectSignalTier(b) ||
    projectLiveActivityTime(b) - projectLiveActivityTime(a) ||
    compareProjectHistoryUsage(a, b) ||
    projectFreshActivityTime(b) - projectFreshActivityTime(a) ||
    projectSortScore(b) - projectSortScore(a) ||
    (b.git?.dirtyTotal || 0) - (a.git?.dirtyTotal || 0) ||
    projectCapabilityCount(b) - projectCapabilityCount(a) ||
    a.name.localeCompare(b.name);
}

export function compareRemoteDevices(a, b) {
  return remoteDeviceSortScore(b) - remoteDeviceSortScore(a) ||
    (b.runCount || 0) - (a.runCount || 0) ||
    (b.lastSequence || 0) - (a.lastSequence || 0) ||
    (b.commandCount || 0) - (a.commandCount || 0) ||
    a.alias.localeCompare(b.alias);
}

export function compareCapabilitiesByTuiOrder(a, b, { project = null, ghosttySentEvents = [] } = {}) {
  return runnableRank(a) - runnableRank(b) ||
    sourceRank(a) - sourceRank(b) ||
    usageRank(b) - usageRank(a) ||
    riskRank(a.risk) - riskRank(b.risk) ||
    (b.usage?.lastSequence || 0) - (a.usage?.lastSequence || 0) ||
    capabilityIntentRank(a) - capabilityIntentRank(b) ||
    b.confidence - a.confidence ||
    compareGhosttySentUsage(
      ghosttySentEvents,
      capabilityGhosttySentTarget(project, a),
      capabilityGhosttySentTarget(project, b)
    ) ||
    a.name.localeCompare(b.name);
}

export function compareRemoteCommandsByTuiOrder(a, b, { root = "", ghosttySentEvents = [] } = {}) {
  return runnableRank(a) - runnableRank(b) ||
    remoteCommandSourceRank(a) - remoteCommandSourceRank(b) ||
    (b.count || 0) - (a.count || 0) ||
    (b.lastSequence || 0) - (a.lastSequence || 0) ||
    compareGhosttySentUsage(
      ghosttySentEvents,
      remoteCommandGhosttySentTarget(a, root),
      remoteCommandGhosttySentTarget(b, root)
    ) ||
    a.name.localeCompare(b.name);
}

export function compareGhosttySentUsage(events, aTarget, bTarget) {
  const a = sentTieBreakRank(events, aTarget);
  const b = sentTieBreakRank(events, bTarget);
  return b.count - a.count ||
    b.lastSentTime - a.lastSentTime;
}

export function sentTieBreakRank(events, target) {
  const summary = summarizeGhosttySentEvents(events, target);
  return {
    count: summary.count || 0,
    lastSentTime: sentTimeValue(summary.lastSentAt)
  };
}

function projectSortScore(project) {
  const capabilityCount = projectCapabilityCount(project);
  const historyRuns = projectHistorySignalRunCount(project);
  const weakHistoryRuns = projectHistoryWeakRunCount(project);
  const lowSignal = isLowSignalProject(project);
  let score = 0;

  if (capabilityCount > 0) {
    score += 90 + Math.min(capabilityCount, 30) * 3;
    if (hasScriptCapability(project)) {
      score += 70;
    }
  } else {
    score -= 140;
  }
  if (historyRuns > 0) {
    score += lowSignal ? 20 : 120 + Math.min(historyRuns, 40) * 4;
  } else if (weakHistoryRuns > 0) {
    score += lowSignal ? 5 : 18 + Math.min(weakHistoryRuns, 20);
  }
  if (hasGitSignal(project)) {
    score += 70;
    if (project.git?.dirtyTotal > 0) {
      score += 50 + Math.min(project.git.dirtyTotal, 30) * 2;
    }
    if (isRecentGitActivity(project)) {
      score += 45;
    }
  }
  if (isFreshProjectActivity(project) && !lowSignal) {
    score += 55;
  }
  if (lowSignal) {
    score -= 360;
  }

  return score;
}

function projectSignalTier(project) {
  if (isLowSignalProject(project)) {
    return 4;
  }
  if (hasScriptCapability(project)) {
    return 0;
  }
  if (projectCapabilityCount(project) > 0) {
    return 1;
  }
  if (hasGitSignal(project)) {
    return 2;
  }
  return 3;
}

function projectSignalTierLabel(project) {
  const tier = projectSignalTier(project);
  if (tier === 0) return "scripts";
  if (tier === 1) return "cap";
  if (tier === 2) return "git";
  if (tier === 4) return "low-signal";
  return "dir";
}

function remoteDeviceSortScore(device) {
  let score = 0;
  score += Math.min(device.runCount || 0, 40) * 22;
  score += recentSequenceScore(device.lastSequence);
  score += Math.min(device.commandCount || 0, 12) * 10;
  if (isSshConfigDevice(device)) {
    score += 520;
  } else if (isHistoryOnlyDevice(device)) {
    score -= isLikelyTemporaryHistoryDevice(device) ? 260 : 120;
  }
  return score;
}

export function projectSortTags(project) {
  const tags = [];
  const capabilityCount = projectCapabilityCount(project);
  const historyEvidence = projectHistoryEvidenceTags(project);
  const lowSignal = isLowSignalProject(project);

  if (capabilityCount === 0) {
    tags.push(lowSignal ? "low↓" : "dir");
  } else if (hasScriptCapability(project)) {
    tags.push("scripts");
  } else {
    tags.push("cap");
  }
  if (historyEvidence.length > 0) {
    tags.push(...historyEvidence);
  } else if (projectHistoryRunCount(project) > 0) {
    tags.push("history");
  }
  if (lowSignal && capabilityCount > 0) {
    tags.push("low↓");
  }
  if (hasGitSignal(project)) {
    tags.push("git");
  }
  if (isLiveProjectActivity(project) && !lowSignal) {
    tags.push("active");
  } else if (isFreshProjectActivity(project) && !lowSignal) {
    tags.push("touched");
  }

  return tags.slice(0, 6);
}

export function projectHistoryEvidenceLabel(project) {
  return projectHistoryEvidenceTags(project).join(" ");
}

export function projectHistoryInspectorLabel(project, plan = {}, { now = new Date() } = {}) {
  const scanStale = projectScanStaleLabel(plan, { now });
  const suffix = scanStale ? `; ${scanStale}` : "";

  if (!hasOwn(project, "historyUsage")) {
    return `unavailable; press r to rescan${suffix}`;
  }

  const usage = project.historyUsage || {};
  const runCount = Number(usage.runCount || 0);
  if (runCount > 0) {
    const evidence = projectHistoryEvidenceLabel(project) || `${runCount}x`;
    const commandCount = Number(usage.commandCount || 0);
    const commands = commandCount > 0 && commandCount !== runCount ? ` ${commandCount} cmds` : "";
    const signalRunCount = projectHistorySignalRunCount(project);
    const lastRunAt = signalRunCount > 0 ? (usage.signalLastRunAt || usage.lastRunAt) : usage.lastRunAt;
    const last = lastRunAt ? ` last ${timestampAgeLabel(lastRunAt, now)}` : "";
    const weakRunCount = projectHistoryWeakRunCount(project);
    const weak = hasOwn(usage, "signalRunCount") && weakRunCount > 0
      ? (signalRunCount > 0 ? ` +${weakRunCount} weak` : " low-value")
      : "";
    return `${evidence}${commands}${last}${weak}${suffix}`;
  }

  return `none recorded${suffix}`;
}

export function projectHistoryTopCommandLabel(project = {}) {
  const usage = project?.historyUsage || {};
  const top = (projectHistorySignalRunCount(project) > 0 ? usage.topSignalCommands?.[0] : null) ||
    usage.topCommands?.[0];
  if (!top?.command) {
    return "none";
  }

  const count = `${Number(top.count || 1)}x`;
  const sequence = top.lastSequence == null || top.lastSequence < 0 ? "" : ` hist#${top.lastSequence}`;
  const relativeDir = top.relativeDir ? ` cwd:${shortDisplayValue(top.relativeDir, 32)}` : "";
  return `${count}${sequence}${relativeDir} ${shortDisplayValue(top.command, 96)}`;
}

export function projectRankExplanation(project, plan = {}, { query = "", now = new Date() } = {}) {
  if (!project) {
    return "none";
  }
  const tags = projectSortTags(project).join(" ") || "none";
  const capabilityCount = projectCapabilityCount(project);
  const history = projectHistoryInspectorLabel(project, plan, { now });
  const historyTop = projectHistoryTopCommandLabel(project);
  const script = hasScriptCapability(project) ? "scripts yes" : (capabilityCount ? "cap only" : "scripts none");
  const git = hasGitSignal(project) ? (project.git?.dirtyTotal > 0 ? `git ${project.git.dirtyTotal} dirty` : "git signal") : "git none";
  const activity = activityAgeLabel(project, now) || "unknown";
  const lowSignal = projectLowSignalInspectorLabel(project);
  const match = projectMatchReason(project, query);
  return [
    `tags ${tags}`,
    `tier ${projectSignalTierLabel(project)}`,
    `history ${history}`,
    historyTop !== "none" ? `top ${historyTop}` : "",
    script,
    git,
    `activity ${activity}`,
    lowSignal ? `low-signal ${lowSignal}` : "",
    match ? `match ${match}` : ""
  ].filter(Boolean).join("  ");
}

export function projectInspectorRows(project, plan = {}, { query = "", now = new Date() } = {}) {
  if (!project) {
    return [
      "Inspector: no project selected",
      "history: unavailable; press r to rescan",
      "sort: none"
    ];
  }

  const tags = projectSortTags(project).join(" ") || "none";
  const capabilityCount = projectCapabilityCount(project);
  const high = project.capabilitySummary?.highRisk || 0;
  const git = hasGitSignal(project) ? (project.git?.dirtyTotal > 0 ? `git:${project.git.dirtyTotal} dirty` : "git") : "git:none";
  const activity = activityAgeLabel(project, now);
  const match = projectMatchReason(project, query);
  const lowSignal = projectLowSignalInspectorLabel(project);
  const signals = [
    `sort: ${tags}`,
    `${capabilityCount} cap`,
    high ? `${high} high` : "",
    git,
    activity ? `activity:${activity}` : "",
    match ? `match:${match}` : ""
  ].filter(Boolean).join("  ");

  return [
    `Inspector: ${project.name || "project"}`,
    `history: ${projectHistoryInspectorLabel(project, plan, { now })}`,
    `history top: ${projectHistoryTopCommandLabel(project)}`,
    `${signals}${lowSignal ? `  | low-signal: ${lowSignal}` : ""}  | rank: ${projectRankExplanation(project, plan, { query, now })}`
  ];
}

function projectCapabilityCount(project) {
  return project.capabilitySummary?.total || 0;
}

function projectHistoryRunCount(project) {
  return project.historyUsage?.runCount ?? project.capabilitySummary?.historyRunCount ?? 0;
}

function projectHistorySignalRunCount(project) {
  if (hasOwn(project?.historyUsage || {}, "signalRunCount")) {
    return Number(project.historyUsage?.signalRunCount || 0);
  }
  return projectHistoryRunCount(project);
}

function projectHistoryWeakRunCount(project) {
  if (hasOwn(project?.historyUsage || {}, "weakRunCount")) {
    return Number(project.historyUsage?.weakRunCount || 0);
  }
  return Math.max(0, projectHistoryRunCount(project) - projectHistorySignalRunCount(project));
}

function projectHistoryEvidenceTags(project) {
  const usage = project?.historyUsage || {};
  const runCount = Number(usage.runCount || 0);
  if (runCount <= 0) {
    return [];
  }

  const signalRunCount = projectHistorySignalRunCount(project);
  const sequenceValue = signalRunCount > 0 ? projectHistorySignalLastSequence(project) : projectHistoryLastSequence(project);
  const sequence = sequenceValue == null || sequenceValue < 0 ? "hist" : `hist#${sequenceValue}`;
  const tags = [sequence, `${signalRunCount > 0 ? signalRunCount : runCount}x`];
  if (hasOwn(usage, "signalRunCount") && signalRunCount <= 0) {
    tags.push("weak↓");
  }
  return tags;
}

function planProjectHistoryRunCount(summary = {}) {
  return summary.projectHistoryRunCount ?? summary.historyRunCount ?? 0;
}

function compareProjectHistoryUsage(a, b) {
  const aRuns = projectHistorySignalRunCount(a);
  const bRuns = projectHistorySignalRunCount(b);
  const aActive = aRuns > 0 && !isLowSignalProject(a);
  const bActive = bRuns > 0 && !isLowSignalProject(b);

  if (aActive !== bActive) {
    return Number(bActive) - Number(aActive);
  }
  if (!aActive || !bActive) {
    return 0;
  }

  return projectHistorySignalLastSequence(b) - projectHistorySignalLastSequence(a) ||
    projectHistorySignalLastRunTime(b) - projectHistorySignalLastRunTime(a) ||
    bRuns - aRuns;
}

function projectHistorySignalLastSequence(project) {
  if (hasOwn(project?.historyUsage || {}, "signalLastSequence")) {
    return project.historyUsage?.signalLastSequence ?? -1;
  }
  return projectHistoryLastSequence(project);
}

function projectHistorySignalLastRunTime(project) {
  if (hasOwn(project?.historyUsage || {}, "signalLastRunAt")) {
    return Date.parse(project.historyUsage?.signalLastRunAt || "") || 0;
  }
  return projectHistoryLastRunTime(project);
}

function projectHistoryLastSequence(project) {
  return project.historyUsage?.lastSequence ?? project.capabilitySummary?.lastHistorySequence ?? -1;
}

function projectHistoryLastRunTime(project) {
  return Date.parse(project.historyUsage?.lastRunAt || project.capabilitySummary?.lastHistoryRunAt || "") || 0;
}

function isLowSignalProject(project) {
  const name = String(project.name || "").toLowerCase();
  return LOW_SIGNAL_PROJECT_NAMES.has(name) ||
    (projectCapabilityCount(project) === 0 && name.startsWith(".")) ||
    /^\.[\w.-]*(cache|tmp|temp|tools?|workspace-tools|currentspaces)[\w.-]*$/.test(name) ||
    /(^|[._-])(cache|tmp|temp|generated|coverage)([._-]|$)/.test(name);
}

function projectLowSignalInspectorLabel(project) {
  if (!isLowSignalProject(project)) {
    return "";
  }
  if (Number(project?.historyUsage?.runCount || 0) > 0) {
    return "history present but demoted (penalty)";
  }
  return "demoted (penalty)";
}

function projectScanStaleLabel(plan = {}, { now = new Date(), thresholdDays = PROJECT_SCAN_STALE_DAYS } = {}) {
  const scanGeneratedAt = plan?.scanGeneratedAt || plan?.generatedAt;
  const days = ageDaysFrom(scanGeneratedAt, now);
  if (!Number.isFinite(days) || days <= thresholdDays) {
    return "";
  }
  return `scan stale: ${wholeDaysLabel(days)} old; press r`;
}

function hasScriptCapability(project) {
  return (project.capabilities || []).some((capability) => SCRIPT_CAPABILITY_SOURCES.has(capability.source?.type));
}

function isFreshProjectActivity(project) {
  return ageDays(project.activity?.lastTouchedAt || project.modifiedAt) <= 2;
}

function isLiveProjectActivity(project) {
  return hasStrongLiveActivitySource(project) &&
    ageDays(project.activity?.lastTouchedAt || project.modifiedAt) <= PROJECT_LIVE_ACTIVITY_HOURS / 24;
}

function hasStrongLiveActivitySource(project) {
  return ["project-files", "git-commit"].includes(project?.activity?.lastTouchedSource);
}

function isRecentGitActivity(project) {
  return ageDays(projectGitLastCommitAt(project)) <= 45;
}

function hasGitSignal(project) {
  const git = project.git || {};
  return Boolean(
    project.isGit ||
    project.activity?.gitLastCommitAt ||
    git.lastCommitDate ||
    git.lastCommitHash ||
    git.branch ||
    git.remote ||
    git.dirtyTotal > 0
  );
}

function projectGitLastCommitAt(project) {
  return project.activity?.gitLastCommitAt || project.git?.lastCommitDate || "";
}

function ageDays(value) {
  return ageDaysFrom(value);
}

function ageDaysFrom(value, now = new Date()) {
  const time = Date.parse(value || "");
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now || "");
  if (!Number.isFinite(time) || !Number.isFinite(nowTime)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (nowTime - time) / 86_400_000);
}

function projectActivityTime(project) {
  const values = [
    project.activity?.lastTouchedAt,
    project.activity?.fileModifiedAt,
    project.activity?.gitLastCommitAt,
    projectGitLastCommitAt(project),
    project.modifiedAt
  ].map((value) => Date.parse(value || ""));
  return Math.max(0, ...values.filter((value) => Number.isFinite(value)));
}

function projectFreshActivityTime(project) {
  return isFreshProjectActivity(project) ? projectActivityTime(project) : 0;
}

function projectLiveActivityTime(project) {
  return isLiveProjectActivity(project) ? projectActivityTime(project) : 0;
}

function isSshConfigDevice(device) {
  return device.source?.type === "ssh-config";
}

function isHistoryOnlyDevice(device) {
  return device.source?.type === "history";
}

function isLikelyTemporaryHistoryDevice(device) {
  return isHistoryOnlyDevice(device) && isIpAddress(device.hostName || device.alias);
}

function isIpAddress(value) {
  const text = String(value || "");
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) || text.includes(":");
}

function recentSequenceScore(sequence) {
  const value = Math.max(sequence || 0, 0);
  return Math.min(value, 1_000) * 0.15;
}

function remoteCommandProjectHint(command) {
  const groups = remoteCommandProjectGroups(command);
  return [
    groups.remote.length ? `remote-project:${remoteProjectNamesLabel(groups.remote)}` : "",
    groups.local.length ? `local-cwd-project:${remoteProjectNamesLabel(groups.local)}` : "",
    groups.other.length ? `project:${remoteProjectNamesLabel(groups.other)}` : ""
  ].filter(Boolean).join(" ");
}

function canRunCapability(capability) {
  return capability?.runnable === true && Boolean(capability.execution);
}

export function capabilityRunLabel(capability) {
  if (canRunCapability(capability)) {
    return "[Run]";
  }
  if (capability?.runnable == null) {
    return "[?]";
  }
  return "[N/A]";
}

function canRunRemoteCommand(command) {
  return command?.runnable === true;
}

export function remoteCommandRunLabel(command) {
  if (canRunRemoteCommand(command)) {
    return "[Run]";
  }
  if (command?.runnable == null) {
    return "[?]";
  }
  return "[N/A]";
}

export function capabilityListCommandLabel(capability = {}) {
  return capabilityActualExecutionCommand(capability) || capability.command || "unknown";
}

export function capabilityListMetaLabels(capability = {}, project = null) {
  return capabilityMetaLabels(capability, project);
}

export function capabilityRankExplanation(capability = {}, project = null, sentSummary = null) {
  const signal = sentSummary || { count: 0, lastSentAt: null };
  const cwd = capabilityExecutionCwd(project, capability) || "unknown";
  return [
    `run:${capabilityRunLabel(capability)}`,
    `source:${capabilitySourcePriorityLabel(capability)}`,
    `usage:${capabilityUsageRankLabel(capability)}`,
    `risk:${capability.risk || "unknown"}`,
    `sent:${ghosttySentSignalLabel(signal)}`,
    `cwd:${cwd}`,
    `danger:${listLabel(capability.sideEffects)}`
  ].filter(Boolean).join(" ");
}

export function remoteCommandRankExplanation(command = {}, device = {}, sentSummary = null, {
  cwd = "",
  target = "",
  source = "",
  dangerLabel = ""
} = {}) {
  const signal = sentSummary || { count: 0, lastSentAt: null };
  const resolvedCwd = cwd || resolveRemoteExecutionCwd(command.execution?.cwd || "");
  const resolvedTarget = target || command.sshTarget || device?.target || device?.alias || "unknown";
  const danger = assessRemoteCommandDanger(command, device);
  const resolvedDanger = dangerLabel || (danger ? `${danger.level} - ${danger.reason}` : "none");
  return [
    `run:${remoteCommandRunLabel(command)}`,
    `source:${remoteCommandSourcePriorityLabel(command)}`,
    `usage:${command.count ? `${command.count}x` : "0x"}${command.lastSequence ? ` seq#${command.lastSequence}` : ""}`,
    `sent:${ghosttySentSignalLabel(signal)}`,
    `danger:${resolvedDanger}`,
    `target:${resolvedTarget}`,
    `local-cwd:${resolvedCwd}`,
    source ? `source-path:${source}` : ""
  ].filter(Boolean).join(" ");
}

export function enterCapabilityPreviewLabel(project = null, capability = null) {
  if (!project || !capability || !canRunCapability(capability)) {
    return "Enter: no runnable selection";
  }
  const cwd = capabilityExecutionCwd(project, capability) || project.path || "unknown";
  const command = capabilityActualExecutionCommand(capability) || capability.command || "unknown";
  return `Enter: project ${project.name || "workspace"} command:${shortDisplayValue(command, 72)} cwd:${compactPathLabel(cwd)}`;
}

export function enterRemotePreviewLabel(device = null, command = null, { cwd = "" } = {}) {
  if (!device || !command || !canRunRemoteCommand(command)) {
    return "Enter: no runnable selection";
  }
  const target = command.sshTarget || device.target || device.alias || "unknown";
  const fullSshCommand = command.fullSshCommand || command.command || "unknown";
  return `Enter: remote ${device.alias || target} target:${target} command:${shortDisplayValue(fullSshCommand, 72)} local cwd:${compactPathLabel(cwd || "unknown")}`;
}

function capabilityMetaLabels(capability, project = null) {
  return [
    capabilitySourceTag(capability),
    capabilityUsageTag(capability),
    capabilityCwdTag(capability, project)
  ].filter(Boolean);
}

function capabilityCwdTag(capability, project = null) {
  const cwd = capability?.execution?.cwd;
  if (!cwd || cwd === ".") {
    return "";
  }
  if (project?.path) {
    try {
      const absolute = resolveExecutionCwd(project.path, cwd);
      const relative = path.relative(path.resolve(project.path), absolute) || ".";
      return relative === "." ? "" : `cwd:${shortTag(relative)}`;
    } catch {
      return `cwd:${shortTag(cwd)}`;
    }
  }
  return `cwd:${shortTag(cwd)}`;
}

function capabilitySourceTag(capability) {
  const type = capability.source?.type;
  if (!type) {
    return capability.usage?.runCount ? "src:history" : "";
  }
  if (type === "shell-history") {
    return "src:history";
  }
  if (type === "inferred") {
    return "src:inferred";
  }
  if (type === "script-file") {
    return "src:file";
  }
  if (type === "Dockerfile") {
    return "src:docker";
  }
  if (type === "compose") {
    return "src:compose";
  }
  if (["package.json", "composer.json", "pyproject.toml"].includes(type)) {
    return "src:manifest";
  }
  if (["Makefile", "justfile", "Taskfile"].includes(type)) {
    return "src:task";
  }
  return `src:${shortTag(type)}`;
}

function capabilityUsageTag(capability) {
  const count = capability?.usage?.runCount || 0;
  return count > 0 ? `used:${count}x` : "";
}

function capabilitySourcePriorityLabel(capability) {
  const rank = sourceRank(capability);
  const tag = capabilitySourceTag(capability) || "src:unknown";
  return `${tag}/p${rank}`;
}

function capabilityUsageRankLabel(capability) {
  const usage = capability?.usage || {};
  const parts = [usage.runCount ? `${usage.runCount}x` : "0x"];
  if (usage.lastSequence) {
    parts.push(`seq#${usage.lastSequence}`);
  }
  if (usage.lastRunAt) {
    parts.push(`last ${timestampAgeLabel(usage.lastRunAt)}`);
  }
  return parts.join(" ");
}

function remoteCommandSourcePriorityLabel(command) {
  const rank = remoteCommandSourceRank(command);
  if (command?.kind === "login" && !command?.count) {
    return `ssh-config-login/p${rank}`;
  }
  if (command?.kind !== "login" && remoteCommandLocalCwdProjects(command).length) {
    return `project-history/p${rank}`;
  }
  if (command?.kind !== "login" && (command?.count || 0) > 0 && remoteCommandProjectHintProjects(command).length) {
    return `command-history+remote-hint/p${rank}`;
  }
  if (command?.kind !== "login" && (command?.count || 0) > 0) {
    return `command-history/p${rank}`;
  }
  if (command?.kind !== "login" && remoteCommandProjectHintProjects(command).length) {
    return `remote-project-hint/p${rank}`;
  }
  if (command?.kind === "login") {
    return `login-history/p${rank}`;
  }
  return `history/p${rank}`;
}

function listLabel(values) {
  return (values || []).filter(Boolean).slice(0, 2).join(", ") || "none";
}

function remoteProjectLabel(project) {
  const name = project?.name;
  if (!name) {
    return "";
  }
  const source = project.source ? shortTag(project.source) : "";
  const count = project.count ? `${project.count}x` : "";
  const basis = [source, count].filter(Boolean).join(" ");
  return basis ? `${name}(${basis})` : name;
}

export function assessManualCommandDanger(command = "") {
  const text = normalizeDangerText(command);
  for (const [pattern, reason] of MANUAL_HIGH_RISK_RULES) {
    if (pattern.test(text)) {
      return { level: "high", reason };
    }
  }
  for (const [pattern, reason] of MANUAL_MEDIUM_RISK_RULES) {
    if (pattern.test(text)) {
      return { level: "medium", reason };
    }
  }
  return null;
}

const MANUAL_HIGH_RISK_RULES = [
  [/\brm\b(?=[^\n;&|]*\s-[^\n;&|]*r)(?=[^\n;&|]*\s-[^\n;&|]*f)/i, "recursive file removal"],
  [/\bfind\b[^\n;&|]*\s-delete\b/i, "find delete"],
  [/\b(chmod|chown)\s+-R\b/i, "recursive permission/owner change"],
  [/\bgit\s+(push|tag)\b/i, "writes to git remote or tags"],
  [/\b(npm|pnpm|yarn|bun|cargo)\s+publish\b/i, "publishes package artifact"],
  [/\bdocker\b[^\n;&|]*\b(push|system\s+prune|volume\s+(prune|rm)|rm)\b/i, "container publish/remove/prune"],
  [/\bdocker\s+compose\b[^\n;&|]*\b(down|rm)\b/i, "container stack down/remove"],
  [/\b(kubectl\s+(apply|delete|scale|rollout)|helm\s+(upgrade|install|delete)|terraform\s+(apply|destroy)|wrangler\s+deploy|vercel\s+deploy|netlify\s+deploy|fly\s+deploy|serverless\s+deploy)\b/i, "changes remote infrastructure"],
  [/\bcurl\b[^\n]*(\-X\s*(POST|PUT|PATCH|DELETE)|\-\-request\s+(POST|PUT|PATCH|DELETE)|\s-d\s|--data)\b/i, "non-idempotent HTTP request"],
  [/\bredis-cli\b[^\n;&|]*\bflush(all|db)\b/i, "redis flush"],
  [/\b(drop\s+database|drop\s+table|truncate\s+table|delete\s+from|update\s+\w+\s+set)\b/i, "destructive SQL statement"],
  [/\b(pm2\s+(delete|restart|reload|stop)|systemctl\s+(restart|stop|reload|start)|service\s+\S+\s+(restart|stop|reload|start)|supervisorctl\s+(restart|stop|reload|start))\b/i, "process or service lifecycle change"],
  [/\bkill\s+-9\b/i, "force kills processes"],
  [/\b(?:reboot|shutdown)\b/i, "host reboot/shutdown"]
];

const MANUAL_MEDIUM_RISK_RULES = [
  [/\b(npm|pnpm|yarn|bun|pip|uv|composer|bundle)\s+install\b|\buv\s+sync\b/i, "installs dependencies"],
  [/\bdocker\s+(build|compose\s+up)\b/i, "builds or starts containers"],
  [/\b(curl|wget)\b/i, "uses network access"],
  [/\b(mkdir|cp|mv|touch|tee)\b/i, "writes local files"],
  [/\b(mysql|psql|sqlite3|redis-cli|mongo)\b/i, "connects to data service"]
];

function normalizeDangerText(value) {
  return String(value || "")
    .replace(/\\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function remoteProjectNamesLabel(projects = []) {
  return projects
    .map(remoteProjectLabel)
    .filter(Boolean)
    .slice(0, 2)
    .join(",");
}

function remoteCommandProjectGroups(command = {}) {
  const groups = {
    remote: [],
    local: [],
    other: []
  };
  for (const project of command.localProjects || []) {
    if (project?.source === "remote-command") {
      groups.remote.push(project);
    } else if (!project?.source || project.source === "cwd") {
      groups.local.push({ ...project, source: project?.source || "cwd" });
    } else {
      groups.other.push(project);
    }
  }
  return groups;
}

function remoteCommandContextLabel(command = {}, device = {}, { cwd = "", target = "", source = "" } = {}) {
  return [
    `remote target:${target || command.sshTarget || device?.target || device?.alias || "unknown"}`,
    `local cwd:${compactPathLabel(cwd || command.execution?.cwd || "")}`,
    source ? `source:${shortDisplayValue(source, 48)}` : "",
    remoteCommandProjectHint(command) || "project hint:none"
  ].filter(Boolean).join("  ");
}

export function assessRemoteCommandDanger(command = {}, device = null) {
  const text = normalizeRemoteDangerText([
    command?.remoteCommand,
    command?.fullSshCommand,
    command?.command,
    command?.name
  ].filter(Boolean).join(" "));
  const parsed = parseRemoteDangerSshCommand(command);

  for (const [pattern, reason] of REMOTE_DESTRUCTIVE_COMMAND_RULES) {
    if (pattern.test(text)) {
      return { level: "destructive", reason };
    }
  }

  const targetDanger = assessRemoteTargetDanger(command, device, parsed);
  if (targetDanger) {
    return targetDanger;
  }

  for (const [pattern, reason] of REMOTE_CRITICAL_COMMAND_RULES) {
    if (pattern.test(text)) {
      return { level: "critical", reason };
    }
  }

  if (command?.kind === "login") {
    return { level: "sensitive", reason: "interactive ssh login" };
  }
  return null;
}

function normalizeRemoteDangerText(value) {
  return String(value || "")
    .replace(/\\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REMOTE_DESTRUCTIVE_COMMAND_RULES = [
  [/\brm\s+(?:-[^\s;&|]*r[^\s;&|]*\s*)+/i, "recursive file removal"],
  [/\bfind\b[^\n;&|]*\s-delete\b/i, "find delete"],
  [/\bkubectl\b[^\n;&|]*\bdelete\b/i, "kubectl delete"],
  [/\bkubectl\b[^\n;&|]*\bscale\b[^\n;&|]*--replicas\s*=\s*0\b/i, "kubectl scale to zero"],
  [/\bdocker\b[^\n;&|]*\bvolume\s+(prune|rm)\b/i, "docker volume prune/remove"],
  [/\b(chmod|chown)\b/i, "permission/owner change"],
  [/\bdocker\s+compose\b[^\n;&|]*\b(down|rm)\b/i, "container stack down/remove"],
  [/\bdocker\b[^\n;&|]*\b(system\s+prune|rm)\b/i, "container remove/prune"],
  [/\bredis-cli\b[^\n;&|]*\b(flushall|flushdb)\b/i, "redis flush"],
  [/\btruncate\s+table\b/i, "truncate table"],
  [/\btruncate\b[^\n;&|]*\s-s\s+\S+/i, "file truncate"],
  [/\bdrop\s+table\b/i, "drop table"],
  [/\bpm2\s+delete\b/i, "pm2 process delete"],
  [/\b(?:mkfs(?:\.[\w.-]+)?|wipefs)\b/i, "filesystem format/wipe"],
  [/\bdd\b[^\n;&|]*\bof\s*=/i, "raw disk write"],
  [/\bdrop\s+database\b/i, "drop database"]
];

const REMOTE_CRITICAL_COMMAND_RULES = [
  [/\bsystemctl\s+(restart|stop)\b/i, "service restart/stop"],
  [/\bservice\s+\S+\s+(restart|stop)\b/i, "service restart/stop"],
  [/\bsupervisorctl\s+(restart|stop)\b/i, "supervisor process restart/stop"],
  [/\bpm2\s+(restart|reload)\b/i, "pm2 process restart"],
  [/\bkubectl\b[^\n;&|]*\brollout\s+restart\b/i, "kubectl rollout restart"],
  [/\b(?:sudo\s+)?iptables\b[^\n;&|]*(?:\s-F\b|--flush\b|\s-[ADI]\b|\s-P\b)/i, "firewall rule change"],
  [/\bufw\s+(enable|disable|allow|deny|delete|reset)\b/i, "firewall rule change"],
  [/\bkill\s+-9\b/i, "force kill process"],
  [/\b(reboot|shutdown)\b/i, "host reboot/shutdown"]
];

function parseRemoteDangerSshCommand(command = {}) {
  const value = command?.fullSshCommand || command?.command || "";
  try {
    return parseSshCommand(value) || null;
  } catch {
    return null;
  }
}

function assessRemoteTargetDanger(command = {}, device = null, parsed = null) {
  const userFields = [
    device?.user,
    parsed?.user
  ];
  const targetFields = remoteTargetDangerFields(command, device, parsed);
  const rootTargetFields = [
    ...targetFields,
    command?.fullSshCommand,
    command?.command
  ].filter(Boolean).map((value) => String(value));

  if (userFields.some((value) => String(value || "").toLowerCase() === "root") ||
      rootTargetFields.some((value) => hasRootSshTarget(value))) {
    return { level: "critical", reason: "root ssh target" };
  }
  if (targetFields.some((value) => hasProductionTargetSignal(value))) {
    return { level: "critical", reason: "production remote target" };
  }
  if (targetFields.some((value) => hasRouterTargetSignal(value))) {
    return { level: "critical", reason: "router remote target" };
  }
  return null;
}

function remoteTargetDangerFields(command = {}, device = null, parsed = null) {
  return [
    device?.alias,
    ...(device?.aliases || []),
    device?.hostName,
    device?.target,
    device?.name,
    command?.sshTarget,
    command?.target,
    command?.name,
    parsed?.target,
    parsed?.sshTarget,
    parsed?.host
  ].filter(Boolean).map((value) => String(value));
}

function hasRootSshTarget(value) {
  return /(^|[\s"'`])root@/i.test(String(value || ""));
}

function hasProductionTargetSignal(value) {
  return /(^|[-_.@])(?:prod|prd|production|realprod)(?:\d+|[-_.@]|$)/i.test(String(value || ""));
}

function hasRouterTargetSignal(value) {
  const text = String(value || "");
  return /\b(jd-router|router)\b/i.test(text) || /\b192\.168\.68\.1\b/.test(text);
}

function shortTag(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function activityAgeLabel(project, now = new Date()) {
  const activityTime = projectActivityTime(project);
  if (!activityTime) {
    return "";
  }

  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now || "");
  const deltaSeconds = Math.max(0, Math.floor(((Number.isFinite(nowTime) ? nowTime : Date.now()) - activityTime) / 1000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s`;
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h`;
  }
  return `${Math.floor(deltaHours / 24)}d`;
}

function wholeDaysLabel(days) {
  return `${Math.max(1, Math.floor(days))}d`;
}

function ghosttySentSignalLabel(summary) {
  if (!summary?.count) {
    return "never";
  }
  return `${summary.count}x last ${timestampAgeLabel(summary.lastSentAt)}`;
}

function sentTimeValue(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function sourceRank(capability) {
  const type = capability?.source?.type || "";
  if (["package.json", "composer.json", "pyproject.toml"].includes(type)) return 0;
  if (["Makefile", "justfile", "Taskfile"].includes(type)) return 1;
  if (type === "inferred") return 2;
  if (type === "script-file") return 3;
  if (type === "Dockerfile" || type === "compose") return 4;
  if (type === "shell-history") return 5;
  return 4;
}

function remoteCommandSourceRank(command = {}) {
  if (command.kind !== "login" && remoteCommandLocalCwdProjects(command).length > 0) {
    return 0;
  }
  if (command.kind !== "login" && (command.count || 0) > 0) {
    return 1;
  }
  if (command.kind !== "login" && remoteCommandProjectHintProjects(command).length > 0) {
    return 2;
  }
  if (command.kind === "login") {
    return 3;
  }
  return 4;
}

function remoteCommandLocalCwdProjects(command = {}) {
  return (command.localProjects || []).filter((project) => !project?.source || project.source === "cwd");
}

function remoteCommandProjectHintProjects(command = {}) {
  return (command.localProjects || []).filter((project) => project?.source === "remote-command");
}

function runnableRank(item) {
  if (canRunCapability(item) || canRunRemoteCommand(item)) {
    return 0;
  }
  if (item?.runnable == null) {
    return 1;
  }
  return 2;
}

function usageRank(capability) {
  return capability.usage?.runCount || 0;
}

function capabilityIntentRank(capability = {}) {
  const name = String(capability.name || "").toLowerCase();
  const command = String(capability.command || "").toLowerCase();
  const text = `${name} ${command}`;

  if (/\btui\b/.test(text)) return 0;
  if (/(^|:)(dev|start|preview)(:|$)/.test(name)) return 1;
  if (/(^|:)(test|lint|typecheck|format|prettier)(:|$)/.test(name)) return 2;
  if (/(^|:)check(:|$)/.test(name)) return 3;
  if (/(^|:)(build|compile)(:|$)/.test(name)) return 4;
  if (/(^|:)(serve|scan|plan|report)(:|$)/.test(name)) return 5;
  return 6;
}

function riskRank(risk) {
  if (risk === "low") return 0;
  if (risk === "medium") return 1;
  return 2;
}

function riskColor(risk) {
  if (risk === "high") return colors.red;
  if (risk === "medium") return colors.yellow;
  return colors.green;
}

function remoteDangerColor(level) {
  if (level === "destructive" || level === "critical") return colors.red;
  if (level === "sensitive") return colors.yellow;
  return colors.cyan;
}

function paneTitle(label, active, width) {
  const text = ` ${label} `;
  const title = active ? `${colors.inverse}${text}${RESET}` : `${colors.bold}${text}${RESET}`;
  return pad(title, width);
}

function button(label, risk) {
  const color = risk === "high" ? colors.red : colors.cyan;
  return `${color}${colors.bold}${label}${RESET}`;
}

function stylizeSelection(text, selected) {
  return selected ? `${colors.inverse}${text}${RESET}` : text;
}

function categoryLabel(category) {
  return String(category || "unknown").replace(/(^|-)([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
}

function sourceLabel(source = {}) {
  const key = source.key ? `:${source.key}` : "";
  return `${source.type || "source"} ${source.path || "unknown"}${key}`;
}

function remotePendingSnapshotRows(device = {}, command = {}, { cwd = "" } = {}) {
  const target = command?.sshTarget || device?.target || device?.alias || "unknown";
  const localCwd = cwd || command?.execution?.cwd || "";
  const projectHint = remoteCommandProjectHint(command) || "none";
  const deviceFields = [
    ["alias", device?.alias],
    ["target", device?.target || command?.sshTarget],
    ["user", device?.user],
    ["host", device?.hostName],
    ["source", pendingSourceTag(device?.source)]
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}=${value}`);

  return [
    `Remote target: ${target}`,
    `Local cwd: ${compactPathLabel(localCwd)}`,
    `Project hint: ${projectHint}`,
    `Sources: ${pendingCommandSourcesLabel(command, device)}`,
    `Device: ${deviceFields.join(" ") || "unknown"}`
  ];
}

function pendingCommandSourcesLabel(command = {}, device = {}) {
  const sources = [
    ...(command?.sources || []),
    pendingSourceTag(command?.source),
    pendingSourceTag(device?.source)
  ].filter(Boolean);
  return [...new Set(sources)].join(", ") || "unknown";
}

function pendingSourceTag(source = {}) {
  if (!source?.type) {
    return "";
  }
  return [source.type, source.path, source.key].filter(Boolean).join(":");
}

export function snapshotFieldRows(label, value, width, { maxLines = 3 } = {}) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 80));
  const lineLimit = Math.max(1, Math.floor(Number(maxLines) || 1));
  const rawPrefix = `${String(label || "Field").trim() || "Field"}: `;
  const prefix = rawPrefix.length < safeWidth ? rawPrefix : rawPrefix.slice(0, Math.max(0, safeWidth - 1));
  const prefixWidth = stripAnsi(prefix).length;
  const continuationPrefix = " ".repeat(prefixWidth);
  const valueWidth = Math.max(1, safeWidth - prefixWidth);
  const text = normalizeSnapshotFieldValue(value);
  const capacity = Math.max(1, valueWidth * lineLimit);
  const displayText = text.length > capacity ? middleEllipsize(text, capacity, valueWidth) : text;
  const chunks = snapshotFieldChunks(displayText, valueWidth, lineLimit);
  return chunks.map((chunk, index) => `${index === 0 ? prefix : continuationPrefix}${chunk}`);
}

function inlineField(label, value, width) {
  const safeWidth = Math.max(20, Math.floor(Number(width) || 80));
  const prefix = `${String(label || "Field").trim() || "Field"}: `;
  const valueWidth = Math.max(6, safeWidth - stripAnsi(prefix).length);
  return `${prefix}${middleEllipsize(normalizeSnapshotFieldValue(value), valueWidth, valueWidth)}`;
}

function compactPathLabel(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "unknown";
  }
  const home = os.homedir();
  if (text === home) {
    return "~";
  }
  if (text.startsWith(`${home}${path.sep}`)) {
    return `~${text.slice(home.length)}`;
  }
  return text;
}

function shortDisplayValue(value, maxLength = 72) {
  const text = normalizeSnapshotFieldValue(value);
  return middleEllipsize(text, Math.max(8, maxLength), Math.max(8, maxLength));
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : text;
}

function normalizeSnapshotFieldValue(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
}

function middleEllipsize(value, maxLength, chunkWidth = maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return text.slice(0, Math.max(0, maxLength - 1)) + text.slice(-1);
  }

  const marker = maxLength >= 9 ? " ... " : "...";
  if (maxLength <= marker.length) {
    return text.slice(0, 1) + text.slice(-(maxLength - 1));
  }
  const remaining = maxLength - marker.length;
  let headLength = Math.ceil(remaining / 2);
  const markerColumn = chunkWidth > 0 ? headLength % chunkWidth : 0;
  if (markerColumn > 0 && markerColumn + marker.length > chunkWidth) {
    const shiftRight = chunkWidth - markerColumn;
    headLength = headLength + shiftRight <= remaining ? headLength + shiftRight : headLength - markerColumn;
  }
  const tailLength = remaining - headLength;
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  return `${text.slice(0, headLength)}${marker}${tail}`;
}

function snapshotFieldChunks(value, chunkWidth, maxLines) {
  const chunks = [];
  let remaining = String(value || "");
  for (let index = 0; index < maxLines && remaining; index += 1) {
    chunks.push(remaining.slice(0, chunkWidth));
    remaining = remaining.slice(chunkWidth);
  }
  return chunks.length ? chunks : ["unknown"];
}

function trimToWidth(value, width) {
  const plain = stripAnsi(String(value));
  if (plain.length <= width) {
    return value;
  }
  if (width <= 1) {
    return "…".slice(0, width);
  }
  return `${plain.slice(0, width - 1)}…`;
}

function pad(value, width) {
  const extra = width - stripAnsi(value).length;
  return extra > 0 ? `${value}${" ".repeat(extra)}` : trimToWidth(value, width);
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
