import assert from "node:assert/strict";
import test from "node:test";
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
