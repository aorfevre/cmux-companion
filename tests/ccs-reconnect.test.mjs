import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcsReconnectManager, validateCallbackUrl } from "../server/ccs-reconnect.mjs";

const STATE = "secure-state-123";
const AUTH_URL = `https://auth.openai.test/authorize?redirect_uri=${encodeURIComponent("http://localhost:1455/auth/callback")}&state=${STATE}&code_challenge=private-challenge`;
const CALLBACK_URL = `http://localhost:1455/auth/callback?code=private-code&state=${STATE}`;

function fixture({ target = { provider: "codex", accountId: "raw-private-account", nickname: "work" }, changedToken = { file: "private-token.json" } } = {}) {
  const calls = [];
  const accountUsage = {
    resolveReconnectTarget: async (id) => { calls.push(["resolve", id]); return target; },
    invalidate: () => calls.push(["invalidate"]),
  };
  const source = {
    start: async (provider) => { calls.push(["start", provider]); return { authUrl: AUTH_URL, state: STATE }; },
    poll: async () => "wait",
    submitCallback: async (provider, url) => calls.push(["callback", provider, url]),
    listTokens: () => [{ file: "existing.json", fingerprint: "old" }],
    findChangedToken: () => changedToken,
    register: (provider, nickname, expected) => { calls.push(["register", provider, nickname, expected]); return { id: expected, provider }; },
  };
  return { manager: new CcsReconnectManager({ accountUsage, sourceLoader: async () => source }), calls };
}

test("validates the exact localhost callback target, code, and OAuth state", () => {
  assert.equal(validateCallbackUrl(CALLBACK_URL, AUTH_URL), null);
  assert.match(validateCallbackUrl(`http://localhost:1455/auth/callback?code=x&state=wrong`, AUTH_URL), /different login/);
  assert.match(validateCallbackUrl(`https://evil.test/auth/callback?code=x&state=${STATE}`, AUTH_URL), /does not match/);
  assert.match(validateCallbackUrl(`http://localhost:1455/auth/callback?state=${STATE}`, AUTH_URL), /missing/);
});

test("reconnects only a server-resolved account and never exposes CCS identifiers", async () => {
  const { manager, calls } = fixture();
  const started = await manager.start("0123456789abcdefabcd");
  assert.equal(started.provider, "codex");
  assert.equal(started.status, "waiting");
  assert.ok(started.authUrl.startsWith("https://auth.openai.test/"));
  assert.doesNotMatch(JSON.stringify(started), /raw-private-account|private-token/);
  const finished = await manager.submitCallback(started.sessionId, CALLBACK_URL);
  assert.equal(finished.status, "success");
  assert.deepEqual(calls.find((call) => call[0] === "register"), ["register", "codex", "work", "raw-private-account"]);
  assert.equal(calls.some((call) => call[0] === "invalidate"), true);
  assert.doesNotMatch(JSON.stringify(finished), /private-code|private-challenge|raw-private-account|private-token/);
});

test("rejects accounts that are not in the reconnect allow-list", async () => {
  await assert.rejects(() => fixture({ target: null }).manager.start("0123456789abcdefabcd"), /does not need to reconnect/);
  await assert.rejects(() => fixture({ target: { provider: "gemini", accountId: "raw" } }).manager.start("0123456789abcdefabcd"), /does not need to reconnect/);
});

function tick(ms = 5) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("finishes a login automatically when CCS reports the OAuth state as completed", async () => {
  const { manager, calls } = fixture();
  let pollState = null;
  const source = {
    start: async () => ({ authUrl: AUTH_URL, state: STATE }),
    poll: async (state) => { pollState = state; return "ok"; },
    submitCallback: async () => { throw new Error("must not submit"); },
    listTokens: () => [],
    findChangedToken: () => ({ file: "fresh.json" }),
    register: () => ({ id: "raw-private-account" }),
  };
  manager.sourceLoader = async () => source;
  const started = await manager.start("0123456789abcdefabcd");
  const first = await manager.status(started.sessionId);
  assert.equal(pollState, STATE);
  assert.equal(first.status, "success");
  assert.equal(first.authUrl, null);
  assert.equal(calls.some((call) => call[0] === "invalidate"), true);
  assert.equal((await manager.status(started.sessionId)).status, "success");
});

test("keeps waiting when CCS status polling fails or the login is still pending", async () => {
  const { manager } = fixture();
  let polls = 0;
  const source = {
    start: async () => ({ authUrl: AUTH_URL, state: STATE }),
    poll: async () => { polls += 1; if (polls === 1) throw new Error("ccs offline"); return "wait"; },
    submitCallback: async () => {},
    listTokens: () => [],
    findChangedToken: () => null,
    register: () => null,
  };
  manager.sourceLoader = async () => source;
  const started = await manager.start("0123456789abcdefabcd");
  assert.equal((await manager.status(started.sessionId)).status, "waiting");
  await tick();
  assert.equal((await manager.status(started.sessionId)).status, "waiting");
  assert.equal(polls, 2);
  const again = await manager.start("0123456789abcdefabcd");
  assert.equal(again.sessionId, started.sessionId);
});

test("marks the session as failed when the callback cannot be completed", async () => {
  const { manager } = fixture();
  const source = {
    start: async () => ({ authUrl: AUTH_URL, state: STATE }),
    poll: async () => "wait",
    submitCallback: async () => { throw new Error("upstream secret detail"); },
    listTokens: () => [],
    findChangedToken: () => null,
    register: () => null,
  };
  manager.sourceLoader = async () => source;
  const started = await manager.start("0123456789abcdefabcd");
  const result = await manager.submitCallback(started.sessionId, CALLBACK_URL);
  assert.equal(result.status, "error");
  assert.doesNotMatch(JSON.stringify(result), /upstream secret detail/);
  assert.equal(result.authUrl, null);
  // A finished session ignores further callbacks and cannot be cancelled away from its outcome.
  assert.equal((await manager.submitCallback(started.sessionId, CALLBACK_URL)).status, "error");
  assert.equal(manager.cancel(started.sessionId).status, "error");
});

test("fails when no new token is saved within the grace window", async () => {
  let now = 1_000_000;
  const { manager } = fixture();
  manager.now = () => now;
  manager.tokenGraceMs = 0;
  const source = {
    start: async () => ({ authUrl: AUTH_URL, state: STATE }),
    poll: async () => "wait",
    submitCallback: async () => {},
    listTokens: () => [],
    findChangedToken: () => { now += 1; return null; },
    register: () => { throw new Error("must not register"); },
  };
  manager.sourceLoader = async () => source;
  const started = await manager.start("0123456789abcdefabcd");
  assert.equal((await manager.submitCallback(started.sessionId, CALLBACK_URL)).status, "processing");
  await tick(300);
  const result = await manager.status(started.sessionId);
  assert.equal(result.status, "error");
  assert.match(result.message, /Start a new login/);
});

test("fails when CCS refuses to register the changed token", async () => {
  const { manager, calls } = fixture({ target: { provider: "claude", accountId: "" } });
  const source = {
    start: async () => ({ authUrl: AUTH_URL, state: STATE }),
    poll: async () => "wait",
    submitCallback: async () => {},
    listTokens: () => [],
    findChangedToken: () => ({ file: "claude-new.json" }),
    register: (provider, nickname, expected) => { calls.push(["register", provider, nickname, expected]); return null; },
  };
  manager.sourceLoader = async () => source;
  const started = await manager.start("0123456789abcdefabcd");
  await tick();
  await manager.submitCallback(started.sessionId, CALLBACK_URL);
  const result = await manager.submitCallback(started.sessionId, CALLBACK_URL);
  assert.equal(result.status, "error");
  assert.deepEqual(calls.find((call) => call[0] === "register"), ["register", "claude", undefined, "claude-new.json"]);
  assert.equal(calls.some((call) => call[0] === "invalidate"), false);
});

test("rejects callbacks that do not match the login and awaits an in-flight completion", async () => {
  const { manager } = fixture();
  let release;
  const source = {
    start: async () => ({ authUrl: AUTH_URL, state: STATE }),
    poll: async () => "wait",
    submitCallback: () => new Promise((resolve) => { release = resolve; }),
    listTokens: () => [],
    findChangedToken: () => ({ file: "token.json" }),
    register: () => ({ id: "x" }),
  };
  manager.sourceLoader = async () => source;
  const started = await manager.start("0123456789abcdefabcd");
  await assert.rejects(() => manager.submitCallback(started.sessionId, "not a url"), { statusCode: 400, message: /full localhost callback/ });
  const processing = await manager.submitCallback(started.sessionId, CALLBACK_URL);
  assert.equal(processing.status, "processing");
  assert.equal(processing.authUrl, started.authUrl);
  const second = manager.submitCallback(started.sessionId, CALLBACK_URL);
  release();
  assert.equal((await second).status, "success");
});

test("cancels a waiting login and refuses unknown or expired sessions", async () => {
  let now = 5_000_000;
  const { manager } = fixture();
  manager.now = () => now;
  const started = await manager.start("0123456789abcdefabcd");
  assert.throws(() => manager.cancel(42), { statusCode: 404, message: "Unknown reconnect session" });
  assert.throws(() => manager.cancel("missing"), { statusCode: 404, message: /Unknown or expired/ });
  const cancelled = manager.cancel(started.sessionId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.authUrl, null);
  assert.equal(manager.cancel(started.sessionId).status, "cancelled");

  const fresh = await manager.start("0123456789abcdefabcd");
  assert.notEqual(fresh.sessionId, started.sessionId);
  now += manager.sessionTtlMs + 1;
  const expired = await manager.status(fresh.sessionId);
  assert.equal(expired.status, "expired");
  assert.equal(expired.message, "Reconnect session expired");
  assert.equal(manager.cancel(fresh.sessionId).status, "expired");
  now += manager.sessionTtlMs + 1;
  await assert.rejects(() => manager.status(fresh.sessionId), { statusCode: 404 });
});

test("refuses logins whose authorization URL is not a secure URL bound to the OAuth state", async () => {
  for (const started of [
    { authUrl: "http://auth.openai.test/authorize?state=abc", state: "abc" },
    { authUrl: AUTH_URL, state: "different-state-value" },
    { authUrl: "https://auth.openai.test/authorize" },
    null,
  ]) {
    const { manager } = fixture();
    manager.sourceLoader = async () => ({ start: async () => started, listTokens: () => [] });
    await assert.rejects(() => manager.start("0123456789abcdefabcd"), { statusCode: 503, message: /secure login/ });
  }
});

test("rejects callbacks whose login has no valid redirect target", () => {
  assert.match(validateCallbackUrl(CALLBACK_URL, "https://auth.openai.test/authorize?state=x"), /no valid callback/);
  assert.match(validateCallbackUrl(CALLBACK_URL, "not a url"), /full localhost callback/);
  assert.equal(validateCallbackUrl(`http://[::1]:1455/auth/callback?code=c&state=${STATE}`, AUTH_URL.replace("localhost", "[::1]")), null);
});

// A fake CCS package on disk exercises the real loader: module resolution,
// management URL/header construction and the token/registration wiring.
function installFakeCcs(t, { isRemote = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccs-reconnect-pkg-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, body, mode = 0o644) => {
    mkdirSync(join(root, relative, ".."), { recursive: true });
    writeFileSync(join(root, relative), body, { mode });
  };
  write("package.json", JSON.stringify({ name: "@kaitranntt/ccs" }));
  write("dist/cli.js", "#!/usr/bin/env node\n", 0o755);
  write("dist/cliproxy/proxy/proxy-target-resolver.js", `
    exports.getProxyTarget = () => ({ isRemote: ${isRemote}, host: "127.0.0.1", port: 8317 });
    exports.buildProxyUrl = (target, path) => "http://" + target.host + ":" + target.port + path;
    exports.buildManagementHeaders = (target, headers) => ({ ...headers, "X-Management-Key": "mgmt-secret" });
  `);
  write("dist/cliproxy/auth/auth-types.js", `
    exports.getManagementAuthUrlPath = (provider) => "/v0/management/" + provider + "-auth-url";
    exports.getManagementOAuthCallbackPath = () => "/v0/management/oauth-callback";
    exports.CLIPROXY_CALLBACK_PROVIDER_MAP = { claude: "anthropic" };
  `);
  write("dist/cliproxy/auth/token-manager.js", `
    const calls = [];
    exports.calls = calls;
    exports.listProviderTokenSnapshots = (provider) => [{ file: provider + "-old.json", fingerprint: "old" }];
    exports.findNewTokenSnapshot = (current, known, expected) => { calls.push(["find", known, expected]); return { file: "fresh.json" }; };
    exports.getProviderTokenDir = (provider) => "/tokens/" + provider;
    exports.registerAccountFromToken = (...args) => { calls.push(["register", ...args]); return { id: args[4] }; };
  `);
  const bin = join(root, "dist", "cli.js");
  const previous = process.env.CCS_BIN;
  process.env.CCS_BIN = bin;
  t.after(() => { if (previous === undefined) delete process.env.CCS_BIN; else process.env.CCS_BIN = previous; });
  return root;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const result = handler(new URL(String(url)), options);
    return { ok: result.ok ?? true, json: async () => result.body };
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

test("loads the local CCS management API and completes a reconnect through it", async (t) => {
  const root = installFakeCcs(t);
  const requests = stubFetch(t, (url) => {
    if (url.pathname === "/v0/management/claude-auth-url") return { body: { status: "ok", url: AUTH_URL, state: STATE } };
    if (url.pathname === "/v0/management/get-auth-status") return { body: { status: "ok" } };
    if (url.pathname === "/v0/management/oauth-callback") return { body: { status: "ok" } };
    return { ok: false, body: {} };
  });
  const invalidations = [];
  const manager = new CcsReconnectManager({ accountUsage: {
    resolveReconnectTarget: async () => ({ provider: "claude", accountId: "person@example.test", nickname: "personal" }),
    invalidate: () => invalidations.push(1),
  } });
  const started = await manager.start("0123456789abcdefabcd");
  assert.equal(started.status, "waiting");
  assert.equal(requests[0].options.headers["X-Management-Key"], "mgmt-secret");
  const submitted = await manager.submitCallback(started.sessionId, CALLBACK_URL);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finished = submitted.status === "success" ? submitted : await manager.status(started.sessionId);
  assert.equal(finished.status, "success");
  const callback = requests.find((request) => request.url.endsWith("/oauth-callback"));
  assert.equal(callback.options.method, "POST");
  assert.deepEqual(JSON.parse(callback.options.body), { provider: "anthropic", redirect_url: CALLBACK_URL });
  const { createRequire } = await import("node:module");
  const tokens = createRequire(import.meta.url)(join(root, "dist", "cliproxy", "auth", "token-manager.js"));
  assert.deepEqual(tokens.calls.find((call) => call[0] === "find"), ["find", [{ file: "claude-old.json", fingerprint: "old" }], "person@example.test"]);
  assert.deepEqual(tokens.calls.find((call) => call[0] === "register"), ["register", "claude", "/tokens/claude", "personal", false, "person@example.test"]);
  assert.equal(invalidations.length, 1);

  // Automatic polling asks CCS for the exact OAuth state.
  const second = await manager.start("fedcba9876543210fedc");
  const polled = await manager.status(second.sessionId);
  assert.ok(["success", "waiting"].includes(polled.status));
  const poll = requests.find((request) => request.url.includes("get-auth-status"));
  assert.equal(new URL(poll.url).searchParams.get("state"), STATE);
});

test("treats CCS management errors as a failed login start", async (t) => {
  installFakeCcs(t);
  stubFetch(t, () => ({ ok: true, body: { status: "error", error: "raw failure" } }));
  const manager = new CcsReconnectManager({ accountUsage: { resolveReconnectTarget: async () => ({ provider: "codex", accountId: "a" }), invalidate() {} } });
  await assert.rejects(() => manager.start("0123456789abcdefabcd"), /CCS OAuth request failed/);
  stubFetch(t, () => ({ ok: false, body: null }));
  await assert.rejects(() => manager.start("0123456789abcdefabcd"), /CCS OAuth request failed/);
});

test("refuses to reconnect through a remote CCS", async (t) => {
  installFakeCcs(t, { isRemote: true });
  const manager = new CcsReconnectManager({ accountUsage: { resolveReconnectTarget: async () => ({ provider: "codex", accountId: "a" }), invalidate() {} } });
  await assert.rejects(() => manager.start("0123456789abcdefabcd"), { statusCode: 503, message: /only for CCS running on this Mac/ });
});

test("requires account usage to be supplied", () => {
  assert.throws(() => new CcsReconnectManager(), /Account usage is required/);
});

test("blocks deletion during reconnect and serializes account changes", async () => {
  const { manager } = fixture();
  let release;
  manager.accountUsage.removeConnection = () => new Promise(resolve => { release = resolve; });
  const session = await manager.start('account');
  await assert.rejects(manager.removeConnection('account'), { statusCode: 409 });
  manager.cancel(session.sessionId);
  const removing = manager.removeConnection('account');
  await assert.rejects(manager.start('account'), { statusCode: 409 });
  await assert.rejects(manager.removeConnection('account'), { statusCode: 409 });
  release({ removed: true });
  assert.deepEqual(await removing, { removed: true });
});

test('cancelled reconnect completion cannot restore a connection being deleted', async () => {
  const { manager, calls } = fixture();
  let release;
  const originalLoader = manager.sourceLoader;
  manager.sourceLoader = async () => ({ ...await originalLoader(), submitCallback: () => new Promise(resolve => { release = resolve; }) });
  manager.accountUsage.removeConnection = async () => ({ removed: true });
  const session = await manager.start('account');
  await manager.submitCallback(session.sessionId, CALLBACK_URL);
  manager.cancel(session.sessionId);
  await assert.rejects(manager.removeConnection('account'), { statusCode: 409 });
  release();
  await tick();
  assert.equal(calls.some(call => call[0] === 'register'), false);
  assert.deepEqual(await manager.removeConnection('account'), { removed: true });
});
