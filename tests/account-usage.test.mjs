import assert from "node:assert/strict";
import test from "node:test";
import { AccountUsage, cadenceFromDuration, exactCodexWindows, findCcsPackageRoot } from "../server/account-usage.mjs";

function source({ delay = 0 } = {}) {
  const accounts = {
    claude: [
      { id: "one@example.test", email: "one@example.test", nickname: "one", isDefault: true, tokenFile: "secret.json" },
      { id: "two@example.test", email: "two@example.test", nickname: "two", isDefault: false },
    ],
    codex: [{ id: "codex@example.test", email: "codex@example.test", nickname: "codex", isDefault: true }],
  };
  const wait = async () => { if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); };
  return {
    getProviderAccounts: (provider) => accounts[provider],
    fetchAllClaudeQuotas: async () => {
      await wait();
      return [
        { account: "one@example.test", quota: { success: true, accessToken: "must-never-leak", lastUpdated: 1_788_000_000_000, windows: [
          { rateLimitType: "five_hour", label: "Session limit", remainingPercent: 82, resetAt: "2026-09-01T12:00:00.000Z" },
          { rateLimitType: "seven_day", label: "Weekly limit", remainingPercent: 19, resetAt: "2026-09-05T12:00:00.000Z" },
        ] } },
        { account: "two@example.test", quota: { success: true, lastUpdated: 1_788_000_000_000, windows: [{ rateLimitType: "seven_day", label: "Weekly limit", remainingPercent: 0 }] } },
      ];
    },
    fetchAllCodexQuotas: async () => {
      await wait();
      return [{ account: "codex@example.test", quota: { success: false, needsReauth: true, error: "raw upstream token detail", accountId: "sensitive-id", windows: [] } }];
    },
  };
}

test("normalizes CCS accounts and exposes only sanitized usage data", async () => {
  const usage = new AccountUsage({ sourceLoader: async () => source() });
  const value = await usage.snapshot({ refresh: true });
  assert.equal(value.source, "CCS");
  assert.equal(value.available, true);
  assert.deepEqual(value.summary, { ready: 0, low: 1, exhausted: 1, reconnect: 1, unavailable: 0 });
  const claude = value.providers.find((provider) => provider.id === "claude");
  assert.equal(claude.accounts.length, 2);
  assert.equal(claude.accounts[0].status, "low");
  assert.deepEqual(claude.accounts[0].windows.map((window) => window.cadence), ["5h", "weekly"]);
  assert.equal(claude.accounts[1].status, "exhausted");
  const codex = value.providers.find((provider) => provider.id === "codex").accounts[0];
  assert.equal(codex.status, "reconnect");
  assert.equal(codex.message, "Reconnect this account in CCS");
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /must-never-leak|raw upstream token detail|secret\.json|sensitive-id/);
});

test("caches snapshots and coalesces concurrent refreshes", async () => {
  let loads = 0;
  const usage = new AccountUsage({ sourceLoader: async () => { loads += 1; return source({ delay: 15 }); } });
  const values = await Promise.all([usage.snapshot({ refresh: true }), usage.snapshot({ refresh: true }), usage.snapshot()]);
  assert.equal(loads, 1);
  assert.equal(values.every((value) => value === values[0]), true);
  assert.equal(await usage.snapshot(), values[0]);
  assert.equal(loads, 1);
});

test("returns a safe unavailable response when CCS cannot be loaded", async () => {
  const usage = new AccountUsage({ sourceLoader: async () => { throw new Error("/private/path and token"); } });
  const value = await usage.snapshot({ refresh: true });
  assert.equal(value.available, false);
  assert.equal(value.providers.length, 2);
  assert.doesNotMatch(JSON.stringify(value), /private\/path|token/);
});

test("discovers the installed CCS package without a hard-coded Node version", () => {
  const root = findCcsPackageRoot();
  assert.match(root, /@kaitranntt\/ccs$/);
});

test("uses Codex provider window durations for accurate cadence labels", () => {
  assert.deepEqual([18_000, 86_400, 604_800, 2_592_000, 3_600].map(cadenceFromDuration), ["5h", "daily", "weekly", "monthly", "other"]);
  const windows = exactCodexWindows({ plan_type: "pro", rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 25, limit_window_seconds: 2_592_000, reset_at: 1_900_000_000 },
  }, additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 18_000, reset_at: 1_800_000_000 } } }] });
  assert.deepEqual(windows.map((window) => [window.cadence, window.remainingPercent, window.category]), [
    ["weekly", 88, "usage"], ["monthly", 75, "usage"], ["5h", 96, "additional"],
  ]);
});
