import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDeadline } from "../server/app.mjs";
import { CmuxCommandError } from "../server/cmux-client.mjs";
import { deploymentStatus, launchAgentIsRunning } from "../server/deployment-health.mjs";


import { buildTestApp as buildApp } from "./helpers/api-app.mjs";

const TOKEN = "test-token-that-is-deliberately-long-and-private";
const WS_ID = "11111111-2222-4333-8444-555555555555";
const TERM_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fakeCmux() {
  const calls = [];
  return {
    bin: "/fake/cmux",
    calls,
    hostStatus: async () => ({ mac_display_name: "Test Mac", workspace_count: 1 }),
    workspaceList: async () => ({
      groups: [],
      workspaces: [{
        id: WS_ID,
        title: "companion test",
        has_unread: false,
        terminals: [{ id: TERM_ID, title: "test terminal", is_ready: true }],
      }],
    }),
    capabilities: async () => ({ methods: ["mobile.workspace.list", "surface.send_text"] }),
    terminalReplay: async (id, scrollback) => ({ surface_id: id, render_grid: { format: "cmux.render-grid.v1", columns: 80, rows: 24, scrollback_rows: Number(scrollback) } }),
    terminalViewport: async (id, viewport) => { calls.push(["viewport", id, viewport]); return { surface_id: id, columns: viewport.columns, rows: viewport.rows }; },
    readScreen: async (id, lines) => ({ text: `screen:${id}`, lines: Number(lines) }),
    sendText: async (id, text) => calls.push(["text", id, text]),
    sendPrompt: async (id, text) => calls.push(["prompt", id, text]),
    sendKey: async (id, key) => calls.push(["key", id, key]),
    selectWorkspace: async (id) => calls.push(["select", id]),
    workspaceCreate: async (value) => { calls.push(["create", value]); return { workspace_id: WS_ID }; },
    workspaceOverview: async () => ({ status: { effective: "working" }, todos: { items: [], progress: { completed: 0, total: 0 } }, metrics: null, surfaceHealth: null }),
    workspaceRename: async (id, title) => calls.push(["rename", id, title]),
    workspaceClose: async (id) => calls.push(["close", id]),
    workspaceRespawn: async (id, surfaceId) => calls.push(["respawn", id, surfaceId]),
    todoAction: async (id, todoId, action) => calls.push(["todo", id, todoId, action]),
    pendingFeed: async () => ({ items: [] }),
    notifications: async () => ({ notifications: [] }),
    feedReply: async (id, kind, body) => calls.push(["reply", id, kind, body]),
    markNotificationRead: async (id) => calls.push(["read", id]),
  };
}

async function pairedCookie(app) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/pair",
    headers: { host: "mac.tail.test", origin: "https://mac.tail.test", "x-forwarded-proto": "https" },
    payload: { token: TOKEN },
  });
  assert.equal(response.statusCode, 200);
  return response.headers["set-cookie"].split(";")[0];
}

async function appWithUpdaterState(t, state, releaseSha = "a".repeat(40), updaterEnabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-companion-health-"));
  const updaterStatePath = join(directory, "state.json");
  const updaterConfigPath = join(directory, "updater.json");
  if (state !== undefined) await writeFile(updaterStatePath, JSON.stringify(state));
  await writeFile(updaterConfigPath, JSON.stringify({ enabled: updaterEnabled }));
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, updaterStatePath, updaterConfigPath, updaterProcessCheck: async () => true, releaseVersion: { gitSha: releaseSha, builtAt: null } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, cookie: await pairedCookie(app) };
}

test("health is public while cmux data requires pairing", async (t) => {
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, releaseVersion: { gitSha: "a".repeat(40), builtAt: "2026-08-31T00:00:00.000Z" } });
  t.after(() => app.close());
  const health = await app.inject({ url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().version.gitSha, "a".repeat(40));
  assert.equal((await app.inject({ url: "/api/updater/status" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/bootstrap" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/account-usage" })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/terminals/${TERM_ID}/replay` })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: "wrong" } })).statusCode, 401);
});

test("malformed cookies preserve public health, reject unauthenticated reads and allow pairing", async (t) => {
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN });
  t.after(() => app.close());
  const headers = { cookie: "cmux_session=%" };
  assert.equal((await app.inject({ url: "/api/health", headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/bootstrap", headers })).statusCode, 401);
  const paired = await app.inject({ method: "POST", url: "/api/auth/pair", headers, payload: { token: TOKEN } });
  assert.equal(paired.statusCode, 200);
  const cookie = `${headers.cookie}; ${paired.headers["set-cookie"].split(";")[0]}`;
  assert.equal((await app.inject({ url: "/api/bootstrap", headers: { cookie } })).statusCode, 200);
});

test("requires launchctl to report a running updater process with a pid", () => {
  assert.equal(launchAgentIsRunning("state = running\n\tpid = 74825\n"), true);
  assert.equal(launchAgentIsRunning("state = exited\n\tlast exit code = 1\n"), false);
  assert.equal(launchAgentIsRunning("state = running\n\tlast exit code = 0\n"), false);
});

test("reports both Companion and updater as healthy when deployed versions are current", async (t) => {
  const companionSha = "a".repeat(40);
  const updaterSha = "b".repeat(40);
  const { app, cookie } = await appWithUpdaterState(t, {
    deployedSha: companionSha, observedRemoteSha: companionSha, pendingSha: null, quarantinedSha: null,
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: updaterSha, updaterQuarantinedSha: null,
    phase: "idle", lastCheckAt: new Date().toISOString(), lastSuccessAt: "2026-09-01T12:08:30.471Z",
  }, companionSha);
  const response = await app.inject({ url: "/api/updater/status", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.summary, "healthy");
  assert.equal(body.services.companion.runningSha, companionSha);
  assert.equal(body.services.companion.status, "current");
  assert.equal(body.services.updater.status, "current");
  assert.equal(body.services.updater.alive, true);
  assert.equal(body.deployedSha, companionSha);
});

test("reports a pending Companion deployment as updating", async (t) => {
  const deployedSha = "a".repeat(40);
  const pendingSha = "c".repeat(40);
  const updaterSha = "b".repeat(40);
  const { app, cookie } = await appWithUpdaterState(t, {
    deployedSha, observedRemoteSha: pendingSha, pendingSha,
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: updaterSha,
    phase: "fetching", lastCheckAt: new Date().toISOString(),
  }, deployedSha);
  const body = (await app.inject({ url: "/api/updater/status", headers: { cookie } })).json();
  assert.equal(body.summary, "updating");
  assert.equal(body.services.companion.status, "updating");
  assert.equal(body.services.updater.status, "current");
});

test("surfaces updater failures and quarantined versions as a problem", async (t) => {
  const companionSha = "a".repeat(40);
  const deployedUpdaterSha = "b".repeat(40);
  const remoteUpdaterSha = "c".repeat(40);
  const { app, cookie } = await appWithUpdaterState(t, {
    deployedSha: companionSha, observedRemoteSha: companionSha,
    updaterDeployedSha: deployedUpdaterSha, updaterObservedRemoteSha: remoteUpdaterSha, updaterQuarantinedSha: remoteUpdaterSha,
    phase: "failed", lastCheckAt: new Date().toISOString(), lastError: "Updater health check failed",
  }, companionSha);
  const body = (await app.inject({ url: "/api/updater/status", headers: { cookie } })).json();
  assert.equal(body.summary, "attention");
  assert.equal(body.services.companion.status, "current");
  assert.equal(body.services.updater.status, "problem");
  assert.equal(body.services.updater.healthy, false);
  assert.equal(body.lastError, "Updater health check failed");
});

test("does not call a stale updater heartbeat alive", async (t) => {
  const companionSha = "a".repeat(40);
  const updaterSha = "b".repeat(40);
  const { app, cookie } = await appWithUpdaterState(t, {
    deployedSha: companionSha, observedRemoteSha: companionSha,
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: updaterSha,
    phase: "idle", lastCheckAt: "2026-08-31T00:00:00.000Z",
  }, companionSha);
  const body = (await app.inject({ url: "/api/updater/status", headers: { cookie } })).json();
  assert.equal(body.summary, "attention");
  assert.equal(body.services.companion.status, "current");
  assert.equal(body.services.updater.alive, false);
  assert.equal(body.services.updater.status, "unknown");
});

test("keeps a running updater alive during a long rollout", async (t) => {
  const companionSha = "a".repeat(40);
  const updaterSha = "b".repeat(40);
  const remoteUpdaterSha = "c".repeat(40);
  const lastCheckAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const { app, cookie } = await appWithUpdaterState(t, {
    deployedSha: companionSha, observedRemoteSha: companionSha,
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: remoteUpdaterSha,
    phase: "building", lastCheckAt,
  }, companionSha);
  const body = (await app.inject({ url: "/api/updater/status", headers: { cookie } })).json();
  assert.equal(body.services.updater.alive, true);
  assert.equal(body.services.updater.status, "updating");
});

test("recognizes retry backoff but never lets an update mask another service needing attention", () => {
  const now = Date.parse("2026-09-01T12:10:00.000Z");
  const companionSha = "a".repeat(40);
  const updaterSha = "b".repeat(40);
  const backoff = deploymentStatus({
    deployedSha: companionSha, observedRemoteSha: companionSha,
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: updaterSha,
    phase: "failed", lastCheckAt: "2026-09-01T12:05:00.000Z", nextEligibleCheckAt: "2026-09-01T12:12:00.000Z",
  }, { gitSha: companionSha }, now, { updaterProcessRunning: true });
  assert.equal(backoff.services.updater.alive, true);
  assert.equal(backoff.summary, "attention");

  const mixed = deploymentStatus({
    deployedSha: companionSha, observedRemoteSha: "c".repeat(40), pendingSha: "c".repeat(40),
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: updaterSha,
    phase: "building", lastCheckAt: "2026-09-01T12:10:00.000Z",
  }, { gitSha: companionSha }, now, { updaterProcessRunning: false });
  assert.equal(mixed.services.companion.status, "updating");
  assert.equal(mixed.services.updater.status, "unknown");
  assert.equal(mixed.summary, "attention");
});

test("reports disabled automatic updates as paused", async (t) => {
  const companionSha = "a".repeat(40);
  const updaterSha = "b".repeat(40);
  const { app, cookie } = await appWithUpdaterState(t, {
    deployedSha: companionSha, observedRemoteSha: companionSha,
    updaterDeployedSha: updaterSha, updaterObservedRemoteSha: updaterSha,
    phase: "idle", lastCheckAt: new Date().toISOString(),
  }, companionSha, false);
  const body = (await app.inject({ url: "/api/updater/status", headers: { cookie } })).json();
  assert.equal(body.enabled, false);
  assert.equal(body.summary, "paused");
  assert.equal(body.services.companion.status, "current");
  assert.equal(body.services.updater.status, "paused");
});

test("reports updater status as unavailable when its state file cannot be read", async (t) => {
  const { app, cookie } = await appWithUpdaterState(t, undefined);
  const response = await app.inject({ url: "/api/updater/status", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { available: false });
});

test("renews the one-year session cookie during authenticated use", async (t) => {
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const response = await app.inject({ url: "/api/bootstrap", headers: { cookie, host: "mac.tail.test", "x-forwarded-proto": "https" } });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"], /Max-Age=31536000/);
  assert.match(response.headers["set-cookie"], /Secure/);
  const bearer = await app.inject({ url: "/api/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.headers["set-cookie"], undefined);
  const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" } });
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  assert.doesNotMatch(logout.headers["set-cookie"], /Max-Age=31536000/);
});

test("serves authenticated CCS account usage and forwards explicit refresh", async (t) => {
  const calls = [];
  const value = { source: "CCS", providers: [], summary: {} };
  const accountUsage = { snapshot: async (options) => { calls.push(options); return value; } };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, accountUsage });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const response = await app.inject({ url: "/api/account-usage?refresh=1", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().source, "CCS");
  assert.deepEqual(calls, [{ refresh: true }]);
});

test("protects and serves the CCS reconnect lifecycle", async (t) => {
  const calls = [];
  const session = { sessionId: "reconnect-session", provider: "codex", status: "waiting", message: "Complete login", authUrl: "https://auth.test", expiresAt: "2026-09-01T00:00:00.000Z" };
  const ccsReconnect = {
    start: async (id) => { calls.push(["start", id]); return session; },
    status: async (id) => { calls.push(["status", id]); return session; },
    submitCallback: async (id, url) => { calls.push(["callback", id, url]); return { ...session, status: "success" }; },
    cancel: (id) => { calls.push(["cancel", id]); return { ...session, status: "cancelled" }; },
  };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, ccsReconnect });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  assert.equal((await app.inject({ method: "POST", url: "/api/account-usage/0123456789abcdefabcd/reconnect" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/account-usage/0123456789abcdefabcd/reconnect", headers: { ...headers, origin: "https://evil.test" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/account-usage/0123456789abcdefabcd/reconnect", headers })).statusCode, 201);
  assert.equal((await app.inject({ url: "/api/account-usage/reconnect/reconnect-session", headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/account-usage/reconnect/reconnect-session/callback", headers, payload: { callbackUrl: "http://localhost/callback" } })).json().status, "success");
  assert.equal((await app.inject({ method: "DELETE", url: "/api/account-usage/reconnect/reconnect-session", headers })).json().status, "cancelled");
  assert.deepEqual(calls, [
    ["start", "0123456789abcdefabcd"], ["status", "reconnect-session"],
    ["callback", "reconnect-session", "http://localhost/callback"], ["cancel", "reconnect-session"],
  ]);
});

test("paired clients can read state and safely control a terminal", async (t) => {
  const cmux = fakeCmux();
  const savedImages = [];
  const imageAttachments = { save: async (dataUrl, name) => { savedImages.push([dataUrl, name]); return { path: "/private/image.png", name, mime: "image/png", size: 68 }; } };
  const app = await buildApp(t, { cmux, token: TOKEN, imageAttachments });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);

  const bootstrap = await app.inject({ url: "/api/bootstrap", headers: { cookie } });
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.json().workspaces[0].id, WS_ID);

  const screen = await app.inject({ url: `/api/terminals/${TERM_ID}/screen?lines=44`, headers: { cookie } });
  assert.equal(screen.statusCode, 200);
  assert.equal(screen.json().lines, 44);

  const replay = await app.inject({ url: `/api/terminals/${TERM_ID}/replay?scrollback=123`, headers: { cookie } });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().mode, "grid");
  assert.equal(replay.json().render_grid.scrollback_rows, 123);

  const viewport = await app.inject({
    method: "POST",
    url: `/api/terminals/${TERM_ID}/viewport`,
    headers: { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { clientId: "phone-client-123", generation: 1, columns: 42, rows: 18 },
  });
  assert.equal(viewport.statusCode, 200);
  assert.deepEqual(cmux.calls[0], ["viewport", TERM_ID, { clientId: "phone-client-123", generation: 1, columns: 42, rows: 18, clear: false }]);

  const image = await app.inject({
    method: "POST",
    url: "/api/attachments/images",
    headers: { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { dataUrl: "data:image/png;base64,aW1hZ2U=", name: "paste.png" },
  });
  assert.equal(image.statusCode, 201);
  assert.equal(image.json().image.path, "/private/image.png");
  assert.deepEqual(savedImages[0], ["data:image/png;base64,aW1hZ2U=", "paste.png"]);

  const input = await app.inject({
    method: "POST",
    url: `/api/terminals/${TERM_ID}/input`,
    headers: { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { text: "continue", enter: true },
  });
  assert.equal(input.statusCode, 200);
  assert.deepEqual(cmux.calls[1], ["prompt", TERM_ID, "continue"]);
});

test("coalesces concurrent dashboard refreshes", async (t) => {
  const cmux = fakeCmux();
  let hostCalls = 0;
  let workspaceCalls = 0;
  let capabilityCalls = 0;
  cmux.hostStatus = async () => { hostCalls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return {}; };
  cmux.workspaceList = async () => { workspaceCalls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { workspaces: [] }; };
  cmux.capabilities = async () => { capabilityCalls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return {}; };
  const app = await buildApp(t, { cmux, token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.inject({ url: "/api/bootstrap", headers: { cookie } })));
  assert.equal(responses.every((response) => response.statusCode === 200), true);
  assert.deepEqual([hostCalls, workspaceCalls, capabilityCalls], [1, 1, 1]);
});

test("falls back to an authenticated text screen when replay is unavailable", async (t) => {
  const cmux = fakeCmux();
  cmux.terminalReplay = async () => { throw new CmuxCommandError("unsupported"); };
  const app = await buildApp(t, { cmux, token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const fallback = await app.inject({ url: `/api/terminals/${TERM_ID}/replay?scrollback=77`, headers: { cookie } });
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.json().mode, "text");
  assert.equal(fallback.json().lines, 77);
});

test("paired clients cannot mutate from a foreign origin", async (t) => {
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const response = await app.inject({
    method: "POST",
    url: `/api/terminals/${TERM_ID}/key`,
    headers: { cookie, host: "mac.tail.test", origin: "https://evil.test" },
    payload: { key: "enter" },
  });
  assert.equal(response.statusCode, 403);
});

test("keeps the dashboard available while cmux is closed", async (t) => {
  const cmux = fakeCmux();
  cmux.workspaceList = async () => { throw new Error("socket unavailable"); };
  cmux.hostStatus = async () => { throw new Error("socket unavailable"); };
  cmux.capabilities = async () => { throw new Error("socket unavailable"); };
  const app = await buildApp(t, { cmux, token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const response = await app.inject({ url: "/api/bootstrap", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().connected, false);
  assert.deepEqual(response.json().workspaces, []);
  assert.equal(response.json().error, "Waiting for cmux");
});

test("answers bootstrap as waiting when cmux never replies", async (t) => {
  const cmux = fakeCmux();
  cmux.workspaceList = () => new Promise(() => {});
  cmux.hostStatus = () => new Promise(() => {});
  cmux.capabilities = () => new Promise(() => {});
  const app = await buildApp(t, { cmux, token: TOKEN, bootstrapTimeoutMs: 25 });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const response = await app.inject({ url: "/api/bootstrap", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().connected, false);
  assert.equal(response.json().error, "Waiting for cmux");
  assert.deepEqual(response.json().workspaces, []);
});

test("a deadline does not change a promise that settles in time", async () => {
  assert.equal(await withDeadline(Promise.resolve("value"), 5_000, "too slow"), "value");
  await assert.rejects(withDeadline(Promise.reject(new TypeError("real cause")), 5_000, "too slow"), /real cause/);
  // A non-positive budget means "no deadline", so the promise passes through.
  assert.equal(await withDeadline(Promise.resolve("value"), 0, "too slow"), "value");
});

test("launches only catalogued repositories and exposes overview state", async (t) => {
  const cmux = fakeCmux();
  const repo = { id: "repo-safe", name: "safe", path: "/approved/safe", scripts: ["test"] };
  const repoCatalog = {
    cache: null,
    get: async (id) => { if (id !== repo.id) throw new TypeError("Unknown repository"); return repo; },
    list: async () => [repo],
    changes: async () => ({ repo, files: [] }),
    diff: async () => ({ file: "x", patch: "diff" }),
    pullRequest: async () => ({ available: true, pullRequest: { number: 7, title: "Open PR" } }),
  };
  const app = await buildApp(t, { cmux, token: TOKEN, repoCatalog });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const launched = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { repoId: repo.id, agent: "codex", prompt: "test it", script: null } });
  assert.equal(launched.statusCode, 201);
  assert.deepEqual(cmux.calls.at(-1)[0], "create");
  assert.equal((await app.inject({ url: `/api/workspaces/${WS_ID}/overview`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/repos", headers: { cookie } })).json().repos[0].id, repo.id);
  assert.equal((await app.inject({ url: `/api/repos/${repo.id}/pull-request`, headers: { cookie } })).json().pullRequest.number, 7);
});

test("serves authenticated Markdown and repository assets", async (t) => {
  const cmux = fakeCmux();
  const repo = { id: "repo-safe", name: "safe", path: "/approved/safe", scripts: [] };
  const repoCatalog = {
    get: async (id) => { if (id !== repo.id) throw new TypeError("Unknown repository"); return repo; },
    list: async () => [repo],
    markdown: async (_id, file) => ({ repo, path: file, name: "README.md", content: "# Safe" }),
    asset: async () => ({ mime: "image/png", content: Buffer.from([0x89, 0x50]) }),
  };
  const app = await buildApp(t, { cmux, token: TOKEN, repoCatalog });
  const cookie = await pairedCookie(app);
  const markdown = await app.inject({ url: `/api/repos/${repo.id}/markdown?file=README.md`, headers: { cookie } });
  assert.equal(markdown.json().content, "# Safe");
  const asset = await app.inject({ url: `/api/repos/${repo.id}/assets?file=flow.png`, headers: { cookie } });
  assert.equal(asset.headers["content-type"], "image/png");
});

test("model settings require pairing and a safe origin, then affect manual agent launches", async (t) => {
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN, repoCatalog: { get: async () => ({ id: "repo", path: "/repo", name: "Repo", scripts: [] }) } });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/settings/models" })).statusCode, 401);
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const payload = { roles: { coder: { models: { codex: "custom-coder" } } } };
  assert.equal((await app.inject({ method: "PATCH", url: "/api/settings/models", headers: { ...headers, origin: "https://evil.test" }, payload })).statusCode, 403);
  const saved = await app.inject({ method: "PATCH", url: "/api/settings/models", headers, payload });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().roles.coder.models.codex, "custom-coder");
  assert.equal((await app.inject({ url: "/api/settings/models", headers })).json().roles.coder.models.codex, "custom-coder");
  const launched = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { repoId: "repo", agent: "codex", prompt: "Implement" } });
  assert.equal(launched.statusCode, 201);
  assert.equal(cmux.calls.find(([kind]) => kind === "create")[1].model, "custom-coder");
  const rejected = await app.inject({ method: "PATCH", url: "/api/settings/models", headers, payload: { roles: { coder: { models: { codex: "--help" } } } } });
  assert.equal(rejected.statusCode, 400);
  assert.equal((await app.inject({ url: "/api/settings/models", headers })).json().roles.coder.models.codex, "custom-coder");
});

test("write schemas reject coercion and unknown controls before invoking cmux", async t => {
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}` };
  for (const payload of [{ text: "hello", enter: "false" }, { text: 42 }, { text: "hello", shell: true }]) {
    const response = await app.inject({ method: "POST", url: `/api/terminals/${TERM_ID}/input`, headers, payload });
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(cmux.calls, []);
  const valid = await app.inject({ method: "POST", url: `/api/terminals/${TERM_ID}/input`, headers, payload: { text: "hello", enter: false } });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(cmux.calls, [["text", TERM_ID, "hello"]]);
});
