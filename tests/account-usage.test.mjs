import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountUsage, cadenceFromDuration, exactClaudeWindows, exactCodexWindows, findCcsPackageRoot } from "../server/account-usage.mjs";

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
  assert.equal(value.providers.length, 3);
  assert.doesNotMatch(JSON.stringify(value), /private\/path|token/);
});

test("treats authenticated accounts without reported windows as connected", async () => {
  const empty = source();
  empty.fetchAllClaudeQuotas = async () => [{ account: "one@example.test", quota: { success: true, lastUpdated: 1_788_000_000_000, windows: [] } }];
  empty.getProviderAccounts = (provider) => provider === "claude" ? [{ id: "one@example.test", email: "one@example.test" }] : [];
  empty.fetchAllCodexQuotas = async () => [];
  const value = await new AccountUsage({ sourceLoader: async () => empty }).snapshot({ refresh: true });
  const account = value.providers[0].accounts[0];
  assert.equal(account.status, "ready");
  assert.equal(account.message, "Connected. Provider reported no active usage window.");
  assert.equal(value.summary.unavailable, 0);
});

test("discovers a symlinked CCS package without a hard-coded Node version", (t) => {
  // Exercise the real filesystem resolver without a developer's global install.
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "ccs-discovery-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const version = join(fixture, "versions", "node", "v99.1.2");
  const root = join(version, "lib", "node_modules", "@kaitranntt", "ccs");
  const bin = join(version, "bin");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@kaitranntt/ccs" }));
  const executable = join(root, "dist", "cli.js");
  writeFileSync(executable, "#!/usr/bin/env node\n", { mode: 0o755 });
  const ccsBin = join(bin, "ccs");
  symlinkSync(executable, ccsBin);
  assert.equal(findCcsPackageRoot({ ccsBin, pathValue: "" }), root);
  assert.equal(findCcsPackageRoot({ ccsBin: "", pathValue: bin }), root);
});

test("keeps Claude core windows when the provider reports no reset time", () => {
  const windows = exactClaudeWindows({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 0, resets_at: null },
    seven_day_opus: null,
  });
  assert.deepEqual(windows.map((window) => [window.cadence, window.category, window.remainingPercent, window.resetAt]), [
    ["5h", "usage", 100, null],
    ["weekly", "usage", 100, null],
  ]);
});

test("promotes the most restrictive Claude weekly window and demotes the rest", () => {
  const windows = exactClaudeWindows({
    five_hour: { utilization: 20, resets_at: "2026-09-01T23:30:00.000Z" },
    seven_day: { utilization: 4, resets_at: "2026-09-02T08:00:00.000Z" },
    seven_day_opus: { utilization: 61, resets_at: "2026-09-02T08:00:00.000Z" },
  });
  assert.deepEqual(windows.map((window) => [window.label, window.cadence, window.category, window.remainingPercent]), [
    ["Session limit", "5h", "usage", 80],
    ["Weekly limit", "weekly", "additional", 96],
    ["Opus weekly limit", "weekly", "usage", 39],
  ]);
});

test("ignores Claude payloads that carry no usable window", () => {
  assert.deepEqual(exactClaudeWindows(null), []);
  assert.deepEqual(exactClaudeWindows({ five_hour: { utilization: "n/a" }, extra_usage: { utilization: 10 } }), []);
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

test("Kimi quotas remain available without CCS and never expose the subscription key", async () => {
  const { kimiUsage, exactKimiWindows } = await import("../server/kimi-usage.mjs");
  const payload = { usage: { limit: 100, used: 30, resetAt: "2026-09-10T00:00:00Z" }, limits: [
    { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 200, remaining: 0, reset_in: 60 } },
    { detail: { limit: 100 } }, { detail: { limit: 0, used: 0 } }, { detail: { limit: null, used: null } },
  ] };
  const windows = exactKimiWindows(payload, 0);
  assert.deepEqual(windows.map((window) => [window.cadence, window.remainingPercent]), [["weekly", 70], ["5h", 0]]);
  assert.equal(windows[1].resetAt, "1970-01-01T00:01:00.000Z");
  const fetcher = async (url, options) => {
    assert.equal(url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(options.headers.Authorization, "Bearer private-kimi-key");
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => payload };
  };
  const usage = new AccountUsage({ sourceLoader: async () => { throw new Error("No CCS"); }, kimiLoader: () => kimiUsage({ key: "private-kimi-key", fetcher }) });
  const value = await usage.snapshot();
  assert.equal(value.available, true);
  assert.equal(value.providers[2].accounts[0].status, "exhausted");
  assert.equal(value.summary.exhausted, 1);
  assert.doesNotMatch(JSON.stringify(value), /private-kimi-key/);
  const unavailable = await kimiUsage({ key: "private-kimi-key", fetcher: async () => { throw new Error("private-kimi-key"); } });
  assert.equal(unavailable.available, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /private-kimi-key/);
  const disabled = await kimiUsage({ key: "", fetcher: () => { throw new Error("Must not fetch"); } });
  assert.equal(disabled.accounts.length, 0);
});

test("missing provider values cannot become zero usage or full capacity", async () => {
  for (const utilization of [null, false, "", " ", [], {}]) assert.deepEqual(exactClaudeWindows({ five_hour: { utilization } }), []);
  assert.deepEqual(exactCodexWindows({ rate_limit: { primary_window: { used_percent: null, usedPercent: null } } }), []);
  const ccs = source();
  ccs.fetchAllClaudeQuotas = async () => [{ account: "one@example.test", quota: { success: true, windows: [{ remainingPercent: null, cadence: "weekly" }] } }];
  const value = await new AccountUsage({ sourceLoader: async () => ccs }).snapshot();
  assert.deepEqual(value.providers[0].accounts[0].windows, []);
  assert.equal(value.providers[0].accounts[0].status, "ready");
});
