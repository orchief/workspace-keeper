import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessManualCommandDanger,
  assessRemoteCommandDanger,
  buildTypedRemoteCommand,
  capabilityActualExecutionCommand,
  capabilityRankExplanation,
  capabilityListCommandLabel,
  capabilityListMetaLabels,
  compareCapabilitiesByTuiOrder,
  compareGhosttySentUsage,
  compareProjectsByActivity,
  compareRemoteCommandsByTuiOrder,
  compareRemoteDevices,
  capabilityRunLabel,
  confirmationGateAction,
  manualConfirmationToken,
  pendingConfirmationRequirement,
  parsePendingConfirmationInput,
  enterCapabilityPreviewLabel,
  enterRemotePreviewLabel,
  projectHistoryEvidenceLabel,
  projectHistoryInspectorLabel,
  projectHistoryTopCommandLabel,
  projectInspectorRows,
  projectRankExplanation,
  projectSortTags,
  remoteCommandRankExplanation,
  remoteConfirmationToken,
  remoteCommandRunLabel,
  resolveExecutionCwd,
  snapshotFieldRows,
  WorkspaceKeeperTui
} from "../src/tui.js";

const SENT_AT = "2026-06-22T01:02:03.000Z";

function capabilityFixture(name, overrides = {}) {
  return {
    name,
    command: "npm test",
    risk: "low",
    confidence: 0.5,
    runnable: true,
    ...overrides,
    source: { type: "package.json", ...(overrides.source || {}) },
    usage: { runCount: 0, lastSequence: 0, ...(overrides.usage || {}) },
    execution: { cwd: ".", ...(overrides.execution || {}) }
  };
}

function remoteCommandFixture(name, overrides = {}) {
  const command = overrides.fullSshCommand || overrides.command || `ssh app '${name}'`;
  return {
    name,
    command,
    fullSshCommand: command,
    count: 0,
    lastSequence: 0,
    runnable: true,
    ...overrides,
    execution: { cwd: os.tmpdir(), ...(overrides.execution || {}) }
  };
}

function projectFixture(name, overrides = {}) {
  const {
    capabilitySummary = {},
    capabilities = [],
    git = {},
    activity = {},
    ...rest
  } = overrides;
  return {
    name,
    path: path.join(os.tmpdir(), name),
    ...rest,
    capabilitySummary: { total: 0, historyRunCount: 0, ...capabilitySummary },
    capabilities,
    git: { dirtyTotal: 0, ...git },
    activity
  };
}

function tuiFixture({ input = "", inputFocused = false } = {}) {
  const root = os.tmpdir();
  const project = projectFixture("api", {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })]
  });
  const app = new WorkspaceKeeperTui({
    root,
    files: {
      dataDir: path.join(os.tmpdir(), "workspace-keeper-tui-test"),
      scanFile: "",
      planFile: ""
    },
    plan: {
      root,
      summary: {},
      projects: [project],
      remoteControl: { devices: [] }
    }
  });
  let runCount = 0;
  let renderCount = 0;
  app.input = input;
  app.inputFocused = inputFocused;
  app.runSelected = () => {
    runCount += 1;
  };
  app.render = () => {
    renderCount += 1;
  };
  return {
    app,
    runCount: () => runCount,
    renderCount: () => renderCount
  };
}

function sortCapabilityNames(capabilities, { projectPath, ghosttySentEvents = [] } = {}) {
  const project = { name: "project", path: projectPath || path.join(os.tmpdir(), "workspace-keeper-project") };
  return [...capabilities]
    .sort((a, b) => compareCapabilitiesByTuiOrder(a, b, { project, ghosttySentEvents }))
    .map((capability) => capability.name);
}

function sortRemoteCommandNames(commands, { root = os.tmpdir(), ghosttySentEvents = [] } = {}) {
  return [...commands]
    .sort((a, b) => compareRemoteCommandsByTuiOrder(a, b, { root, ghosttySentEvents }))
    .map((command) => command.name);
}

test("input Enter submits filter text without running the selected command", () => {
  const focused = tuiFixture({ input: "dev", inputFocused: true });
  focused.app.onInput(Buffer.from("\r"));

  assert.equal(focused.runCount(), 0);
  assert.equal(focused.app.inputFocused, false);
  assert.equal(focused.app.input, "dev");
  assert.match(focused.app.status, /Filter applied/);
  assert.equal(focused.renderCount(), 1);

  const filtered = tuiFixture({ input: "dev", inputFocused: false });
  filtered.app.onInput(Buffer.from("\r"));

  assert.equal(filtered.runCount(), 0);
  assert.equal(filtered.app.inputFocused, false);
  assert.equal(filtered.app.input, "dev");
  assert.match(filtered.app.status, /Filter applied/);
});

test("idle Enter still runs the selected command", () => {
  const idle = tuiFixture();
  idle.app.onInput(Buffer.from("\r"));

  assert.equal(idle.runCount(), 1);
  assert.equal(idle.renderCount(), 0);
});

test("r refreshes projects, history, and remote commands without leaving TUI", () => {
  const idle = tuiFixture();
  let refreshCount = 0;
  idle.app.refresh = () => {
    refreshCount += 1;
  };

  idle.app.onInput(Buffer.from("r"));
  idle.app.onInput(Buffer.from("R"));

  assert.equal(refreshCount, 2);
  assert.equal(idle.app.input, "");

  const uppercaseInput = tuiFixture();
  uppercaseInput.app.onInput(Buffer.from("G"));
  assert.equal(uppercaseInput.app.input, "G");
  assert.equal(uppercaseInput.app.inputFocused, true);

  const focused = tuiFixture({ inputFocused: true });
  focused.app.refresh = () => {
    refreshCount += 1;
  };
  focused.app.onInput(Buffer.from("r"));

  assert.equal(refreshCount, 2);
  assert.equal(focused.app.input, "r");
});

test("refresh animation status is visible and blocks stale execution", () => {
  const refreshing = tuiFixture();
  refreshing.app.refreshing = true;
  refreshing.app.status = "Refreshing projects...";

  assert.equal(refreshing.app.bottomStatusLine(), "Refreshing projects...");

  refreshing.app.onInput(Buffer.from("\r"));
  assert.equal(refreshing.runCount(), 0);
  assert.match(refreshing.app.status, /Refresh scanning projects/);

  refreshing.app.refreshing = false;
  refreshing.app.status = "Refresh complete in 1.2s";
  refreshing.app.statusPriorityUntilMs = Date.now() + 1000;
  assert.equal(refreshing.app.bottomStatusLine(), "Refresh complete in 1.2s");

  refreshing.app.statusPriorityUntilMs = 0;
  assert.match(refreshing.app.bottomStatusLine(), /Enter:/);
});

test("mouse wheel scrolls the pane under the cursor", () => {
  const wheel = tuiFixture();
  wheel.app.plan.projects = Array.from({ length: 8 }, (_, index) => projectFixture(`project-${index}`, {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture(`dev-${index}`)]
  }));
  wheel.app.layout = { leftWidth: 42, rightStart: 46 };
  wheel.app.focus = "capabilities";
  wheel.app.selectedProjectIndex = 0;

  wheel.app.onInput(Buffer.from("\x1b[<65;10;8M"));
  assert.equal(wheel.app.focus, "projects");
  assert.equal(wheel.app.selectedProjectIndex, 3);

  wheel.app.onInput(Buffer.from("\x1b[<64;10;8M"));
  assert.equal(wheel.app.selectedProjectIndex, 0);

  wheel.app.plan.projects[0].capabilities = Array.from({ length: 8 }, (_, index) => capabilityFixture(`capability-${index}`));
  wheel.app.plan.projects[0].capabilitySummary = { total: 8, historyRunCount: 0 };
  wheel.app.selectedProjectIndex = 0;
  wheel.app.selectedCapabilityIndex = 0;
  wheel.app.onInput(Buffer.from("\x1b[<65;60;8M"));
  assert.equal(wheel.app.focus, "capabilities");
  assert.equal(wheel.app.selectedCapabilityIndex, 3);
});

test("resolveExecutionCwd allows project-local cwd values", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-project");

  assert.equal(resolveExecutionCwd(projectPath), path.resolve(projectPath));
  assert.equal(resolveExecutionCwd(projectPath, "."), path.resolve(projectPath));
  assert.equal(resolveExecutionCwd(projectPath, "packages/api"), path.resolve(projectPath, "packages/api"));
});

test("resolveExecutionCwd rejects cwd values escaping the project", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-project");

  assert.throws(() => resolveExecutionCwd(projectPath, ".."), /escapes project path/);
  assert.throws(() => resolveExecutionCwd(projectPath, "../workspace-keeper-project-other"), /escapes project path/);
});

test("capabilityActualExecutionCommand uses structured execution without leading cd", () => {
  const packageScript = capabilityFixture("api-dev", {
    command: "cd 'packages/api' && npm run dev",
    execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] }
  });
  const subdirScript = capabilityFixture("foo", {
    command: "cd tools && ./foo.sh",
    execution: { cwd: "tools", command: "sh", args: ["foo.sh"] }
  });

  assert.equal(capabilityActualExecutionCommand(packageScript), "npm run dev");
  assert.equal(packageScript.command, "cd 'packages/api' && npm run dev");
  assert.equal(capabilityActualExecutionCommand(subdirScript), "sh foo.sh");
  assert.equal(subdirScript.command, "cd tools && ./foo.sh");
});

test("capabilityActualExecutionCommand falls back to legacy command without execution command", () => {
  const capability = capabilityFixture("legacy", {
    command: "cd tools && ./foo.sh",
    execution: { cwd: "tools" }
  });

  assert.equal(capabilityActualExecutionCommand(capability), "cd tools && ./foo.sh");
});

test("capability list display uses actual execution command and cwd metadata", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-list-display");
  const project = { name: "project", path: projectPath };
  const capability = capabilityFixture("api-dev", {
    command: "cd 'packages/api' && npm run dev",
    execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] }
  });

  assert.equal(capabilityListCommandLabel(capability), "npm run dev");
  assert.equal(capabilityListCommandLabel(capability).includes("cd 'packages/api'"), false);
  assert.deepEqual(capabilityListMetaLabels(capability, project), ["src:manifest", "cwd:packages/api"]);
});

test("capabilityRunLabel has runnable, unknown, and unavailable states", () => {
  assert.equal(capabilityRunLabel({
    runnable: true,
    execution: { cwd: "." }
  }), "[Run]");
  assert.equal(capabilityRunLabel({}), "[?]");
  assert.equal(capabilityRunLabel({ runnable: false }), "[N/A]");
});

test("remoteCommandRunLabel has runnable, unknown, and unavailable states", () => {
  assert.equal(remoteCommandRunLabel({ runnable: true }), "[Run]");
  assert.equal(remoteCommandRunLabel({}), "[?]");
  assert.equal(remoteCommandRunLabel({ runnable: false }), "[N/A]");
});

test("confirmationGateAction preserves manual, remote, and capability decisions", () => {
  assert.equal(confirmationGateAction({ type: "manual" }), "pending");
  assert.equal(confirmationGateAction({ type: "remote" }), "pending");
  assert.equal(confirmationGateAction({ type: "capability", risk: "high" }), "pending");

  assert.equal(confirmationGateAction({ type: "capability", risk: "medium" }), "direct");
  assert.equal(confirmationGateAction({ type: "capability", risk: "low" }), "direct");
  assert.equal(confirmationGateAction({ type: "capability" }), "direct");
  assert.equal(confirmationGateAction({ type: "unknown", risk: "high" }), "direct");

  assert.equal(confirmationGateAction({ type: "manual", confirmed: true }), "direct");
  assert.equal(confirmationGateAction({ type: "remote", confirmed: true }), "direct");
  assert.equal(confirmationGateAction({ type: "capability", risk: "high", confirmed: true }), "direct");
});

test("parsePendingConfirmationInput maps confirm, cancel, and locked keys", () => {
  assert.equal(parsePendingConfirmationInput("y"), "confirm");
  assert.equal(parsePendingConfirmationInput("Y"), "confirm");

  assert.equal(parsePendingConfirmationInput("n"), "cancel");
  assert.equal(parsePendingConfirmationInput("N"), "cancel");
  assert.equal(parsePendingConfirmationInput("\x1b"), "cancel");

  assert.equal(parsePendingConfirmationInput("a"), "locked");
  assert.equal(parsePendingConfirmationInput("\r"), "locked");
  assert.equal(parsePendingConfirmationInput("\x1b[A"), "locked");
  assert.equal(parsePendingConfirmationInput(""), "locked");
});

test("parsePendingConfirmationInput enforces exact token for critical remote pending", () => {
  const command = remoteCommandFixture("restart", {
    command: "ssh prod01 uptime",
    sshTarget: "prod01"
  });
  const pending = {
    type: "remote",
    command,
    device: { alias: "prod01", target: "prod01", user: "deploy" }
  };
  const requirement = pendingConfirmationRequirement(pending);

  assert.deepEqual(requirement, {
    type: "token",
    token: "RUN REMOTE prod01/restart",
    level: "critical",
    reason: "production remote target",
    label: "remote critical risk"
  });
  assert.equal(remoteConfirmationToken(command, pending.device), "RUN REMOTE prod01/restart");
  assert.equal(parsePendingConfirmationInput("y", requirement), "locked");
  assert.equal(parsePendingConfirmationInput("RUN REMOTE prod01/restart", requirement), "confirm");
  assert.equal(parsePendingConfirmationInput("RUN REMOTE prod01/wrong", requirement), "locked");
  assert.equal(parsePendingConfirmationInput("n", requirement), "cancel");
  assert.equal(parsePendingConfirmationInput("\x1b", requirement), "cancel");
});

test("parsePendingConfirmationInput keeps y confirmation for low remote pending", () => {
  const pending = {
    type: "remote",
    command: remoteCommandFixture("uptime", {
      command: "ssh app uptime",
      sshTarget: "app"
    }),
    device: { alias: "app", target: "app", user: "deploy" }
  };
  const requirement = pendingConfirmationRequirement(pending);

  assert.deepEqual(requirement, { type: "simple" });
  assert.equal(parsePendingConfirmationInput("y", requirement), "confirm");
  assert.equal(parsePendingConfirmationInput("n", requirement), "cancel");
  assert.equal(parsePendingConfirmationInput("\x1b", requirement), "cancel");
});

test("manual typed local commands require an exact token instead of y", () => {
  const manual = {
    target: "api",
    label: "api: rm -rf dist",
    command: "rm -rf dist",
    cwd: path.join(os.tmpdir(), "api")
  };
  const pending = { type: "manual", manual };
  const requirement = pendingConfirmationRequirement(pending);

  assert.equal(manualConfirmationToken(manual), "RUN LOCAL api");
  assert.deepEqual(requirement, {
    type: "token",
    token: "RUN LOCAL api",
    level: "typed",
    reason: "typed local command",
    label: "typed local command"
  });
  assert.equal(parsePendingConfirmationInput("y", requirement), "locked");
  assert.equal(parsePendingConfirmationInput("RUN LOCAL api", requirement), "confirm");
  assert.equal(parsePendingConfirmationInput("RUN LOCAL other", requirement), "locked");
  assert.equal(parsePendingConfirmationInput("n", requirement), "cancel");
});

test("snapshotFieldRows wraps long commands and preserves the tail", () => {
  const command = "ssh app 'cd /srv/workspace/current && export RELEASE_SHA=0123456789abcdef0123456789abcdef0123456789abcdef && npm run migrate:status -- --tenant=critical-prod'";
  const rows = snapshotFieldRows("Command", command, 42, { maxLines: 4 });

  assert.equal(rows.length <= 4, true);
  for (const row of rows) {
    assert.equal(row.length <= 42, true, row);
  }
  assert.match(rows[0], /^Command: ssh app/);
  assert.match(rows.join("\n"), /\.\.\./);
  assert.equal(rows.at(-1).endsWith("--tenant=critical-prod'"), true);
});

test("assessManualCommandDanger classifies typed local command risk", () => {
  assert.deepEqual(assessManualCommandDanger("rm -rf dist"), {
    level: "high",
    reason: "recursive file removal"
  });
  assert.deepEqual(assessManualCommandDanger("npm install"), {
    level: "medium",
    reason: "installs dependencies"
  });
  assert.equal(assessManualCommandDanger("npm test"), null);
});

test("assessRemoteCommandDanger detects high-risk remote commands", () => {
  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh prod 'rm -rf /var/www/app'"
  }), {
    level: "destructive",
    reason: "recursive file removal"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    remoteCommand: "systemctl restart nginx"
  }), {
    level: "critical",
    reason: "service restart/stop"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    command: "docker compose down"
  }), {
    level: "destructive",
    reason: "container stack down/remove"
  });
});

test("assessRemoteCommandDanger detects extended destructive remote commands", () => {
  const cases = [
    ["ssh app 'rm -fr /tmp/workspace-keeper-demo'", "recursive file removal"],
    ["ssh app 'rm -r /tmp/workspace-keeper-demo'", "recursive file removal"],
    ["ssh app 'find /tmp/workspace-keeper-demo -type f -delete'", "find delete"],
    ["ssh app 'kubectl delete deployment api'", "kubectl delete"],
    ["ssh app 'kubectl scale deployment api --replicas=0'", "kubectl scale to zero"],
    ["ssh app 'docker volume prune -f'", "docker volume prune/remove"],
    ["ssh app 'docker volume rm app-data'", "docker volume prune/remove"],
    ["ssh app 'redis-cli flushall'", "redis flush"],
    ["ssh app 'redis-cli flushdb'", "redis flush"],
    ["ssh app 'truncate table users'", "truncate table"],
    ["ssh app 'truncate -s 0 /var/log/app.log'", "file truncate"],
    ["ssh app 'drop table users'", "drop table"],
    ["ssh app 'pm2 delete api'", "pm2 process delete"],
    ["ssh app 'mkfs.ext4 /dev/sdb1'", "filesystem format/wipe"],
    ["ssh app 'wipefs -a /dev/sdb'", "filesystem format/wipe"],
    ["ssh app 'dd if=/tmp/image.raw of=/dev/sdb bs=4M'", "raw disk write"]
  ];

  for (const [fullSshCommand, reason] of cases) {
    assert.deepEqual(assessRemoteCommandDanger({ fullSshCommand }), {
      level: "destructive",
      reason
    }, fullSshCommand);
  }
});

test("assessRemoteCommandDanger detects extended critical restart commands", () => {
  const cases = [
    ["ssh app 'systemctl restart nginx'", "service restart/stop"],
    ["ssh app 'service nginx restart'", "service restart/stop"],
    ["ssh app 'supervisorctl restart api:*'", "supervisor process restart/stop"],
    ["ssh app 'pm2 restart api'", "pm2 process restart"],
    ["ssh app 'kubectl rollout restart deployment/api'", "kubectl rollout restart"],
    ["ssh app 'sudo iptables -F'", "firewall rule change"],
    ["ssh app 'ufw deny 22'", "firewall rule change"],
    ["ssh app 'kill -9 1234'", "force kill process"]
  ];

  for (const [fullSshCommand, reason] of cases) {
    assert.deepEqual(assessRemoteCommandDanger({ fullSshCommand }), {
      level: "critical",
      reason
    }, fullSshCommand);
  }
});

test("assessRemoteCommandDanger detects remote target risk with device context", () => {
  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh app uptime",
    sshTarget: "app"
  }, {
    alias: "app",
    target: "app",
    user: "root"
  }), {
    level: "critical",
    reason: "root ssh target"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh root@test.ely.work uptime"
  }), {
    level: "critical",
    reason: "root ssh target"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh app uptime",
    sshTarget: "app"
  }, {
    alias: "prod01",
    hostName: "prod01.internal",
    target: "deploy@prod01.internal"
  }), {
    level: "critical",
    reason: "production remote target"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh router uptime",
    sshTarget: "router"
  }, {
    alias: "router",
    hostName: "router.local",
    user: "admin",
    target: "admin@router.local"
  }), {
    level: "critical",
    reason: "router remote target"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh app",
    kind: "login"
  }, {
    alias: "app",
    target: "app",
    user: "deploy"
  }), {
    level: "sensitive",
    reason: "interactive ssh login"
  });

  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh prod01",
    kind: "login"
  }, {
    alias: "prod01",
    target: "prod01",
    user: "deploy"
  }), {
    level: "critical",
    reason: "production remote target"
  });

  for (const target of ["prod01", "realprod01", "prd-api", "prod-db-1"]) {
    assert.deepEqual(assessRemoteCommandDanger({
      fullSshCommand: `ssh ${target} uptime`,
      sshTarget: target
    }), {
      level: "critical",
      reason: "production remote target"
    }, target);
  }

  assert.equal(assessRemoteCommandDanger({
    fullSshCommand: "ssh product-api uptime",
    sshTarget: "product-api"
  }), null);
});

test("assessRemoteCommandDanger keeps destructive command priority over target risk", () => {
  assert.deepEqual(assessRemoteCommandDanger({
    fullSshCommand: "ssh root@1.2.3.4 'rm -rf /tmp/demo'"
  }), {
    level: "destructive",
    reason: "recursive file removal"
  });
});

test("assessRemoteCommandDanger does not flag ordinary ssh commands", () => {
  assert.equal(assessRemoteCommandDanger({
    fullSshCommand: "ssh app-server uptime"
  }), null);
  assert.equal(assessRemoteCommandDanger({
    fullSshCommand: "ssh app 'grep production /tmp/app.log'",
    sshTarget: "app"
  }, {
    alias: "app",
    target: "app",
    user: "deploy"
  }), null);
});

test("buildTypedRemoteCommand rejects plain remote input even with a selected device", () => {
  const device = {
    alias: "app",
    hostName: "app.internal",
    user: "deploy",
    target: "deploy@app.internal",
    source: { type: "ssh-config" }
  };
  const typed = buildTypedRemoteCommand("uptime", device, { cwd: os.tmpdir() });

  assert.equal(typed, null);
});

test("buildTypedRemoteCommand does not wrap plain input for history root IP devices", () => {
  const device = {
    alias: "123.57.248.9",
    hostName: "123.57.248.9",
    user: "root",
    target: "root@123.57.248.9",
    source: { type: "history" }
  };
  const typed = buildTypedRemoteCommand("uptime", device, { cwd: os.tmpdir() });

  assert.equal(typed, null);
});

test("buildTypedRemoteCommand creates remote pending context for full ssh input", () => {
  const typed = buildTypedRemoteCommand("ssh root@1.2.3.4 uptime", null, { cwd: os.tmpdir() });

  assert.equal(typed.device.alias, "root@1.2.3.4");
  assert.equal(typed.device.user, "root");
  assert.equal(typed.command.fullSshCommand, "ssh root@1.2.3.4 uptime");
  assert.equal(typed.command.sshTarget, "root@1.2.3.4");
  assert.equal(typed.command.remoteCommand, "uptime");
  assert.equal(typed.command.name, "uptime");
  assert.deepEqual(assessRemoteCommandDanger(typed.command, typed.device), {
    level: "critical",
    reason: "root ssh target"
  });
});

test("buildTypedRemoteCommand inherits matching ssh-config device for danger assessment", () => {
  const device = {
    alias: "prod",
    aliases: ["prod"],
    hostName: "prod01.internal",
    user: "root",
    target: "root@prod01.internal:22",
    source: { type: "ssh-config" }
  };
  const typed = buildTypedRemoteCommand("ssh prod uptime", device, { cwd: os.tmpdir() });

  assert.equal(typed.device, device);
  assert.equal(typed.command.sshTarget, "prod");
  assert.deepEqual(assessRemoteCommandDanger(typed.command, typed.device), {
    level: "critical",
    reason: "root ssh target"
  });
  assert.equal(pendingConfirmationRequirement({
    type: "remote",
    command: typed.command,
    device: typed.device
  }).type, "token");
});

test("buildTypedRemoteCommand does not inherit non-matching selected remote device", () => {
  const device = {
    alias: "prod",
    aliases: ["prod"],
    hostName: "prod01.internal",
    user: "root",
    target: "root@prod01.internal:22",
    source: { type: "ssh-config" }
  };
  const typed = buildTypedRemoteCommand("ssh staging uptime", device, { cwd: os.tmpdir() });

  assert.notEqual(typed.device, device);
  assert.equal(typed.device.alias, "staging");
  assert.equal(typed.device.source.type, "typed-input");
  assert.equal(assessRemoteCommandDanger(typed.command, typed.device), null);
});

test("buildTypedRemoteCommand resolves matching ssh-config device from all remote devices", () => {
  const selected = {
    alias: "app",
    hostName: "app.internal",
    user: "deploy",
    target: "deploy@app.internal:22",
    source: { type: "ssh-config" }
  };
  const db = {
    alias: "db",
    aliases: ["db"],
    hostName: "prod-db.internal",
    user: "root",
    target: "root@prod-db.internal:22",
    source: { type: "ssh-config" }
  };
  const typed = buildTypedRemoteCommand("ssh db uptime", selected, {
    cwd: os.tmpdir(),
    devices: [selected, db]
  });

  assert.equal(typed.device, db);
  assert.deepEqual(assessRemoteCommandDanger(typed.command, typed.device), {
    level: "critical",
    reason: "root ssh target"
  });
  assert.equal(pendingConfirmationRequirement({
    type: "remote",
    command: typed.command,
    device: typed.device
  }).type, "token");
});

test("buildTypedRemoteCommand does not inherit ambiguous ssh-config device matches", () => {
  const selected = {
    alias: "app",
    hostName: "app.internal",
    user: "deploy",
    target: "deploy@app.internal:22",
    source: { type: "ssh-config" }
  };
  const firstDb = {
    alias: "db",
    hostName: "prod-db-1.internal",
    user: "deploy",
    target: "deploy@prod-db-1.internal:22",
    source: { type: "ssh-config" }
  };
  const secondDb = {
    alias: "db",
    hostName: "prod-db-2.internal",
    user: "deploy",
    target: "deploy@prod-db-2.internal:22",
    source: { type: "ssh-config" }
  };
  const typed = buildTypedRemoteCommand("ssh db uptime", selected, {
    cwd: os.tmpdir(),
    devices: [selected, firstDb, secondDb]
  });

  assert.notEqual(typed.device, firstDb);
  assert.notEqual(typed.device, secondDb);
  assert.equal(typed.device.source.type, "typed-input");
});

test("project history usage sorts strongly within the same project signal tier", () => {
  const used = projectFixture("used", {
    historyUsage: { runCount: 3, lastSequence: 200, lastRunAt: "2026-06-22T01:00:00.000Z" },
    capabilitySummary: { total: 1 }
  });
  const unusedAndLarge = projectFixture("unused-large", {
    capabilitySummary: { total: 120 },
    git: { dirtyTotal: 900 }
  });

  assert.deepEqual([unusedAndLarge, used]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["used", "unused-large"]);
});

test("project signal tier prevents directory history from outranking script projects", () => {
  const directoryHistory = projectFixture("directory-history", {
    historyUsage: { runCount: 40, lastSequence: 215, lastRunAt: "2026-06-21T10:15:51.000Z" },
    capabilitySummary: { total: 0 },
    activity: { lastTouchedAt: "2026-06-16T07:09:01.777Z" }
  });
  const scriptProject = projectFixture("script-project", {
    capabilitySummary: { total: 2 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-21T22:05:28.416Z" }
  });

  assert.deepEqual([directoryHistory, scriptProject]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["script-project", "directory-history"]);
});

test("project sorting uses history recency then run count when both projects have usage", () => {
  const frequent = projectFixture("frequent", {
    historyUsage: { runCount: 4, lastSequence: 10, lastRunAt: "2026-06-22T00:10:00.000Z" }
  });
  const recent = projectFixture("recent", {
    historyUsage: { runCount: 2, lastSequence: 200, lastRunAt: "2026-06-22T01:00:00.000Z" }
  });
  const sameSequenceFrequent = projectFixture("same-sequence-frequent", {
    historyUsage: { runCount: 5, lastSequence: 200, lastRunAt: "2026-06-22T01:00:00.000Z" }
  });

  assert.deepEqual([recent, frequent]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["recent", "frequent"]);
  assert.deepEqual([recent, sameSequenceFrequent]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["same-sequence-frequent", "recent"]);
});

test("project sorting treats weak history as display evidence instead of strong activity", () => {
  const weakRecent = projectFixture("weak-recent", {
    historyUsage: {
      runCount: 4,
      commandCount: 4,
      signalRunCount: 0,
      signalCommandCount: 0,
      weakRunCount: 4,
      lastSequence: 400,
      lastRunAt: "2026-06-22T01:00:00.000Z"
    },
    capabilitySummary: { total: 2 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-20T00:00:00.000Z" }
  });
  const strongOlder = projectFixture("strong-older", {
    historyUsage: {
      runCount: 1,
      commandCount: 1,
      signalRunCount: 1,
      signalCommandCount: 1,
      weakRunCount: 0,
      signalLastSequence: 200,
      signalLastRunAt: "2026-06-21T23:00:00.000Z",
      lastSequence: 200,
      lastRunAt: "2026-06-21T23:00:00.000Z"
    },
    capabilitySummary: { total: 2 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-20T00:00:00.000Z" }
  });

  assert.deepEqual([weakRecent, strongOlder]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["strong-older", "weak-recent"]);
  assert.equal(projectSortTags(weakRecent).includes("weak↓"), true);
  assert.match(projectHistoryInspectorLabel(weakRecent, { scanGeneratedAt: "2026-06-22T01:00:00.000Z" }), /low-value/);
});

test("weak history does not outrank fresh project activity within the same signal tier", () => {
  const weakHistory = projectFixture("weak-history", {
    historyUsage: {
      runCount: 1,
      commandCount: 1,
      signalRunCount: 0,
      weakRunCount: 1,
      lastSequence: 999,
      lastRunAt: "2026-06-22T01:00:00.000Z"
    },
    capabilitySummary: { total: 10 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-20T00:00:00.000Z" }
  });
  const touched = projectFixture("touched", {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: {
      lastTouchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      lastTouchedSource: "project-files"
    }
  });

  assert.deepEqual([weakHistory, touched]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["touched", "weak-history"]);
});

test("project sorting keeps dirty and capability fallback when no history usage exists", () => {
  const dirty = projectFixture("dirty", {
    capabilitySummary: { total: 1 },
    git: { dirtyTotal: 5 }
  });
  const clean = projectFixture("clean", {
    capabilitySummary: { total: 1 },
    git: { dirtyTotal: 0 }
  });
  const capabilityHeavy = projectFixture("capability-heavy", {
    capabilitySummary: { total: 3 }
  });
  const empty = projectFixture("empty", {
    capabilitySummary: { total: 0 }
  });

  assert.deepEqual([clean, dirty]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["dirty", "clean"]);
	  assert.deepEqual([empty, capabilityHeavy]
	    .sort(compareProjectsByActivity)
	    .map((project) => project.name), ["capability-heavy", "empty"]);
	});

test("project fallback sorting prefers recent activity over capability volume within the same signal tier", () => {
  const oldHeavy = projectFixture("old-heavy", {
    capabilitySummary: { total: 120 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-01T00:00:00.000Z" }
  });
  const recentSmall = projectFixture("recent-small", {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-22T00:00:00.000Z" }
  });
  const historyUsed = projectFixture("history-used", {
    historyUsage: { runCount: 1, lastSequence: 50, lastRunAt: "2026-06-22T01:00:00.000Z" },
    capabilitySummary: { total: 0 },
    activity: { lastTouchedAt: "2026-06-01T00:00:00.000Z" }
  });

  assert.deepEqual([oldHeavy, recentSmall]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["recent-small", "old-heavy"]);
  assert.deepEqual([oldHeavy, recentSmall, historyUsed]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["recent-small", "old-heavy", "history-used"]);
});

test("project fallback sorting ignores activity older than the fresh window", () => {
  const freshSmall = projectFixture("fresh-small", {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: {
      lastTouchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastTouchedSource: "project-files"
    }
  });
  const oldMedium = projectFixture("old-medium", {
    capabilitySummary: { total: 20 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() }
  });
  const olderHeavy = projectFixture("older-heavy", {
    capabilitySummary: { total: 100 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: "2026-06-01T00:00:00.000Z" }
  });

  assert.deepEqual([olderHeavy, freshSmall, oldMedium]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["fresh-small", "older-heavy", "old-medium"]);
  assert.equal(projectSortTags(oldMedium).includes("touched"), false);
  assert.equal(projectSortTags(freshSmall).includes("active"), true);
});

test("project live activity outranks history within the same signal tier", () => {
  const liveScript = projectFixture("live-script", {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: {
      lastTouchedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lastTouchedSource: "project-files"
    }
  });
  const historyScript = projectFixture("history-script", {
    historyUsage: { runCount: 5, lastSequence: 300, lastRunAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    capabilitySummary: { total: 10 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: { lastTouchedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() }
  });

  assert.deepEqual([historyScript, liveScript]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["live-script", "history-script"]);
  assert.equal(projectSortTags(liveScript).includes("active"), true);
  assert.equal(projectSortTags(historyScript).includes("active"), false);
});

test("project live activity ignores root directory mtime when history is stronger", () => {
  const rootOnly = projectFixture("root-only", {
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    activity: {
      lastTouchedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lastTouchedSource: "project-dir"
    }
  });
  const historyScript = projectFixture("history-script", {
    historyUsage: { runCount: 2, lastSequence: 90, lastRunAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: {
      lastTouchedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      lastTouchedSource: "project-files"
    }
  });

  assert.deepEqual([rootOnly, historyScript]
    .sort(compareProjectsByActivity)
    .map((project) => project.name), ["history-script", "root-only"]);
  assert.equal(projectSortTags(rootOnly).includes("active"), false);
  assert.equal(projectSortTags(rootOnly).includes("touched"), true);
});

test("capability sorting keeps runnable candidates ahead of unknown and unavailable entries", () => {
  const runnable = capabilityFixture("z-run", {
    runnable: true,
    execution: { cwd: ".", command: "npm", args: ["run", "build"] },
    source: { type: "script-file" },
    confidence: 1
  });
  const unknown = capabilityFixture("a-unknown", {
    runnable: undefined,
    execution: null,
    source: { type: "shell-history" },
    usage: { runCount: 5 },
    risk: "low",
    confidence: 99
  });
  const unavailableAction = capabilityFixture("b-action", {
    runnable: false,
    execution: null,
    command: "GitHub Actions workflow: CI",
    source: { type: "github-actions" },
    risk: "low",
    confidence: 99
  });
  const unavailableSql = capabilityFixture("c-sql", {
    runnable: false,
    execution: null,
    command: "./scripts/truncate.sql",
    source: { type: "script-file" },
    risk: "high",
    confidence: 99
  });

  assert.deepEqual(sortCapabilityNames([
    unavailableAction,
    unknown,
    unavailableSql,
    runnable
  ]), ["z-run", "a-unknown", "c-sql", "b-action"]);
});

test("capability sorting uses source quality before raw usage", () => {
  const manifest = capabilityFixture("manifest", {
    source: { type: "package.json" },
    command: "npm run test"
  });
  const task = capabilityFixture("task", {
    source: { type: "Makefile" },
    command: "make test"
  });
  const inferred = capabilityFixture("inferred", {
    source: { type: "inferred" },
    command: "uv run pytest"
  });
  const file = capabilityFixture("file", {
    source: { type: "script-file" },
    command: "python model_test_helper.py"
  });
  const compose = capabilityFixture("compose", {
    source: { type: "compose" },
    command: "docker compose up"
  });
  const history = capabilityFixture("history", {
    source: { type: "shell-history" },
    command: "uv run one-off-debug",
    usage: { runCount: 10, lastSequence: 99 }
  });

  assert.deepEqual(sortCapabilityNames([
    history,
    compose,
    file,
    inferred,
    task,
    manifest
  ]), ["manifest", "task", "inferred", "file", "compose", "history"]);
});

test("capability usage boosts within the same source tier without crossing source quality", () => {
  const manifestUsed = capabilityFixture("manifest-used", {
    source: { type: "package.json" },
    command: "npm run test",
    usage: { runCount: 3, lastSequence: 20 }
  });
  const manifestFresh = capabilityFixture("manifest-fresh", {
    source: { type: "package.json" },
    command: "npm run build",
    usage: { runCount: 0, lastSequence: 0 }
  });
  const historyUsed = capabilityFixture("history-used", {
    source: { type: "shell-history" },
    command: "npm run one-off",
    usage: { runCount: 30, lastSequence: 100 }
  });

  assert.deepEqual(sortCapabilityNames([
    manifestFresh,
    historyUsed,
    manifestUsed
  ]), ["manifest-used", "manifest-fresh", "history-used"]);
});

test("capability intent priority promotes primary entrypoints only after stronger signals tie", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-capability-intent");
  const capabilities = [
    capabilityFixture("ghostty:check", { command: "npm run ghostty:check" }),
    capabilityFixture("plan", { command: "npm run plan" }),
    capabilityFixture("tui", { command: "npm run tui" }),
    capabilityFixture("test", { command: "npm test" })
  ];

  assert.deepEqual(sortCapabilityNames(capabilities, { projectPath }), ["tui", "test", "ghostty:check", "plan"]);

  const usedPlan = capabilityFixture("plan", {
    command: "npm run plan",
    usage: { runCount: 1, lastSequence: 1 }
  });
  assert.deepEqual(sortCapabilityNames([capabilityFixture("tui", { command: "npm run tui" }), usedPlan], {
    projectPath
  }), ["plan", "tui"]);
});

test("capability list source labels distinguish manifest, task, inferred, file, docker, compose, and history", () => {
  const cases = [
    ["package.json", "src:manifest"],
    ["pyproject.toml", "src:manifest"],
    ["Makefile", "src:task"],
    ["justfile", "src:task"],
    ["Taskfile", "src:task"],
    ["inferred", "src:inferred"],
    ["script-file", "src:file"],
    ["Dockerfile", "src:docker"],
    ["compose", "src:compose"],
    ["shell-history", "src:history"]
  ];

  for (const [type, label] of cases) {
    const capability = capabilityFixture(type, {
      source: { type },
      usage: type === "shell-history" ? { runCount: 2 } : { runCount: 0 }
    });
    assert.equal(capabilityListMetaLabels(capability).includes(label), true, type);
  }

  const used = capabilityFixture("used", {
    source: { type: "package.json" },
    usage: { runCount: 4 }
  });
  assert.equal(capabilityListMetaLabels(used).includes("used:4x"), true);
});

test("project sort tags expose history evidence and no longer use recent", () => {
  const used = projectFixture("used", {
    historyUsage: { runCount: 3, commandCount: 2, lastSequence: 42, lastRunAt: "2026-06-22T01:00:00.000Z" },
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("build", { source: { type: "package.json" } })],
    activity: {
      lastTouchedAt: "2999-01-01T00:00:00.000Z",
      lastTouchedSource: "project-files"
    }
  });

  const tags = projectSortTags(used);

  assert.equal(projectHistoryEvidenceLabel(used), "hist#42 3x");
  assert.equal(tags.includes("hist#42"), true);
  assert.equal(tags.includes("3x"), true);
  assert.equal(tags.includes("active"), true);
  assert.equal(tags.includes("recent"), false);
});

test("project inspector distinguishes history none, unavailable, and stale scan", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");
  const freshPlan = { scanGeneratedAt: "2026-06-22T11:00:00.000Z" };
  const stalePlan = { scanGeneratedAt: "2026-06-01T00:00:00.000Z" };
  const none = projectFixture("none", {
    historyUsage: { runCount: 0, commandCount: 0 }
  });
  const unavailable = projectFixture("unavailable");
  const stale = projectFixture("stale", {
    historyUsage: { runCount: 0, commandCount: 0 }
  });

  assert.match(projectHistoryInspectorLabel(none, freshPlan, { now }), /none recorded/);
  assert.match(projectHistoryInspectorLabel(unavailable, freshPlan, { now }), /unavailable; press r to rescan/);

  const staleHistory = projectHistoryInspectorLabel(stale, stalePlan, { now });
  assert.match(staleHistory, /none recorded/);
  assert.match(staleHistory, /scan stale: 21d old; press r/);
});

test("project inspector explains history evidence and low-signal demotion", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");
  const plan = { scanGeneratedAt: "2026-06-22T11:00:00.000Z" };
  const lowHistory = projectFixture(".cache", {
    historyUsage: { runCount: 2, commandCount: 2, lastSequence: 9, lastRunAt: "2026-06-22T10:00:00.000Z" },
    capabilitySummary: { total: 1 },
    capabilities: [capabilityFixture("test")]
  });

  const tags = projectSortTags(lowHistory);
  const rows = projectInspectorRows(lowHistory, plan, { now });
  const text = rows.join("\n");

  assert.equal(tags.includes("low↓"), true);
  assert.equal(tags.includes("hist#9"), true);
  assert.equal(tags.includes("2x"), true);
  assert.match(text, /history: hist#9 2x last 2026-06-22 10:00Z \(2h ago\)/);
  assert.match(text, /low-signal: history present but demoted \(penalty\)/);
  assert.match(text, /rank: tags scripts hist#9 2x low↓/);
  assert.match(text, /history hist#9 2x last 2026-06-22 10:00Z \(2h ago\)/);
  assert.match(text, /low-signal history present but demoted \(penalty\)/);
});

test("project inspector exposes the top history command behind ranking", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");
  const plan = { scanGeneratedAt: "2026-06-22T11:00:00.000Z" };
  const project = projectFixture("api", {
    historyUsage: {
      runCount: 4,
      commandCount: 2,
      lastSequence: 88,
      lastRunAt: "2026-06-22T11:30:00.000Z",
      topCommands: [{
        command: "npm run dev -- --host 0.0.0.0",
        count: 3,
        lastSequence: 88,
        relativeDir: "packages/api"
      }]
    },
    capabilitySummary: { total: 2 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })]
  });

  const rows = projectInspectorRows(project, plan, { now });
  const text = rows.join("\n");

  assert.equal(projectHistoryTopCommandLabel(project), "3x hist#88 cwd:packages/api npm run dev -- --host 0.0.0.0");
  assert.match(text, /history top: 3x hist#88 cwd:packages\/api npm run dev -- --host 0\.0\.0\.0/);
  assert.match(text, /top 3x hist#88 cwd:packages\/api npm run dev -- --host 0\.0\.0\.0/);
});

test("project inspector separates strong history from weak history evidence", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");
  const plan = { scanGeneratedAt: "2026-06-22T11:00:00.000Z" };
  const project = projectFixture("api", {
    historyUsage: {
      runCount: 8,
      commandCount: 2,
      signalRunCount: 1,
      signalCommandCount: 1,
      weakRunCount: 7,
      signalLastSequence: 88,
      signalLastRunAt: "2026-06-22T11:30:00.000Z",
      lastSequence: 99,
      lastRunAt: "2026-06-22T11:45:00.000Z",
      topCommands: [{
        command: "git status",
        count: 7,
        lastSequence: 99
      }],
      topSignalCommands: [{
        command: "npm run dev",
        count: 1,
        lastSequence: 88,
        relativeDir: "packages/api"
      }]
    },
    capabilitySummary: { total: 2 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })]
  });

  const text = projectInspectorRows(project, plan, { now }).join("\n");

  assert.match(projectHistoryInspectorLabel(project, plan, { now }), /hist#88 1x 2 cmds last 2026-06-22 11:30Z \(30m ago\) \+7 weak/);
  assert.equal(projectHistoryTopCommandLabel(project), "1x hist#88 cwd:packages/api npm run dev");
  assert.match(text, /history top: 1x hist#88 cwd:packages\/api npm run dev/);
  assert.doesNotMatch(text, /history top: .*git status/);
});

test("project rank explanation matches sort tags and search reason", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");
  const plan = { scanGeneratedAt: "2026-06-22T11:00:00.000Z" };
  const project = projectFixture("api", {
    historyUsage: { runCount: 5, commandCount: 2, lastSequence: 88, lastRunAt: "2026-06-22T11:30:00.000Z" },
    capabilitySummary: { total: 2, highRisk: 1 },
    capabilities: [capabilityFixture("dev", { source: { type: "package.json" } })],
    git: { dirtyTotal: 3, branch: "main" },
    activity: { lastTouchedAt: "2026-06-22T11:45:00.000Z", lastTouchedSource: "project-files" }
  });

  const explanation = projectRankExplanation(project, plan, { query: "main", now });

  assert.match(explanation, /tags scripts hist#88 5x git active/);
  assert.match(explanation, /history hist#88 5x 2 cmds last 2026-06-22 11:30Z \(30m ago\)/);
  assert.match(explanation, /scripts yes/);
  assert.match(explanation, /git 3 dirty/);
  assert.match(explanation, /activity 15m/);
  assert.match(explanation, /match branch/);
});

test("capability and remote rank explanations expose ordering signals", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-rank-explain");
  const project = { name: "api", path: projectPath };
  const capability = capabilityFixture("dev", {
    risk: "medium",
    source: { type: "package.json" },
    usage: { runCount: 4, lastSequence: 99 },
    sideEffects: ["network"],
    execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] }
  });
  const capabilityText = capabilityRankExplanation(capability, project, { count: 2, lastSentAt: SENT_AT });

  assert.match(capabilityText, /run:\[Run\]/);
  assert.match(capabilityText, /source:src:manifest\/p0/);
  assert.match(capabilityText, /usage:4x seq#99/);
  assert.match(capabilityText, /risk:medium/);
  assert.match(capabilityText, /sent:2x last/);
  assert.match(capabilityText, /cwd:.*packages\/api/);
  assert.match(capabilityText, /danger:network/);

  const remoteCommand = remoteCommandFixture("deploy", {
    command: "ssh app 'cd /srv/app && npm run deploy'",
    fullSshCommand: "ssh app 'cd /srv/app && npm run deploy'",
    count: 3,
    lastSequence: 77,
    sshTarget: "app",
    localProjects: [{ name: "api", source: "cwd", count: 2 }],
    execution: { cwd: projectPath }
  });
  const remoteText = remoteCommandRankExplanation(remoteCommand, {
    alias: "app",
    target: "app"
  }, { count: 1, lastSentAt: SENT_AT }, {
    cwd: projectPath,
    target: "app",
    source: "history",
    dangerLabel: "none"
  });

  assert.match(remoteText, /run:\[Run\]/);
  assert.match(remoteText, /source:project-history\/p0/);
  assert.match(remoteText, /usage:3x seq#77/);
  assert.match(remoteText, /sent:1x last/);
  assert.match(remoteText, /danger:none/);
  assert.match(remoteText, /target:app/);
  assert.match(remoteText, /local-cwd:.*workspace-keeper-rank-explain/);
  assert.doesNotMatch(remoteText, /(^|\s)cwd:/);
  assert.match(remoteText, /source-path:history/);
});

test("enter preview shows exact runnable target or no runnable selection", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-enter-preview");
  const project = { name: "api", path: projectPath };
  const capability = capabilityFixture("dev", {
    command: "cd packages/api && npm run dev",
    execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] }
  });

  assert.equal(
    enterCapabilityPreviewLabel(project, capability),
    `Enter: project api command:npm run dev cwd:${path.join(projectPath, "packages/api")}`
  );
  assert.equal(enterCapabilityPreviewLabel(project, { runnable: false }), "Enter: no runnable selection");

  const remoteCommand = remoteCommandFixture("uptime", {
    command: "ssh app uptime",
    fullSshCommand: "ssh app uptime",
    sshTarget: "app",
    execution: { cwd: projectPath }
  });

  assert.equal(
    enterRemotePreviewLabel({ alias: "app", target: "app" }, remoteCommand, { cwd: projectPath }),
    `Enter: remote app target:app command:ssh app uptime local cwd:${projectPath}`
  );
  assert.equal(enterRemotePreviewLabel({ alias: "app" }, { runnable: false }), "Enter: no runnable selection");
});

test("sent tie-break is neutral without sent events or exact matches", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-sent-neutral");
  const capabilities = [
    capabilityFixture("zeta", { command: "npm test" }),
    capabilityFixture("alpha", { command: "npm run build" })
  ];

  assert.deepEqual(sortCapabilityNames(capabilities, { projectPath }), ["alpha", "zeta"]);
  assert.deepEqual(sortCapabilityNames(capabilities, { projectPath, ghosttySentEvents: [] }), ["alpha", "zeta"]);
  assert.deepEqual(sortCapabilityNames(capabilities, {
    projectPath,
    ghosttySentEvents: [{ status: "sent", sentAt: SENT_AT, cwd: projectPath, command: "npm run lint" }]
  }), ["alpha", "zeta"]);

  const root = os.tmpdir();
  const commands = [
    remoteCommandFixture("zeta", { command: "ssh app uptime", execution: { cwd: root } }),
    remoteCommandFixture("alpha", { command: "ssh app whoami", execution: { cwd: root } })
  ];

  assert.deepEqual(sortRemoteCommandNames(commands, { root }), ["alpha", "zeta"]);
  assert.deepEqual(sortRemoteCommandNames(commands, { root, ghosttySentEvents: [] }), ["alpha", "zeta"]);
  assert.deepEqual(sortRemoteCommandNames(commands, {
    root,
    ghosttySentEvents: [{ status: "sent", sentAt: SENT_AT, cwd: root, command: "ssh app hostname" }]
  }), ["alpha", "zeta"]);
});

test("exact cwd and command sent match changes only fully tied candidate order", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-sent-exact");
  const capabilities = [
    capabilityFixture("zeta", { command: "npm test" }),
    capabilityFixture("alpha", { command: "npm run build" })
  ];

  assert.deepEqual(sortCapabilityNames(capabilities, {
    projectPath,
    ghosttySentEvents: [{ status: "sent", sentAt: SENT_AT, cwd: projectPath, command: "npm test" }]
  }), ["zeta", "alpha"]);

  const root = os.tmpdir();
  const commands = [
    remoteCommandFixture("zeta", { command: "ssh app uptime", execution: { cwd: root } }),
    remoteCommandFixture("alpha", { command: "ssh app whoami", execution: { cwd: root } })
  ];

  assert.deepEqual(sortRemoteCommandNames(commands, {
    root,
    ghosttySentEvents: [{ status: "sent", sentAt: SENT_AT, cwd: root, command: "ssh app uptime" }]
  }), ["zeta", "alpha"]);
});

test("capability sent tie-break matches actual execution command instead of display command", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-sent-actual-command");
  const capabilities = [
    capabilityFixture("alpha", {
      command: "cd 'packages/api' && npm run dev",
      execution: { cwd: "packages/api", command: "npm", args: ["run", "dev"] }
    }),
    capabilityFixture("zeta", {
      command: "cd tools && ./foo.sh",
      execution: { cwd: "tools", command: "sh", args: ["foo.sh"] }
    })
  ];

  assert.deepEqual(sortCapabilityNames(capabilities, {
    projectPath,
    ghosttySentEvents: [{
      status: "sent",
      sentAt: SENT_AT,
      cwd: path.join(projectPath, "tools"),
      command: "cd tools && ./foo.sh"
    }]
  }), ["alpha", "zeta"]);

  assert.deepEqual(sortCapabilityNames(capabilities, {
    projectPath,
    ghosttySentEvents: [{
      status: "sent",
      sentAt: SENT_AT,
      cwd: path.join(projectPath, "tools"),
      command: "sh foo.sh"
    }]
  }), ["zeta", "alpha"]);
});

test("sent tie-break requires exact cwd and command", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-sent-exact-only");
  const capabilities = [
    capabilityFixture("zeta", { command: "npm test" }),
    capabilityFixture("alpha", { command: "npm run build" })
  ];
  const nonExactEvents = [
    [{ status: "sent", sentAt: SENT_AT, cwd: projectPath, command: "npm run test" }],
    [{ status: "sent", sentAt: SENT_AT, cwd: `${projectPath}-other`, command: "npm test" }],
    [{ status: "sent", sentAt: SENT_AT, cwd: path.join(projectPath, "nested"), command: "npm test" }],
    [{ status: "sent", sentAt: SENT_AT, cwd: projectPath, command: "npm test -- --watch" }]
  ];

  for (const ghosttySentEvents of nonExactEvents) {
    assert.deepEqual(sortCapabilityNames(capabilities, { projectPath, ghosttySentEvents }), ["alpha", "zeta"]);
    assert.equal(compareGhosttySentUsage(ghosttySentEvents, {
      cwd: projectPath,
      command: "npm run build"
    }, {
      cwd: projectPath,
      command: "npm test"
    }), 0);
  }
});

test("capability sent tie-break stays behind usage, source, risk, lastSequence, and confidence", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-sent-capability-strength");
  const sentForAlpha = [{ status: "sent", sentAt: SENT_AT, cwd: projectPath, command: "npm test" }];
  const cases = [
    {
      label: "usage",
      strong: capabilityFixture("zeta", { command: "npm run build", usage: { runCount: 2 } }),
      sent: capabilityFixture("alpha", { command: "npm test", usage: { runCount: 1 } })
    },
    {
      label: "source",
      strong: capabilityFixture("zeta", { command: "npm run build", source: { type: "package.json" } }),
      sent: capabilityFixture("alpha", { command: "npm test", source: { type: "script-file" } })
    },
    {
      label: "risk",
      strong: capabilityFixture("zeta", { command: "npm run build", risk: "low" }),
      sent: capabilityFixture("alpha", { command: "npm test", risk: "medium" })
    },
    {
      label: "lastSequence",
      strong: capabilityFixture("zeta", { command: "npm run build", usage: { lastSequence: 20 } }),
      sent: capabilityFixture("alpha", { command: "npm test", usage: { lastSequence: 10 } })
    },
    {
      label: "confidence",
      strong: capabilityFixture("zeta", { command: "npm run build", confidence: 0.9 }),
      sent: capabilityFixture("alpha", { command: "npm test", confidence: 0.1 })
    }
  ];

  for (const entry of cases) {
    assert.deepEqual(sortCapabilityNames([entry.sent, entry.strong], {
      projectPath,
      ghosttySentEvents: sentForAlpha
    }), ["zeta", "alpha"], entry.label);
  }
});

test("remote sent tie-break stays behind count and lastSequence", () => {
  const root = os.tmpdir();
  const sentForAlpha = [{ status: "sent", sentAt: SENT_AT, cwd: root, command: "ssh app uptime" }];
  const cases = [
    {
      label: "count",
      strong: remoteCommandFixture("zeta", { command: "ssh app whoami", count: 2, execution: { cwd: root } }),
      sent: remoteCommandFixture("alpha", { command: "ssh app uptime", count: 1, execution: { cwd: root } })
    },
    {
      label: "lastSequence",
      strong: remoteCommandFixture("zeta", { command: "ssh app whoami", lastSequence: 20, execution: { cwd: root } }),
      sent: remoteCommandFixture("alpha", { command: "ssh app uptime", lastSequence: 10, execution: { cwd: root } })
    }
  ];

  for (const entry of cases) {
    assert.deepEqual(sortRemoteCommandNames([entry.sent, entry.strong], {
      root,
      ghosttySentEvents: sentForAlpha
    }), ["zeta", "alpha"], entry.label);
  }
});

test("remote command sorting keeps real remote history before login fallback", () => {
  const root = os.tmpdir();
  const login = remoteCommandFixture("login app", {
    kind: "login",
    command: "ssh app",
    count: 0,
    lastSequence: -1,
    execution: { cwd: root }
  });
  const logs = remoteCommandFixture("logs", {
    kind: "remote-command",
    command: "ssh app 'docker compose logs'",
    count: 5,
    lastSequence: 20,
    execution: { cwd: root }
  });
  const uptime = remoteCommandFixture("uptime", {
    kind: "remote-command",
    command: "ssh app uptime",
    count: 2,
    lastSequence: 30,
    execution: { cwd: root }
  });

  assert.deepEqual(sortRemoteCommandNames([logs, uptime, login], { root }), ["logs", "uptime", "login app"]);
  assert.deepEqual(sortRemoteCommandNames([uptime, logs], { root }), ["logs", "uptime"]);
});

test("remote login with cwd project hint stays behind real remote commands", () => {
  const root = os.tmpdir();
  const login = remoteCommandFixture("login app", {
    kind: "login",
    command: "ssh app",
    count: 3,
    lastSequence: 40,
    localProjects: [{ name: "api", source: "cwd", count: 3 }],
    execution: { cwd: root }
  });
  const command = remoteCommandFixture("cleanup", {
    kind: "remote-command",
    command: "ssh app 'brew cleanup'",
    count: 1,
    lastSequence: 10,
    execution: { cwd: root }
  });

  assert.deepEqual(sortRemoteCommandNames([login, command], { root }), ["cleanup", "login app"]);
});

test("remote project text hints do not outrank stronger command history", () => {
  const root = os.tmpdir();
  const remoteHint = remoteCommandFixture("deploy", {
    kind: "remote-command",
    command: "ssh app 'cd /srv/aggregation && ./deploy.sh'",
    count: 1,
    lastSequence: 10,
    localProjects: [{ name: "aggregation", source: "remote-command", count: 1 }],
    execution: { cwd: root }
  });
  const frequent = remoteCommandFixture("uptime", {
    kind: "remote-command",
    command: "ssh app uptime",
    count: 20,
    lastSequence: 40,
    execution: { cwd: root }
  });
  const cwdProject = remoteCommandFixture("build", {
    kind: "remote-command",
    command: "ssh app 'npm run build'",
    count: 1,
    lastSequence: 5,
    localProjects: [{ name: "api", source: "cwd", count: 1 }],
    execution: { cwd: root }
  });
  const remoteHintText = remoteCommandRankExplanation(remoteHint, { alias: "app", target: "app" }, null, { cwd: root });
  const cwdProjectText = remoteCommandRankExplanation(cwdProject, { alias: "app", target: "app" }, null, { cwd: root });

  assert.deepEqual(sortRemoteCommandNames([remoteHint, frequent], { root }), ["uptime", "deploy"]);
  assert.deepEqual(sortRemoteCommandNames([remoteHint, frequent, cwdProject], { root }), ["build", "uptime", "deploy"]);
  assert.match(remoteHintText, /source:command-history\+remote-hint\/p1/);
  assert.doesNotMatch(remoteHintText, /source:project-history\/p0/);
  assert.match(cwdProjectText, /source:project-history\/p0/);
});

test("sent tie-break does not affect left-pane sorting or create candidates", () => {
  const projectPath = path.join(os.tmpdir(), "workspace-keeper-sent-no-candidate");
  const ghosttySentEvents = [{ status: "sent", sentAt: SENT_AT, cwd: projectPath, command: "npm run sent-only" }];
  const projects = [
    { name: "zeta", path: path.join(os.tmpdir(), "zeta"), capabilitySummary: { total: 0, historyRunCount: 0 }, capabilities: [] },
    { name: "alpha", path: projectPath, capabilitySummary: { total: 1, historyRunCount: 0 }, capabilities: [capabilityFixture("build")] }
  ];
  const devices = [
    { alias: "zeta", hostName: "192.0.2.10", source: { type: "history" }, runCount: 0, lastSequence: 0, commandCount: 0 },
    { alias: "alpha", hostName: "app", source: { type: "ssh-config" }, runCount: 0, lastSequence: 0, commandCount: 1 }
  ];

  assert.deepEqual([...projects]
    .sort((a, b) => compareProjectsByActivity(a, b, { ghosttySentEvents }))
    .map((project) => project.name), ["alpha", "zeta"]);
  assert.deepEqual([...devices]
    .sort((a, b) => compareRemoteDevices(a, b, { ghosttySentEvents }))
    .map((device) => device.alias), ["alpha", "zeta"]);

  const capabilities = [
    capabilityFixture("alpha", { command: "npm run build" }),
    capabilityFixture("zeta", { command: "npm test" })
  ];
  const sortedCapabilities = [...capabilities].sort((a, b) => compareCapabilitiesByTuiOrder(a, b, {
    project: { name: "project", path: projectPath },
    ghosttySentEvents
  }));
  assert.equal(sortedCapabilities.length, capabilities.length);
  assert.deepEqual(sortedCapabilities.map((capability) => capability.command).sort(), ["npm run build", "npm test"]);
  assert.equal(sortedCapabilities.some((capability) => capability.command === "npm run sent-only"), false);

  const commands = [
    remoteCommandFixture("alpha", { command: "ssh app whoami" }),
    remoteCommandFixture("zeta", { command: "ssh app uptime" })
  ];
  const sortedCommands = [...commands].sort((a, b) => compareRemoteCommandsByTuiOrder(a, b, {
    root: os.tmpdir(),
    ghosttySentEvents
  }));
  assert.equal(sortedCommands.length, commands.length);
  assert.deepEqual(sortedCommands.map((command) => command.fullSshCommand).sort(), ["ssh app uptime", "ssh app whoami"]);
  assert.equal(sortedCommands.some((command) => command.fullSshCommand === "npm run sent-only"), false);
});
