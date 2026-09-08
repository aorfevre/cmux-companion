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
  assert.equal(value.providers.length, 2);
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

// A fake CCS package on disk exercises the real loader: module resolution,
// token discovery on disk and the exact quota fetchers behind a stubbed fetch.
function installFakeCcs(t, { claudeAccounts = [], codexAccounts = [], withConfig = true, authDir, pausedDir, codexAuth = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccs-usage-pkg-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, body, mode = 0o644) => {
    mkdirSync(join(root, relative, ".."), { recursive: true });
    writeFileSync(join(root, relative), body, { mode });
  };
  write("package.json", JSON.stringify({ name: "@kaitranntt/ccs" }));
  write("dist/cli.js", "#!/usr/bin/env node\n", 0o755);
  write("dist/cliproxy/accounts/account-manager.js", `
    const accounts = ${JSON.stringify({ claude: claudeAccounts, codex: codexAccounts })};
    exports.getProviderAccounts = (provider) => accounts[provider] || [];
    ${pausedDir ? `exports.getPausedDir = () => ${JSON.stringify(pausedDir)};` : "exports.getPausedDir = () => { throw new Error('no paused dir'); };"}
  `);
  write("dist/cliproxy/quota/quota-fetcher-claude.js", `
    exports.calls = [];
    exports.fetchAllClaudeQuotas = async () => { throw new Error("bulk fetch must not be used"); };
    exports.fetchClaudeQuota = async (accountId) => { exports.calls.push(accountId); return { success: false, error: "fallback", accountId }; };
  `);
  write("dist/cliproxy/quota/quota-fetcher-codex.js", `
    exports.calls = [];
    exports.fetchAllCodexQuotas = async () => { throw new Error("bulk fetch must not be used"); };
    exports.readCodexAuthData = () => (${JSON.stringify(codexAuth)});
    exports.fetchCodexQuota = async (accountId) => { exports.calls.push(accountId); return { success: false, error: "fallback", accountId }; };
  `);
  if (withConfig) write("dist/cliproxy/config/config-generator.js", `exports.getAuthDir = () => ${JSON.stringify(authDir || join(root, "missing-auth"))};`);
  const previous = process.env.CCS_BIN;
  process.env.CCS_BIN = join(root, "dist", "cli.js");
  t.after(() => { if (previous === undefined) delete process.env.CCS_BIN; else process.env.CCS_BIN = previous; });
  return root;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const result = await handler(String(url), options);
    return { ok: result.ok ?? true, json: async () => result.body };
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

function claudeAccount(id, extra = {}) { return { id, email: id, nickname: id.split("@")[0], ...extra }; }

test("resolves reconnect targets only for opaque ids of accounts that need reauth", async () => {
  const usage = new AccountUsage({ sourceLoader: async () => source() });
  const snapshot = await usage.snapshot({ refresh: true });
  const codex = snapshot.providers.find((provider) => provider.id === "codex").accounts[0];
  const claude = snapshot.providers.find((provider) => provider.id === "claude").accounts[0];
  assert.deepEqual(await usage.resolveReconnectTarget(codex.id), { provider: "codex", accountId: "codex@example.test", nickname: "codex" });
  assert.equal(await usage.resolveReconnectTarget(claude.id), null);
  assert.equal(await usage.resolveReconnectTarget("codex@example.test"), null);
  assert.equal(await usage.resolveReconnectTarget(42), null);
  assert.equal(await usage.resolveReconnectTarget("0123456789abcdefabcd"), null);
  usage.invalidate();
  assert.equal(usage.cache, null);
});

test("returns no reconnect target when CCS no longer lists the account", async () => {
  let listed = true;
  const base = source();
  const usage = new AccountUsage({ sourceLoader: async () => ({
    ...base,
    getProviderAccounts: (provider) => {
      if (!listed && provider === "codex") throw new Error("account store locked");
      return base.getProviderAccounts(provider);
    },
  }) });
  const snapshot = await usage.snapshot({ refresh: true });
  const codex = snapshot.providers.find((provider) => provider.id === "codex").accounts[0];
  listed = false;
  assert.equal(await usage.resolveReconnectTarget(codex.id), null);
});

test("tolerates account stores that throw or return non-arrays and labels unknown cadences", async () => {
  const broken = source();
  broken.getProviderAccounts = (provider) => { if (provider === "claude") throw new Error("locked"); return { not: "an array" }; };
  broken.fetchAllClaudeQuotas = async () => [{ account: "only-quota@example.test", quota: { success: true, windows: [
    { remainingPercent: 50, label: "Mystery" },
    { remainingPercent: 40, cadence: "monthly", featureLabel: "" },
    { remainingPercent: "n/a" },
  ] } }];
  broken.fetchAllCodexQuotas = async () => { throw new Error("codex down"); };
  const value = await new AccountUsage({ sourceLoader: async () => broken }).snapshot({ refresh: true });
  const claude = value.providers.find((provider) => provider.id === "claude");
  assert.equal(claude.available, true);
  assert.equal(claude.accounts.length, 1);
  assert.equal(claude.accounts[0].label, "only-quota@example.test");
  assert.deepEqual(claude.accounts[0].windows.map((window) => [window.cadence, window.label]), [["other", "Mystery"], ["monthly", "Monthly limit"]]);
  const codex = value.providers.find((provider) => provider.id === "codex");
  assert.equal(codex.available, false);
  assert.deepEqual(codex.accounts, []);
});

test("throws when no CCS executable resolves to the CCS package", (t) => {
  // homedir() honours HOME, so an empty home hides any nvm-installed CCS.
  const home = mkdtempSync(join(tmpdir(), "ccs-empty-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); });
  assert.throws(() => findCcsPackageRoot({ ccsBin: join(tmpdir(), "missing-ccs-bin"), pathValue: join(tmpdir(), "missing-ccs-path") }), /CCS is not installed/);
});

test("rejects an installed CCS without quota support", async (t) => {
  const root = installFakeCcs(t);
  writeFileSync(join(root, "dist", "cliproxy", "quota", "quota-fetcher-codex.js"), "exports.nothing = true;\n");
  const value = await new AccountUsage().snapshot({ refresh: true });
  assert.equal(value.available, false);
});

test("reads a fresh Claude token from disk and fetches the exact usage payload", async (t) => {
  const authDir = mkdtempSync(join(tmpdir(), "ccs-auth-"));
  t.after(() => rmSync(authDir, { recursive: true, force: true }));
  const pausedDir = join(authDir, "paused");
  mkdirSync(pausedDir);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  writeFileSync(join(authDir, "claude-active_example_test.json"), JSON.stringify({ type: "claude", email: "active@example.test", access_token: "live-token", expired: future }));
  writeFileSync(join(authDir, "claude-stale.json"), JSON.stringify({ type: "claude", email: "stale@example.test", access_token: "stale-token", expired: "2020-01-01T00:00:00.000Z" }));
  writeFileSync(join(authDir, "claude-broken.json"), "{not json");
  writeFileSync(join(authDir, "claude-wrong-type.json"), JSON.stringify({ type: "codex", email: "active@example.test", access_token: "wrong" }));
  writeFileSync(join(authDir, "claude-empty.json"), JSON.stringify({ type: "claude", email: "active@example.test", access_token: " " }));
  writeFileSync(join(authDir, "notes.txt"), "ignored");
  writeFileSync(join(pausedDir, "anthropic-nested.json"), JSON.stringify({ token: { access_token: "nested-token", expiry: future }, email: "nested@example.test" }));
  installFakeCcs(t, {
    authDir, pausedDir,
    claudeAccounts: [claudeAccount("active@example.test"), claudeAccount("stale@example.test"), claudeAccount("nested@example.test")],
  });
  const requests = stubFetch(t, (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(options.headers["anthropic-beta"], "oauth-2025-04-20");
    if (options.headers.Authorization === "Bearer nested-token") return { body: { five_hour: null } };
    return { body: { five_hour: { utilization: 30, resets_at: "2026-09-08T12:00:00.000Z" }, seven_day: { utilization: 85 } } };
  });
  const value = await new AccountUsage().snapshot({ refresh: true });
  const claude = value.providers.find((provider) => provider.id === "claude");
  const byEmail = Object.fromEntries(claude.accounts.map((account) => [account.email, account]));
  assert.equal(byEmail["active@example.test"].status, "low");
  assert.deepEqual(byEmail["active@example.test"].windows.map((window) => [window.cadence, window.remainingPercent]), [["5h", 70], ["weekly", 15]]);
  // Expired token falls back to the CCS fetcher; an empty exact payload does too.
  assert.equal(byEmail["stale@example.test"].status, "unavailable");
  assert.equal(byEmail["nested@example.test"].status, "unavailable");
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(value), /live-token|nested-token|stale-token/);
});

test("falls back to the CCS Claude fetcher when the exact usage request fails", async (t) => {
  const authDir = mkdtempSync(join(tmpdir(), "ccs-auth-"));
  t.after(() => rmSync(authDir, { recursive: true, force: true }));
  writeFileSync(join(authDir, "claude-a.json"), JSON.stringify({ email: "a@example.test", access_token: "a-token" }));
  writeFileSync(join(authDir, "claude-b.json"), JSON.stringify({ email: "b@example.test", access_token: "b-token" }));
  installFakeCcs(t, { authDir, withConfig: false, pausedDir: authDir, claudeAccounts: [claudeAccount("a@example.test"), claudeAccount("b@example.test")] });
  stubFetch(t, (url, options) => {
    if (options.headers.Authorization === "Bearer a-token") return { ok: false, body: {} };
    throw new Error("network down");
  });
  const value = await new AccountUsage().snapshot({ refresh: true });
  const claude = value.providers.find((provider) => provider.id === "claude");
  assert.deepEqual(claude.accounts.map((account) => account.status), ["unavailable", "unavailable"]);
  assert.equal(claude.available, true);
});

test("fetches exact Codex usage with the stored account credentials", async (t) => {
  installFakeCcs(t, {
    codexAccounts: [{ id: "codex@example.test", email: "codex@example.test", nickname: "codex" }],
    codexAuth: { accessToken: "codex-token", accountId: "acct_123", isExpired: false },
  });
  const requests = stubFetch(t, () => ({ body: {
    plan_type: "Plus",
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 600 } },
    code_review_rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: 0 } },
  } }));
  const value = await new AccountUsage().snapshot({ refresh: true });
  const account = value.providers.find((provider) => provider.id === "codex").accounts[0];
  assert.equal(requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requests[0].options.headers["ChatGPT-Account-Id"], "acct_123");
  assert.equal(account.status, "ready");
  assert.equal(account.plan, "plus");
  assert.deepEqual(account.windows.map((window) => [window.cadence, window.category, window.remainingPercent]), [["5h", "usage", 90], ["weekly", "code-review", 50]]);
  assert.ok(account.windows[0].resetAt);
  assert.equal(account.windows[1].resetAt, null);
  assert.doesNotMatch(JSON.stringify(value), /codex-token|acct_123/);
});

test("falls back to the CCS Codex fetcher without credentials or when the usage request fails", async (t) => {
  installFakeCcs(t, { codexAccounts: [{ id: "codex@example.test", email: "codex@example.test" }], codexAuth: { accessToken: "t", accountId: "acct", isExpired: false } });
  stubFetch(t, () => ({ ok: false, body: {} }));
  let value = await new AccountUsage().snapshot({ refresh: true });
  assert.equal(value.providers.find((provider) => provider.id === "codex").accounts[0].status, "unavailable");

  installFakeCcs(t, { codexAccounts: [{ id: "codex@example.test", email: "codex@example.test" }], codexAuth: { accessToken: "t", accountId: "acct", isExpired: false } });
  stubFetch(t, () => { throw new Error("offline"); });
  value = await new AccountUsage().snapshot({ refresh: true });
  assert.equal(value.providers.find((provider) => provider.id === "codex").accounts[0].status, "unavailable");

  installFakeCcs(t, { codexAccounts: [{ id: "codex@example.test", email: "codex@example.test" }], codexAuth: { accessToken: "t", accountId: "acct", isExpired: true } });
  const requests = stubFetch(t, () => ({ body: {} }));
  value = await new AccountUsage().snapshot({ refresh: true });
  assert.equal(value.providers.find((provider) => provider.id === "codex").accounts[0].status, "unavailable");
  assert.equal(requests.length, 0);
});
