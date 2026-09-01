"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Cadence = "5h" | "daily" | "weekly" | "monthly" | "other";
type UsageWindow = { id: string; cadence: Cadence; label: string; category: "usage" | "additional" | "code-review"; remainingPercent: number; resetAt: string | null; reported: true };
type UsageAccount = { id: string; label: string; email: string | null; plan: string | null; isDefault: boolean; paused: boolean; status: "ready" | "low" | "exhausted" | "reconnect" | "unavailable"; message: string | null; updatedAt: string | null; windows: UsageWindow[] };
type UsageProvider = { id: "claude" | "codex"; label: string; available: boolean; accounts: UsageAccount[] };
type UsageResponse = { generatedAt: string; source: "CCS"; available: boolean; summary: Record<UsageAccount["status"], number>; providers: UsageProvider[] };
type ReconnectSession = { sessionId: string; provider: UsageProvider["id"]; status: "waiting" | "processing" | "success" | "error" | "expired" | "cancelled"; message: string; authUrl: string | null; expiresAt: string };

const CORE_WINDOWS: Array<{ cadence: Exclude<Cadence, "other">; label: string }> = [
  { cadence: "5h", label: "5 hours" },
  { cadence: "weekly", label: "Weekly" },
];

export function AccountUsageView({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [reconnecting, setReconnecting] = useState<{ provider: UsageProvider; account: UsageAccount } | null>(null);
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/account-usage${refresh ? "?refresh=1" : ""}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not read CCS usage");
      setUsage(body as UsageResponse);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read CCS usage");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const total = useMemo(() => usage?.providers.reduce((sum, provider) => sum + provider.accounts.length, 0) || 0, [usage]);
  const attention = (usage?.summary.low || 0) + (usage?.summary.exhausted || 0) + (usage?.summary.reconnect || 0);
  const reconnectSuccess = useCallback(() => load(true), [load]);

  return <section className="account-usage-page">
    <header className="usage-page-head"><button onClick={onBack}>‹ Settings</button><div><p className="eyebrow">CCS · LIVE QUOTA</p><h1>Licence usage</h1></div><button className="usage-refresh" disabled={loading} onClick={() => load(true)} aria-label="Refresh account usage">↻</button></header>
    <p className="usage-intro">Remaining coding capacity for every account connected to CCS. Missing windows are never treated as zero.</p>
    {usage && <div className="usage-summary"><span><strong>{total}</strong> accounts</span><span className={attention ? "attention" : "ready"}><strong>{attention}</strong> need attention</span><small>{relativeUpdated(usage.generatedAt)}</small></div>}
    {loading && !usage && <div className="usage-loading"><i /><i /><i /></div>}
    {error && <div className="usage-error"><strong>Usage unavailable</strong><span>{error}</span><button onClick={() => load(true)}>Try again</button></div>}
    {usage && !usage.available && !error && <div className="usage-error"><strong>CCS usage is unavailable</strong><span>Check that CCS is installed on this Mac, then refresh.</span></div>}
    <div className="usage-providers">{usage?.providers.map((provider) => <ProviderSection provider={provider} now={now} onReconnect={(account) => setReconnecting({ provider, account })} key={provider.id} />)}</div>
    {usage?.available && <p className="usage-privacy">Quota comes directly from CCS. OAuth credentials never leave your Mac or appear in this view.</p>}
    {reconnecting && <ReconnectSheet provider={reconnecting.provider} account={reconnecting.account} onClose={() => setReconnecting(null)} onSuccess={reconnectSuccess} />}
  </section>;
}

function ProviderSection({ provider, now, onReconnect }: { provider: UsageProvider; now: number; onReconnect: (account: UsageAccount) => void }) {
  return <section className="usage-provider"><header><div className={`provider-mark ${provider.id}`}>{provider.id === "claude" ? "C" : "O"}</div><div><h2>{provider.label}</h2><span>{provider.accounts.length} connected account{provider.accounts.length === 1 ? "" : "s"}</span></div></header>
    {!provider.available && <p className="provider-warning">This provider did not return usage.</p>}
    {provider.available && provider.accounts.length === 0 && <p className="provider-empty">No CCS account connected.</p>}
    <div className="usage-account-list">{provider.accounts.map((account) => <AccountCard account={account} now={now} onReconnect={() => onReconnect(account)} key={account.id} />)}</div>
  </section>;
}

function AccountCard({ account, now, onReconnect }: { account: UsageAccount; now: number; onReconnect: () => void }) {
  const extras = account.windows.filter((window) => window.category !== "usage" || window.cadence === "other");
  return <article className={`usage-account ${account.status}`}><header><div><strong>{account.email || account.label}</strong><span>{[account.plan, account.isDefault ? "default" : null, account.paused ? "paused" : null].filter(Boolean).join(" · ") || "CCS account"}</span></div><span className={`usage-status ${account.status}`}>{statusLabel(account.status, account.windows.length)}</span></header>
    {account.message && <p className={`account-message ${account.status}`}>{account.message}</p>}
    <div className="core-window-grid">{CORE_WINDOWS.map(({ cadence, label }) => <CoreWindow label={label} window={account.windows.find((item) => item.category === "usage" && item.cadence === cadence)} now={now} key={cadence} />)}</div>
    {extras.length > 0 && <div className="extra-windows"><p>Additional limits</p>{extras.map((window) => <ExtraWindow window={window} now={now} key={window.id} />)}</div>}
    {account.status === "reconnect" && <button className="account-reconnect" onClick={onReconnect}>Reconnect account</button>}
  </article>;
}

function ReconnectSheet({ provider, account, onClose, onSuccess }: { provider: UsageProvider; account: UsageAccount; onClose: () => void; onSuccess: () => Promise<void> }) {
  const [session, setSession] = useState<ReconnectSession | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const successHandled = useRef(false);
  const active = session?.status === "waiting" || session?.status === "processing";
  const adopt = useCallback(async (next: ReconnectSession) => {
    setSession(next);
    if (next.status === "success" && !successHandled.current) {
      successHandled.current = true;
      await onSuccess();
    }
  }, [onSuccess]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/account-usage/${account.id}/reconnect`, { method: "POST", signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not start reconnect");
        await adopt(body as ReconnectSession);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not start reconnect");
      }
    })();
    return () => controller.abort();
  }, [account.id, adopt]);

  useEffect(() => {
    if (!session || !active) return;
    const poll = async () => {
      try {
        const response = await fetch(`/api/account-usage/reconnect/${session.sessionId}`);
        const body = await response.json().catch(() => ({}));
        if (response.ok) await adopt(body as ReconnectSession);
      } catch { /* Retry while the sheet remains open. */ }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    return () => window.clearInterval(timer);
  }, [active, adopt, session]);

  const close = () => {
    if (session && active) void fetch(`/api/account-usage/reconnect/${session.sessionId}`, { method: "DELETE" });
    onClose();
  };
  const submit = async () => {
    if (!session || !callbackUrl.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/account-usage/reconnect/${session.sessionId}/callback`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callbackUrl: callbackUrl.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not finish reconnect");
      await adopt(body as ReconnectSession);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not finish reconnect");
    } finally { setBusy(false); }
  };

  return <><button className="reconnect-backdrop" aria-label="Close reconnect" onClick={close} /><section className="reconnect-sheet" role="dialog" aria-modal="true" aria-label={`Reconnect ${provider.label}`}>
    <header><div><p className="eyebrow">CCS · SECURE LOGIN</p><strong>Reconnect {provider.id === "claude" ? "Claude" : "Codex"}</strong><span>{account.email || account.label}</span></div><button aria-label="Close reconnect" onClick={close}>×</button></header>
    {!session && !error && <div className="reconnect-loading"><i />Preparing login on your Mac…</div>}
    {session?.status === "success" ? <div className="reconnect-success"><span>✓</span><strong>Account reconnected</strong><p>The licence usage has been refreshed.</p><button onClick={close}>Done</button></div> : <>
      {session?.authUrl && <a className="reconnect-login" href={session.authUrl} target="_blank" rel="noreferrer">Open {provider.id === "claude" ? "Anthropic" : "OpenAI"} login <span>↗</span></a>}
      {session && <div className={`reconnect-state ${session.status}`}><i />{session.message}</div>}
      {session?.authUrl && <div className="reconnect-manual"><strong>If the localhost page does not open</strong><p>That is normal on your phone. Copy its full address from the browser bar, then paste it here.</p><textarea aria-label="Localhost callback URL" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:…/?code=…&state=…" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><button disabled={busy || !callbackUrl.trim() || !active} onClick={submit}>{busy ? "Finishing…" : "Finish reconnect"}</button></div>}
    </>}
    {error && <p className="reconnect-error">{error}</p>}
  </section></>;
}

function CoreWindow({ label, window, now }: { label: string; window?: UsageWindow; now: number }) {
  const tone = window ? percentTone(window.remainingPercent) : "missing";
  return <div className={`core-window ${tone}`}><div><span>{label}</span>{window ? <strong>{window.remainingPercent}%</strong> : <strong>—</strong>}</div>{window ? <><div className="quota-track"><i style={{ width: `${window.remainingPercent}%` }} /></div><ResetTime value={window.resetAt} now={now} /></> : <small>Not reported</small>}</div>;
}

function ExtraWindow({ window, now }: { window: UsageWindow; now: number }) {
  return <div className={`extra-window ${percentTone(window.remainingPercent)}`}><div><strong>{displayLabel(window.label)}</strong><span>{window.cadence}</span></div><b>{window.remainingPercent}%</b><ResetTime value={window.resetAt} now={now} /></div>;
}

function ResetTime({ value, now }: { value: string | null; now: number }) {
  const reset = value ? new Date(value) : null;
  if (!reset || !Number.isFinite(reset.getTime())) return <small>Reset unknown</small>;
  return <small><time dateTime={reset.toISOString()} title={reset.toLocaleString()}>{resetText(value, now)}</time></small>;
}

function percentTone(percent: number) { return percent <= 0 ? "exhausted" : percent <= 20 ? "low" : "ready"; }
function statusLabel(status: UsageAccount["status"], windowCount = 1) { return status === "ready" && windowCount === 0 ? "Connected" : ({ ready: "Available", low: "Low", exhausted: "Exhausted", reconnect: "Reconnect", unavailable: "Unavailable" })[status]; }
function displayLabel(label: string) { return label.replaceAll("-", " ").replace(/\bGpt\b/i, "GPT"); }
function relativeUpdated(value: string) { const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); return seconds < 15 ? "Updated now" : seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`; }
function resetText(value: string | null, now: number) {
  if (!value) return "Reset unknown";
  const reset = new Date(value);
  const milliseconds = reset.getTime() - now;
  if (!Number.isFinite(milliseconds)) return "Reset unknown";
  if (milliseconds <= 0) return "Reset due";
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  return `Resets in ${String(days).padStart(2, "0")}:${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
