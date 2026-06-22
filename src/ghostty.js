import fs from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_GHOSTTY_TIMEOUT_MS = 8000;
const MAX_OSASCRIPT_OUTPUT_CHARS = 6000;

export async function openGhosttyTab(cwd, command, { timeoutMs = DEFAULT_GHOSTTY_TIMEOUT_MS } = {}) {
  if (process.platform !== "darwin" || !fs.existsSync("/Applications/Ghostty.app")) {
    return openGhosttyCli(cwd, command, { timeoutMs });
  }

  const script = `
on run argv
  set workspaceKeeperCwd to item 1 of argv
  set workspaceKeeperCommand to item 2 of argv
  tell application id "com.mitchellh.ghostty"
    activate
    set workspaceKeeperConfig to new surface configuration from {initial working directory:workspaceKeeperCwd, initial input:(workspaceKeeperCommand & linefeed)}
    if (count of windows) is 0 then
      new window with configuration workspaceKeeperConfig
    else
      set workspaceKeeperTab to new tab in front window with configuration workspaceKeeperConfig
      select tab workspaceKeeperTab
    end if
  end tell
end run
`;

  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_GHOSTTY_TIMEOUT_MS);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardKill = null;

    const child = spawn("osascript", ["-e", script, cwd, command], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000);
      hardKill.unref();
    }, timeout);
    watchdog.unref();

    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      if (hardKill) {
        clearTimeout(hardKill);
      }
      resolve({
        status: timedOut ? "timeout" : (code === 0 ? "sent" : "failed"),
        timedOut,
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timeoutMs: timeout
      });
    });
    child.on("error", (error) => {
      clearTimeout(watchdog);
      if (hardKill) {
        clearTimeout(hardKill);
      }
      reject(error);
    });
  });
}

async function openGhosttyCli(cwd, command, { timeoutMs = DEFAULT_GHOSTTY_TIMEOUT_MS } = {}) {
  const args = ghosttyCliArgs(cwd, command);
  return await new Promise((resolve, reject) => {
    const child = spawn("ghostty", args, {
      cwd,
      detached: true,
      stdio: "ignore"
    });
    child.once("error", (error) => {
      reject(new Error(`Ghostty CLI launch failed. Install Ghostty CLI in PATH or use macOS Ghostty.app automation. ${error.message || String(error)}`));
    });
    child.once("spawn", () => {
      child.unref();
      resolve({
        status: "sent",
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timeoutMs,
        launcher: "ghostty-cli"
      });
    });
  });
}

function ghosttyCliArgs(cwd, command) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec || "cmd.exe";
    return ["-e", shell, "/d", "/s", "/k", `cd /d ${cmdQuote(cwd)} && ${command}`];
  }

  const shell = process.env.SHELL || "/bin/sh";
  return ["-e", shell, "-lc", `cd ${shellQuote(cwd)} && ${command}`];
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  if (next.length <= MAX_OSASCRIPT_OUTPUT_CHARS) {
    return next;
  }
  return next.slice(-MAX_OSASCRIPT_OUTPUT_CHARS);
}
