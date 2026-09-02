// The server already decides which provider runs the next task, and it decides
// it well: the lower of each provider's 5-hour and weekly remaining percent,
// best usable account, with an alternation band when the two are close. None of
// that reached the screen. So the operator sees agents being assigned and has
// no idea why, and no signal about when a provider is about to free up.
//
// This module answers that one question — which provider should take the next
// task, and what would change that answer — in the shape a panel can render.
// It computes nothing new: it re-uses `assignAgents`' own rule so the panel and
// the dispatcher can never disagree.

import { assignAgents } from "./worktree-planner.mjs";

const LABELS = { claude: "Claude", codex: "Codex" };
// Matches `providerHeadroom`: below this a provider is not offered work at all.
const MIN_HEADROOM = 5;
const USABLE_STATUS = new Set(["ready", "low"]);
// The two windows the dispatcher actually reads. A monthly window may look
// generous while the 5-hour window is empty, so showing it would mislead.
const DECIDING_CADENCES = new Set(["5h", "weekly"]);

// `usage` is an account-usage snapshot. Returns one row per provider plus the
// verdict the dispatcher would reach right now.
export function agentCapacity(usage) {
  const providers = ["claude", "codex"].map((id) => describeProvider(usage, id));
  const usable = providers.filter((provider) => provider.headroom !== null);

  // The one place the verdict comes from: ask the real dispatcher what it would
  // do with a single task. A panel that recomputed the rule would drift from it.
  const [decided] = assignAgents([{ id: "probe" }], usage);
  const next = usable.length ? decided?.agent || null : null;

  return {
    providers,
    next,
    reason: verdict(providers, usable, next, decided?.agentReason || ""),
    // The soonest moment a provider's deciding window resets. When both are
    // exhausted this is the only actionable fact on the panel.
    nextReset: soonestReset(providers),
    available: usable.length > 0,
  };
}

function describeProvider(usage, id) {
  const provider = (usage?.providers || []).find((item) => item?.id === id) || null;
  const accounts = (provider?.accounts || []).map((account) => ({
    id: account?.id || null,
    label: account?.label || account?.email || "Account",
    status: account?.status || "unavailable",
    // The account's own headroom under the dispatcher's rule: the *lower* of
    // its deciding windows, because the tighter one is what runs out first.
    headroom: accountHeadroom(account),
    windows: (account?.windows || [])
      .filter((window) => window?.category === "usage" && DECIDING_CADENCES.has(window.cadence))
      .map((window) => ({
        cadence: window.cadence,
        label: window.label || window.cadence,
        remainingPercent: window.remainingPercent,
        resetAt: window.resetAt || null,
      })),
  }));

  const scores = accounts.filter((account) => USABLE_STATUS.has(account.status) && account.headroom !== null).map((account) => account.headroom);
  const best = scores.length ? Math.max(...scores) : null;
  return {
    id,
    label: LABELS[id],
    available: provider?.available === true,
    accounts,
    // Null means "cannot take work", which is what the dispatcher means by it.
    headroom: best !== null && best > MIN_HEADROOM ? best : null,
    // Kept separate from `headroom` so a provider at 3% shows its real number
    // rather than reading as "no data at all".
    bestPercent: best,
    resetAt: soonestAccountReset(accounts),
  };
}

// One sentence a person can act on. It says what will happen and why, not a
// percentage they must interpret.
function verdict(providers, usable, next, dispatcherReason) {
  if (!usable.length) {
    const reset = soonestReset(providers);
    return reset
      ? "Neither provider has usable quota. The next window resets at the time shown."
      : "Neither provider has usable quota, and no reset time was reported.";
  }
  if (usable.length === 1) return `${LABELS[usable[0].id]} is the only provider with quota, so it takes every task.`;
  const [claude, codex] = [providers[0].headroom ?? 0, providers[1].headroom ?? 0];
  // The dispatcher alternates inside a ten-point band. Saying so is the whole
  // point: it explains why two consecutive tasks got different providers.
  if (Math.abs(codex - claude) <= 10) return `${LABELS[next]} is next. The two are within ten points, so tasks alternate between them.`;
  return dispatcherReason ? `${dispatcherReason} takes the next task.` : `${LABELS[next]} has the most headroom, so it takes the next task.`;
}

function accountHeadroom(account) {
  const percents = (account?.windows || [])
    .filter((window) => window?.category === "usage" && DECIDING_CADENCES.has(window.cadence))
    .map((window) => window.remainingPercent)
    .filter((value) => Number.isFinite(value));
  return percents.length ? Math.min(...percents) : null;
}

function soonestAccountReset(accounts) {
  const times = accounts.flatMap((account) => account.windows.map((window) => window.resetAt)).filter(Boolean);
  return earliest(times);
}

function soonestReset(providers) {
  return earliest(providers.map((provider) => provider.resetAt).filter(Boolean));
}

function earliest(times) {
  let best = null;
  for (const value of times) {
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) continue;
    if (best === null || parsed < best.parsed) best = { parsed, value };
  }
  return best?.value || null;
}
