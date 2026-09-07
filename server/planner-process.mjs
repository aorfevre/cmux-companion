import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// promisify(execFile) buffers to completion, so nothing can be reported while
// the model is still thinking. spawn resolves the same shape and rejects with
// the same fields, plus it calls onLine for each stdout line, so every injected
// `execute` fake stays valid.
//
// Two limits, not one. `timeout` is an absolute ceiling on the run, and
// `idleTimeout` measures silence: every stdout line restarts it. A round that
// reads a large repository works steadily and is legitimately slow, so only the
// silence says it is stuck. A single wall-clock limit killed those rounds every
// time and could never be raised high enough. `reason` says which limit fired,
// so the caller can name the real cause instead of guessing.
export function streamExecFile(bin, args, { cwd, timeout = 0, idleTimeout = 0, maxBuffer = 4 * 1024 * 1024, env, onLine, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let reason = "";
    const stop = (why) => { killed = true; reason = why; child.kill("SIGTERM"); };
    const ceiling = timeout ? setTimeout(() => stop("ceiling"), timeout) : null;
    ceiling?.unref?.();
    let idle = null;
    // Abort is a third way this round can end, next to the ceiling and the
    // idle limit. It kills the same child through the same path, so the close
    // handler reports it exactly like a timeout does, with its own reason.
    const onAbort = () => stop("aborted");
    // The idle timer is armed once and rearmed on every line, so a silent
    // startup is bounded by the same limit as a mid-round stall.
    const restartIdle = () => {
      if (!idleTimeout || killed) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), idleTimeout);
      idle.unref?.();
    };
    // Every exit path runs this once: no timer is left armed, and the abort
    // listener is removed, so an AbortController that outlives the round holds
    // no reference to it.
    const cleanup = () => {
      clearTimeout(ceiling);
      clearTimeout(idle);
      signal?.removeEventListener?.("abort", onAbort);
    };
    if (signal?.aborted) stop("aborted");
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    restartIdle();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      restartIdle();
      // Only the final result line is needed later, so an over-long run drops
      // old lines instead of failing the round the way execFile does.
      if (stdout.length + line.length + 1 <= maxBuffer) stdout += `${line}\n`;
      // A progress consumer must never fail a planner round.
      try { onLine?.(line); } catch { /* the round outlives its audience */ }
    });
    // stderr is progress too. ccs writes its startup and its warnings there, so
    // a round that only complains is still alive and must not be called idle.
    child.stderr.on("data", (chunk) => { restartIdle(); if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once("error", (cause) => { cleanup(); lines.close(); reject(cause); });
    child.once("close", (code, closeSignal) => {
      cleanup();
      lines.close();
      if (killed || closeSignal) return reject(Object.assign(new Error("Command failed"), { killed, reason, signal: closeSignal || "SIGTERM", stderr, code }));
      if (code !== 0) return reject(Object.assign(new Error("Command failed"), { code, stderr, killed: false }));
      return resolve({ stdout, stderr });
    });
  });
}

// The non-streaming envelope and the stream-json result line hold the same two
// fields, so parsePlannerReply is reused as it is and only the line choice is
// new. Falling back to raw stdout keeps every plain-envelope fixture working.
export function finalEnvelope(stdout) {
  const lines = String(stdout).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    try { if (JSON.parse(line)?.type === "result") return line; } catch { /* a partial or unrelated line */ }
  }
  return stdout;
}

const TOOL_DETAIL = {
  Read: (input) => shortPath(input?.file_path),
  Grep: (input) => quoted(input?.pattern),
  Glob: (input) => quoted(input?.pattern),
};

// Only the model's own turn is legible progress. The system, hook and user lines
// are transport noise. The input is never spread: one whitelisted key per tool
// is read and truncated, so no path list or file body can leak into the UI.
export function progressEvent(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (value?.type !== "assistant") return null;
  for (const block of value.message?.content || []) {
    if (block?.type === "tool_use") {
      const detail = TOOL_DETAIL[block.name]?.(block.input) || "";
      return { k: "tool", t: `${String(block.name || "Tool").slice(0, 20)}${detail ? ` ${detail}` : ""}` };
    }
    // Prose between tool calls is reasoning. It runs long and it quotes the
    // repository, so only its presence is reported, never its content.
    if (block?.type === "text" && String(block.text || "").trim()) return { k: "text", t: "Thinking…" };
  }
  return null;
}

function shortPath(value) {
  const path = String(value || "");
  return path ? path.split("/").slice(-2).join("/").slice(0, 60) : "";
}

function quoted(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return text ? `"${text}"` : "";
}

