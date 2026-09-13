import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(command, code, stderr) {
    super(`${command} failed (${code}): ${redact(stderr).slice(-1000)}`);
    this.name = "CommandError";
    this.code = code;
  }
}

export function redact(value = "") {
  return String(value)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/(token|password|authorization|cookie)([=:]\s*)\S+/gi, "$1$2[redacted]");
}

export function run(file, args = [], { cwd, env, timeoutMs = 60_000, log = null, allowFailure = false } = {}) {
  if (!Array.isArray(args)) throw new TypeError("Subprocess arguments must be an array");
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; log?.(redact(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; log?.(redact(chunk)); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) return resolve({ code, signal, stdout, stderr });
      reject(new CommandError([file, ...args].join(" "), signal || code, stderr));
    });
  });
}
