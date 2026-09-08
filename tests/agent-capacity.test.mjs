import assert from "node:assert/strict";
import test from "node:test";

import { agentCapacity } from "../server/agent-capacity.mjs";

function window(cadence, remainingPercent, resetAt = null) {
  return { cadence, label: cadence, category: "usage", remainingPercent, resetAt };
}

function account(overrides = {}) {
  return {
    id: "acct-1",
    label: "work@example.test",
    status: "ready",
    windows: [window("5h", 80), window("weekly", 60)],
    ...overrides,
  };
}

function usage({ claude = [account()], codex = [account({ id: "acct-2" })] } = {}) {
  return {
    providers: [
      { id: "claude", label: "Claude", available: true, accounts: claude },
      { id: "codex", label: "Codex", available: true, accounts: codex },
    ],
  };
}

test("the tighter deciding window sets an account's headroom", () => {
  // 5h at 80 and weekly at 20 means 20 is what runs out first, so 20 is the
  // number that decides. Reporting 80 would send work to a provider that stops
  // part-way through it.
  const capacity = agentCapacity(usage({ claude: [account({ windows: [window("5h", 80), window("weekly", 20)] })] }));
  assert.equal(capacity.providers[0].headroom, 20);
});

test("a reported monthly usage limit constrains eligibility too", () => {
  const claude = [account({ windows: [window("5h", 90), window("monthly", 2)] })];
  const capacity = agentCapacity(usage({ claude }));
  assert.equal(capacity.providers[0].headroom, null);
  assert.deepEqual(capacity.providers[0].accounts[0].windows.map((item) => item.cadence), ["5h", "monthly"]);
});

test("names the roomier provider when the two are far apart", () => {
  const capacity = agentCapacity(usage({
    claude: [account({ windows: [window("5h", 90), window("weekly", 90)] })],
    codex: [account({ id: "acct-2", windows: [window("5h", 20), window("weekly", 20)] })],
  }));

  assert.equal(capacity.next, "claude");
  assert.match(capacity.reason, /most reported headroom/);
  assert.equal(capacity.available, true);
});

// The behaviour that most confuses an operator: two consecutive tasks get
// different providers. Saying so is the point of the panel.
test("explains the alternation when the two are within ten points", () => {
  const capacity = agentCapacity(usage({
    claude: [account({ windows: [window("5h", 62), window("weekly", 62)] })],
    codex: [account({ id: "acct-2", windows: [window("5h", 58), window("weekly", 58)] })],
  }));

  assert.match(capacity.reason, /tasks alternate within a single plan/);
});

test("a provider below the floor cannot take work, and says the other is alone", () => {
  const capacity = agentCapacity(usage({
    claude: [account({ windows: [window("5h", 3), window("weekly", 3)] })],
    codex: [account({ id: "acct-2", windows: [window("5h", 70), window("weekly", 70)] })],
  }));

  assert.equal(capacity.providers[0].headroom, null, "below the floor is not usable");
  // The real number is still shown, so 3% does not read as "no data".
  assert.equal(capacity.providers[0].bestPercent, 3);
  assert.equal(capacity.next, "codex");
  assert.match(capacity.reason, /only provider with reported usable quota/);
});

test("an exhausted pair reports the soonest reset instead of a provider", () => {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const capacity = agentCapacity(usage({
    claude: [account({ status: "exhausted", windows: [window("5h", 0, later), window("weekly", 0, later)] })],
    codex: [account({ id: "acct-2", status: "exhausted", windows: [window("5h", 0, soon), window("weekly", 0, later)] })],
  }));

  assert.equal(capacity.available, false);
  assert.equal(capacity.next, null);
  assert.equal(capacity.nextReset, soon, "the soonest window is the only actionable fact");
  assert.match(capacity.reason, /No provider has usable quota/);
});

test("an exhausted pair with no reported reset says so rather than inventing one", () => {
  const capacity = agentCapacity(usage({
    claude: [account({ status: "exhausted", windows: [window("5h", 0), window("weekly", 0)] })],
    codex: [account({ id: "acct-2", status: "exhausted", windows: [window("5h", 0), window("weekly", 0)] })],
  }));

  assert.equal(capacity.nextReset, null);
  assert.match(capacity.reason, /Check limits/);
});

test("an account that needs reconnection does not count as capacity", () => {
  const capacity = agentCapacity(usage({
    claude: [account({ status: "reconnect", windows: [window("5h", 95), window("weekly", 95)] })],
    codex: [account({ id: "acct-2", windows: [window("5h", 40), window("weekly", 40)] })],
  }));

  assert.equal(capacity.providers[0].headroom, null);
  assert.equal(capacity.next, "codex");
});

test("the best account wins for the provider, not the worst", () => {
  const claude = [
    account({ id: "a", windows: [window("5h", 10), window("weekly", 10)] }),
    account({ id: "b", windows: [window("5h", 75), window("weekly", 75)] }),
  ];
  const capacity = agentCapacity(usage({ claude }));
  assert.equal(capacity.providers[0].headroom, 75);
  assert.deepEqual(capacity.providers[0].accounts.map((item) => item.headroom), [10, 75]);
});

test("no usage at all degrades to a shape the panel can render", () => {
  const capacity = agentCapacity(null);
  assert.equal(capacity.available, false);
  assert.equal(capacity.next, null);
  assert.deepEqual(capacity.providers.map((item) => item.id), ["claude", "codex"]);
  assert.deepEqual(capacity.providers.map((item) => item.headroom), [null, null]);
  assert.deepEqual(capacity.providers[0].accounts, []);
});

// The panel and the dispatcher must never disagree about who runs next.
test("the verdict comes from the dispatcher's own rule", async () => {
  const { assignAgents } = await import("../server/worktree-planner.mjs");
  const snapshot = usage({
    claude: [account({ windows: [window("5h", 88), window("weekly", 88)] })],
    codex: [account({ id: "acct-2", windows: [window("5h", 30), window("weekly", 30)] })],
  });
  const [dispatched] = assignAgents([{ id: "t1" }], snapshot);
  assert.equal(agentCapacity(snapshot).next, dispatched.agent);
});

test("opportunities keep account identity, observation age and blocked capacity", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const snapshot = agentCapacity(usage({ claude: [account({ id: "work", label: "Work", paused: true,
    updatedAt: "2026-09-07T11:00:00Z", windows: [window("5h", 0), window("weekly", 60, "2026-09-07T15:00:00Z")] })] }), now);
  const work = snapshot.providers[0].accounts[0];
  assert.equal(work.label, "Work");
  assert.equal(work.opportunity.remainingPercent, 60);
  assert.equal(work.eligibility, "paused");
  assert.equal(work.freshness, "stale");
  assert.equal(snapshot.next, "codex");
});

test("opportunities exclude low balances, past, missing and distant resets", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  for (const [percent, reset] of [[19, "2026-09-07T15:00:00Z"], [60, null], [60, "bad"], [60, "2026-09-07T11:00:00Z"], [60, "2026-09-09T15:00:00Z"]]) {
    const snapshot = agentCapacity(usage({ claude: [account({ windows: [window("weekly", percent, reset)] })] }), now);
    assert.equal(snapshot.providers[0].accounts[0].opportunity, null);
  }
});

test("unknown telemetry and known blocks have different capacity states", () => {
  assert.equal(agentCapacity(null).state, "unknown");
  const blocked = agentCapacity(usage({ claude: [account({ paused: true })], codex: [account({ status: "reconnect" })] }));
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.next, null);
});

test("past resets are not advertised as the next reset", () => {
  const snapshot = agentCapacity(usage({ claude: [account({ windows: [window("weekly", 40, "2020-01-01T00:00:00Z")] })] }));
  assert.equal(snapshot.nextReset, null);
});
