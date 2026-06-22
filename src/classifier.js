const DAY_MS = 24 * 60 * 60 * 1000;

export function makePlan(scan, { now = new Date() } = {}) {
  const projects = scan.projects.map((project) => ({
    ...project,
    archive: classifyProject(project, now)
  }));

  const buckets = {
    active: [],
    review: [],
    "archive-ready": [],
    snapshot: [],
    cleanup: []
  };

  for (const project of projects) {
    buckets[project.archive.status].push(project.name);
  }

  const capabilityStats = summarizeCapabilities(projects);

  return {
    schemaVersion: 1,
    root: scan.root,
    generatedAt: new Date().toISOString(),
    scanGeneratedAt: scan.generatedAt,
    remoteControl: scan.remoteControl || emptyRemoteControl(),
    summary: {
      ...scan.summary,
      ...capabilityStats,
      remoteDeviceCount: scan.remoteControl?.deviceCount || 0,
      remoteCommandCount: scan.remoteControl?.commandCount || 0,
      remoteHistoryRunCount: scan.remoteControl?.historyRunCount || 0,
      buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]))
    },
    buckets,
    projects
  };
}

function emptyRemoteControl() {
  return {
    generatedAt: null,
    sshConfig: {
      path: "~/.ssh/config",
      readable: false,
      files: [],
      hostCount: 0
    },
    deviceCount: 0,
    commandCount: 0,
    historyRunCount: 0,
    devices: []
  };
}

function summarizeCapabilities(projects) {
  return {
    capabilityCount: projects.reduce((sum, project) => sum + (project.capabilitySummary?.total || 0), 0),
    highRiskCapabilityCount: projects.reduce((sum, project) => sum + (project.capabilitySummary?.highRisk || 0), 0),
    projectsWithCapabilities: projects.filter((project) => (project.capabilitySummary?.total || 0) > 0).length,
    projectsWithHighRiskCapabilities: projects.filter((project) => (project.capabilitySummary?.highRisk || 0) > 0).length,
    historyCapabilityCount: projects.reduce((sum, project) => sum + (project.capabilitySummary?.history || 0), 0),
    historyMatchedCapabilityCount: projects.reduce((sum, project) => sum + (project.capabilitySummary?.historyMatched || 0), 0),
    historyRunCount: projects.reduce((sum, project) => sum + (project.capabilitySummary?.historyRunCount || 0), 0),
    projectHistoryRunCount: projects.reduce((sum, project) => sum + (project.historyUsage?.runCount || 0), 0),
    projectsWithHistoryUsage: projects.filter((project) => (project.historyUsage?.runCount || 0) > 0).length
  };
}

export function classifyProject(project, now = new Date()) {
  const reasons = [];
  const blockers = [];
  const modifiedDays = daysSince(project.modifiedAt, now);
  const commitDays = project.git?.lastCommitDate ? daysSince(project.git.lastCommitDate, now) : null;
  const recent = Math.min(modifiedDays, commitDays ?? modifiedDays) <= 30;

  if (project.isEmpty) {
    return recommendation("cleanup", 5, ["empty directory"], []);
  }

  if (!project.isGit && project.sizeBytes < 1024 * 1024 && project.markers.length === 0) {
    return recommendation("cleanup", 10, ["tiny non-project directory"], []);
  }

  if (project.git?.dirtyTotal > 0) {
    blockers.push(`${project.git.dirtyTotal} dirty git entries`);
  }

  if (project.secretCount > 0) {
    blockers.push(`${project.secretCount} local config/data files`);
  }

  if (project.gitRepoCount > 1) {
    blockers.push(`${project.gitRepoCount} git repositories inside`);
  }

  if (project.isGit && !project.git?.remote) {
    blockers.push("git repository has no origin remote");
  }

  if (!project.isGit && project.markers.length > 0) {
    reasons.push("project markers without git");
  }

  if (!project.isGit && project.sizeBytes >= 100 * 1024 * 1024) {
    reasons.push("large non-git directory");
  }

  if (blockers.length > 0) {
    return recommendation("review", 80, reasons, blockers);
  }

  if (recent) {
    reasons.push("recently changed");
    return recommendation("active", 25, reasons, blockers);
  }

  if (project.isGit && project.git?.remote && project.git.dirtyTotal === 0) {
    reasons.push("clean git repository with remote");
    return recommendation("archive-ready", 35, reasons, blockers);
  }

  if (!project.isGit && project.markers.length > 0) {
    reasons.push("snapshot before moving");
    return recommendation("snapshot", 60, reasons, blockers);
  }

  return recommendation("cleanup", 30, ["no project markers"], blockers);
}

export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const precision = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function recommendation(status, riskScore, reasons, blockers) {
  return {
    status,
    riskScore,
    reasons,
    blockers,
    canAutoArchive: status === "archive-ready" && blockers.length === 0,
    needsSnapshot: status === "snapshot"
  };
}

function daysSince(value, now) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}
