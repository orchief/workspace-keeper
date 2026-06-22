import path from "node:path";
import { shellQuote } from "./ghostty.js";

export function resolveExecutionCwd(projectPath, relativeCwd = "") {
  const projectRootPath = path.resolve(projectPath);
  const cwd = path.resolve(projectRootPath, relativeCwd || ".");
  if (cwd !== projectRootPath && !cwd.startsWith(`${projectRootPath}${path.sep}`)) {
    throw new Error("execution cwd escapes project path");
  }
  return cwd;
}

export function capabilityActualExecutionCommand(capability = {}) {
  const execution = capability?.execution || {};
  const command = String(execution.command || "").trim();
  if (!command) {
    return capability?.command || "";
  }

  const args = Array.isArray(execution.args) ? execution.args : [];
  if (command === "shell" && args.length === 2 && args[0] === "-lc" && typeof args[1] === "string") {
    return args[1];
  }

  return [command, ...args].map(shellArg).join(" ");
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
    return text;
  }
  return shellQuote(text);
}
