"use client";

import { useCallback, useEffect, useState } from "react";

type ServiceState = {
  runningSha?: string | null;
  deployedSha: string | null;
  observedRemoteSha: string | null;
  pendingSha?: string | null;
  quarantinedSha: string | null;
  alive: boolean;
  processRunning?: boolean;
  enabled?: boolean;
  healthy: boolean;
  status: "current" | "updating" | "behind" | "problem" | "unknown" | "paused";
};

type DeploymentStatus = {
  available: boolean;
  summary?: "healthy" | "updating" | "attention" | "paused";
  phase?: string;
  lastCheckAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  services?: { companion: ServiceState; updater: ServiceState };
};

const labels = { current: "Current", updating: "Updating", behind: "Behind", problem: "Problem", unknown: "Unknown", paused: "Paused" };

function shortSha(sha?: string | null) {
  return sha ? sha.slice(0, 7) : "unknown";
}

function dateTime(iso?: string | null) {
  if (!iso) return "Never";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed) : "Unknown";
}

function ServiceRow({ name, service, running = false }: { name: string; service: ServiceState; running?: boolean }) {
  const version = running ? service.runningSha || service.deployedSha : service.deployedSha;
  return <article className={`deployment-service ${service.status}`}>
    <span className="deployment-orb" aria-hidden="true" />
    <div>
      <strong>{name}</strong>
      <span>{running ? "Running" : "Deployed"} <code title={version || undefined}>{shortSha(version)}</code>{!service.alive ? service.processRunning === false ? " · process not running" : " · heartbeat stale" : ""}</span>
    </div>
    <i>{labels[service.status]}</i>
  </article>;
}

export function DeploymentHealth() {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/updater/status", { headers: { "Content-Type": "application/json" } });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setStatus(await response.json());
    } catch {
      setStatus({ available: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const kickoff = setTimeout(load, 0);
    const poll = setInterval(load, 30_000);
    return () => { clearTimeout(kickoff); clearInterval(poll); };
  }, [load]);

  const summary = status?.summary === "healthy" ? "Both services healthy" : status?.summary === "updating" ? "Update in progress" : status?.summary === "paused" ? "Automatic updates paused" : "Attention needed";
  return <section className={`deployment-card ${status?.summary || "attention"}`} aria-label="Deployment health" aria-busy={loading}>
    <header>
      <div><strong>Deployments</strong><span role="status" aria-live="polite">{loading && !status ? "Checking both services…" : summary}</span></div>
      <button type="button" disabled={loading} onClick={load} aria-label="Refresh deployment health">{loading ? "…" : "↻"}</button>
    </header>
    {status?.available && status.services ? <>
      <div className="deployment-services">
        <ServiceRow name="cmux companion" service={status.services.companion} running />
        <ServiceRow name="cmux companion updater" service={status.services.updater} />
      </div>
      <footer>
        <span>Phase <strong>{status.phase || "idle"}</strong></span>
        <span>Last check <time dateTime={status.lastCheckAt || undefined}>{dateTime(status.lastCheckAt)}</time></span>
        <span>Last success <time dateTime={status.lastSuccessAt || undefined}>{dateTime(status.lastSuccessAt)}</time></span>
      </footer>
      {status.lastError && <p className="deployment-error">{status.lastError}</p>}
    </> : !loading && <p className="deployment-unavailable">Updater status is unavailable. The Companion is online, but updater health cannot be confirmed.</p>}
  </section>;
}
