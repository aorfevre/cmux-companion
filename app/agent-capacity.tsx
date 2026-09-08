function resetLabel(value: string | null, now: number) {
  const remaining = Date.parse(value || "") - now;
  if (!Number.isFinite(remaining)) return "Reset unknown";
  if (remaining <= 0) return "Reset due · awaiting observation";
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return `Resets in ${[days ? `${days}d` : "", hours ? `${hours}h` : "", minutes % 60 ? `${minutes % 60}m` : ""].filter(Boolean).join(" ")}`;
}

type CapacityWindow = { cadence: string; label: string; remainingPercent: number; resetAt: string | null };
type CapacityAccount = { id: string | null; label: string; status: string; paused?: boolean; updatedAt?: string | null; eligibility?: string; headroom: number | null; windows: CapacityWindow[]; opportunity?: CapacityWindow | null };
type CapacityProvider = { id: "claude" | "codex"; label: string; available: boolean; headroom: number | null; bestPercent: number | null; accounts: CapacityAccount[] };
export type AgentCapacity = { providers: CapacityProvider[]; next: "claude" | "codex" | null; reason: string; nextReset: string | null; available: boolean; state?: string };

function observation(account: CapacityAccount, now: number) {
  const at = Date.parse(account.updatedAt || "");
  if (!Number.isFinite(at) || at > now) return "Observation time unknown";
  const minutes = Math.floor((now - at) / 60_000);
  return `${now - at > 120_000 ? "Stale · " : ""}Observed ${minutes < 1 ? "just now" : `${minutes}m ago`}`;
}

function accountState(account: CapacityAccount) {
  if (account.paused) return "Paused";
  if (account.status === "reconnect") return "Reconnect required";
  if (account.status === "exhausted" || account.headroom === 0) return "Exhausted";
  if (account.eligibility === "limited") return "Quota below reserve";
  if (account.eligibility === "unknown" || account.status === "unavailable") return "Quota unavailable";
  return "Reported capacity available";
}

export function WeeklyOpportunities({ capacity, error, now, onUsage }: { capacity: AgentCapacity | null; error: string; now: number; onUsage?: () => void }) {
  const opportunities = (capacity?.providers || []).flatMap((provider) => provider.accounts.flatMap((account) => {
    const window = account.opportunity;
    return window && Date.parse(window.resetAt || "") > now ? [{ provider, account, window }] : [];
  }));
  if (error || !opportunities.length) return null;
  return <section className="weekly-opportunities" aria-label="Weekly reset opportunities">
    <header><h3>Weekly reset soon</h3><button type="button" className="text-button" onClick={onUsage}>All account usage</button></header>
    <p>At least 20% remaining, resetting within 24 hours. Quota is shared across an account’s sessions.</p>
    <div className="weekly-opportunity-list">{opportunities.map(({ provider, account, window }, index) => <article key={`${provider.id}:${account.id || index}`}>
      <strong>{provider.label} · {account.label}</strong>
      <p><b>{window.remainingPercent}% weekly remaining</b> · {resetLabel(window.resetAt, now)}</p>
      <p>{account.windows.filter((item) => item.cadence === "5h").map((item) => `${item.remainingPercent}% short-window remaining`).join(" · ") || "Short-window quota not reported"}</p>
      <small>{accountState(account)} · {observation(account, now)}</small>
    </article>)}</div>
  </section>;
}

export function AgentCapacityStrip({ capacity, error, now, onRetry, onUsage }: { capacity: AgentCapacity | null; error: string; now: number; onRetry: () => void; onUsage?: () => void }) {
  return <section className="agent-capacity" aria-label="Agent capacity">
    <header><h3>Account capacity</h3><button type="button" className="text-button" onClick={onRetry}>Refresh quota</button></header>
    {error && <p className="agent-capacity-note" role="status">{error} · Previous observations may be outdated.</p>}
    {!error && capacity?.reason && <p className="agent-capacity-reason">{capacity.reason}</p>}
    <p className="agent-capacity-reason">Recommendations apply to automatic plan tasks. Goal sessions keep their selected engine. The launcher chooses the account; session-to-account routing is unverified.</p>
    {!capacity && !error && <p>Reading agent quota…</p>}
    {capacity && <div className="agent-capacity-providers">{capacity.providers.map((provider) => <article className="agent-capacity-provider" key={provider.id}>
      <header><strong>{provider.label}</strong>{!error && capacity.next === provider.id && <em>Recommended provider</em>}</header>
      {!provider.accounts.length && <p>Quota unavailable · no accounts reported</p>}
      {provider.accounts.map((account, index) => <section className="capacity-account" key={account.id || index} aria-label={`${provider.label} ${account.label}`}>
        <header><strong>{account.label}</strong><span>{accountState(account)}</span></header>
        <small>{observation(account, now)}</small>
        {!account.windows.length ? <p>No usage windows reported.</p> : <ul className="agent-capacity-windows">{account.windows.map((window, index) => <li key={index}><span>{window.label}</span><b>{window.remainingPercent}% left</b><small>{resetLabel(window.resetAt, now)}</small></li>)}</ul>}
      </section>)}
    </article>)}</div>}
    <button type="button" className="text-button" onClick={onUsage}>All account usage</button>
  </section>;
}

export function AgentCapacityChip({ capacity, error, open, onToggle }: { capacity: AgentCapacity | null; error: string; now: number; open: boolean; onToggle: () => void }) {
  const next = capacity?.providers.find((provider) => provider.id === capacity.next);
  const label = error ? "Quota unavailable" : !capacity ? "Reading agent quota…"
    : !capacity.available ? capacity.state === "blocked" ? "No usable quota" : "Quota unknown"
      : next ? `${next.label} · ${next.headroom}% reported` : "Account capacity";
  return <button type="button" className={`agent-capacity-chip${open ? " open" : ""}`} aria-label={`${label}. ${open ? "Hide" : "Show"} agent capacity`} aria-expanded={open} onClick={onToggle}><span aria-hidden="true">⚡</span>{label}<b aria-hidden="true">⌄</b></button>;
}
