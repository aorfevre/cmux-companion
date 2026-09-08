import { assignAgents } from "./worktree-planner.mjs";
import { accountEligibility, accountHeadroom, observationState, providerCapacity, usageWindows, weeklyOpportunity } from "./capacity-policy.mjs";

const LABELS = { claude: "Claude", codex: "Codex" };

export function agentCapacity(usage, now = Date.now()) {
  const providers = ["claude", "codex"].map((id) => {
    const source = (usage?.providers || []).find((item) => item?.id === id);
    const accounts = (source?.accounts || []).map((account) => ({
      id: account.id || null, label: account.label || "Account", status: account.status || "unavailable",
      paused: Boolean(account.paused), updatedAt: account.updatedAt || null,
      freshness: observationState(account, now), eligibility: accountEligibility(account, source?.available !== false),
      headroom: accountHeadroom(account),
      windows: usageWindows(account).map((window) => ({ cadence: window.cadence, label: window.label || window.cadence,
        remainingPercent: window.remainingPercent, resetAt: window.resetAt || null })),
      opportunity: weeklyOpportunity(account, now),
    }));
    const scores = accounts.filter((account) => !account.paused && ["ready", "low", "exhausted"].includes(account.status))
      .map((account) => account.headroom).filter((value) => value !== null);
    return { id, label: LABELS[id], available: source?.available === true, accounts,
      ...providerCapacity(usage, id), bestPercent: scores.length ? Math.max(...scores) : null,
      resetAt: earliest(accounts.flatMap((account) => account.windows.map((window) => window.resetAt)), now) };
  });
  const usable = providers.filter((provider) => provider.headroom !== null);
  const next = usable.length ? assignAgents([{ id: "probe" }], usage)[0].agent : null;
  const state = usable.length ? "eligible" : providers.some((provider) => provider.state === "unknown") ? "unknown" : "blocked";
  const reason = !usable.length
    ? state === "unknown" ? "Quota is unavailable or incomplete. Automatic tasks may use a provider fallback with unverified quota."
      : "No provider has usable quota. Check limits, paused accounts or reconnection before trying again."
    : usable.length === 1 ? `${LABELS[next]} is the only provider with reported usable quota.`
      : Math.abs(providers[0].headroom - providers[1].headroom) <= 10
        ? `${LABELS[next]} is recommended first. Within ten points, tasks alternate within a single plan, not across goals.`
        : `${LABELS[next]} has the most reported headroom.`;
  return { providers, next, state, reason, available: usable.length > 0,
    generatedAt: usage?.generatedAt || null,
    nextReset: earliest(providers.map((provider) => provider.resetAt), now) };
}

function earliest(values, now) {
  return values.filter((value) => Date.parse(value) > now).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
}
