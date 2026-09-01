import { execFile } from "node:child_process";
import { promisify } from "node:util";

const UPDATER_STALE_AFTER_MS = 120_000;
const run = promisify(execFile);

function value(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusFor({ runningSha = null, deployedSha, observedRemoteSha, pendingSha = null, quarantinedSha, phase, alive, enabled = true }) {
  if (!alive) return "unknown";
  if (enabled === false) return "paused";
  if (!deployedSha || !observedRemoteSha) return "unknown";
  const versionMismatch = deployedSha !== observedRemoteSha;
  if (quarantinedSha || (runningSha && runningSha !== deployedSha) || (phase === "failed" && (pendingSha || versionMismatch))) return "problem";
  if (pendingSha || (phase !== "idle" && deployedSha !== observedRemoteSha)) return "updating";
  if (versionMismatch) return "behind";
  return "current";
}

export async function updaterLaunchAgentRunning() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return false;
  try {
    const { stdout } = await run("/bin/launchctl", ["print", `gui/${process.getuid()}/com.aorfevre.cmux-companion-updater`], { timeout: 2_000 });
    return launchAgentIsRunning(stdout);
  } catch {
    return false;
  }
}

export function launchAgentIsRunning(output) {
  return /(?:^|\n)\s*state = running\s*(?:\n|$)/.test(String(output || ""))
    && /(?:^|\n)\s*pid = \d+\s*(?:\n|$)/.test(String(output || ""));
}

export function deploymentStatus(state, releaseVersion, now = Date.now(), { updaterProcessRunning = false, updaterEnabled = true } = {}) {
  const phase = value(state?.phase) || "idle";
  const lastCheckAt = value(state?.lastCheckAt);
  const lastCheckTime = lastCheckAt ? Date.parse(lastCheckAt) : Number.NaN;
  const checkAge = Number.isFinite(lastCheckTime) ? now - lastCheckTime : Number.POSITIVE_INFINITY;
  const nextEligibleTime = Date.parse(value(state?.nextEligibleCheckAt) || "");
  const recentCheck = checkAge <= UPDATER_STALE_AFTER_MS;
  const activeRollout = phase !== "idle" && phase !== "failed";
  const retryScheduled = phase === "failed" && Number.isFinite(nextEligibleTime) && nextEligibleTime > now;
  const updaterAlive = updaterProcessRunning && (recentCheck || activeRollout || retryScheduled);
  const companion = {
    runningSha: value(releaseVersion?.gitSha),
    deployedSha: value(state?.deployedSha),
    observedRemoteSha: value(state?.observedRemoteSha),
    pendingSha: value(state?.pendingSha),
    quarantinedSha: value(state?.quarantinedSha),
    alive: true,
  };
  companion.status = statusFor({ ...companion, phase });
  companion.healthy = companion.status === "current";

  const updater = {
    deployedSha: value(state?.updaterDeployedSha),
    observedRemoteSha: value(state?.updaterObservedRemoteSha),
    quarantinedSha: value(state?.updaterQuarantinedSha),
    alive: updaterAlive,
    processRunning: updaterProcessRunning,
    enabled: updaterEnabled,
  };
  updater.status = statusFor({ ...updater, phase });
  updater.healthy = updater.status === "current";

  const states = [companion.status, updater.status];
  const summary = phase === "failed" || states.some((status) => ["problem", "behind", "unknown"].includes(status))
    ? "attention"
    : states.includes("updating")
      ? "updating"
      : states.includes("paused")
        ? "paused"
      : companion.healthy && updater.healthy ? "healthy" : "attention";

  return { summary, services: { companion, updater } };
}
