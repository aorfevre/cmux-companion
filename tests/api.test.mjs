import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, normalizeInbox } from "../server/app.mjs";
import { CmuxCommandError } from "../server/cmux-client.mjs";
import { deploymentStatus, launchAgentIsRunning } from "../server/deployment-health.mjs";

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
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, updaterStatePath, updaterConfigPath, updaterProcessCheck: async () => true, releaseVersion: { gitSha: releaseSha, builtAt: null } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, cookie: await pairedCookie(app) };
}

test("health is public while cmux data requires pairing", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, releaseVersion: { gitSha: "a".repeat(40), builtAt: "2026-08-31T00:00:00.000Z" } });
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
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN });
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
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, accountUsage });
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
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, ccsReconnect });
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
  const app = await buildApp({ cmux, token: TOKEN, imageAttachments });
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
  const app = await buildApp({ cmux, token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.inject({ url: "/api/bootstrap", headers: { cookie } })));
  assert.equal(responses.every((response) => response.statusCode === 200), true);
  assert.deepEqual([hostCalls, workspaceCalls, capabilityCalls], [1, 1, 1]);
});

test("serves the worktree dashboard and creates worktrees and sessions", async (t) => {
  const cmux = fakeCmux();
  const target = { id: "worktree123456789", repoId: "repo-safe", repoName: "safe", branch: "feature/mobile", path: "/approved/safe-feature" };
  const value = { generatedAt: "2026-08-31T00:00:00.000Z", summary: { repositories: 1, worktrees: 1, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [] };
  const calls = [];
  const worktreeDashboard = {
    snapshot: async (input) => { calls.push(["snapshot", input]); return value; },
    create: async (id, input) => { calls.push(["create-worktree", id, input]); return { created: true, branchCreated: true, worktree: target }; },
    resolve: async (id) => { calls.push(["resolve", id]); if (id !== target.id) throw new TypeError("Unknown worktree"); return target; },
    remove: async (id, input) => { calls.push(["remove", id, input]); return { removed: true, branchPreserved: true }; },
    setRepositoryArchived: async (id, archived, input) => { calls.push(["archive", id, archived, input]); return { repository: { id, archived } }; },
    setRepositoryFavorite: async (id, favorite, input) => { calls.push(["favorite", id, favorite, input]); return { repository: { id, favorite } }; },
    invalidate: () => calls.push(["invalidate"]),
  };
  const app = await buildApp({ cmux, token: TOKEN, worktreeDashboard });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const dashboard = await app.inject({ url: "/api/worktree-dashboard?refresh=1&github=1", headers: { cookie } });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.json().summary.worktrees, 1);
  assert.deepEqual(calls[0], ["snapshot", { workspaces: (await cmux.workspaceList()).workspaces, refresh: true, refreshGitHub: true }]);
  const created = await app.inject({ method: "POST", url: "/api/worktree-dashboard/repositories/repository12345678/worktrees", headers, payload: { branch: "feature/mobile", base: "main" } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().worktree.path, target.path);
  const launched = await app.inject({ method: "POST", url: `/api/worktree-dashboard/${target.id}/launch`, headers, payload: { agent: "claude", prompt: "Review mobile UX" } });
  assert.equal(launched.statusCode, 201);
  assert.deepEqual(cmux.calls.at(-1), ["create", { cwd: target.path, title: "safe: feature/mobile", agent: "claude", prompt: "Review mobile UX" }]);
  const removed = await app.inject({ method: "DELETE", url: `/api/worktree-dashboard/${target.id}`, headers });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().branchPreserved, true);
  const archived = await app.inject({ method: "PATCH", url: "/api/worktree-dashboard/repositories/repository12345678/archive", headers, payload: { archived: true } });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().repository.archived, true);
  const favorited = await app.inject({ method: "PATCH", url: "/api/worktree-dashboard/repositories/repository12345678/favorite", headers, payload: { favorite: true } });
  assert.equal(favorited.statusCode, 200);
  assert.equal(favorited.json().repository.favorite, true);
  assert.deepEqual(calls.map((call) => call[0]), ["snapshot", "create-worktree", "resolve", "invalidate", "remove", "archive", "favorite"]);
});

test("analyzes, prepares, and bulk-launches GitHub issue topics through authenticated routes", async (t) => {
  const calls = [];
  const githubIssuePlanner = {
    analyze: async (input) => { calls.push(["analyze", input]); return { analysisId: "analysis-1", topics: [] }; },
    prepare: async (input) => { calls.push(["prepare", input]); return { analysisId: input.analysisId, results: [] }; },
    launch: async (input) => { calls.push(["launch", input]); return { requested: 1, launchedTopics: 1, launchedWorktrees: 2, results: [] }; },
  };
  const worktreeDashboard = { invalidate: () => calls.push(["invalidate"]) };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, githubIssuePlanner, worktreePlanner: {}, worktreeDashboard });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  assert.equal((await app.inject({ method: "POST", url: "/api/github-topic-plans/analyze", payload: { repositoryId: "repository12345678" } })).statusCode, 401);
  const analyzed = await app.inject({ method: "POST", url: "/api/github-topic-plans/analyze", headers, payload: { repositoryId: "repository12345678" } });
  assert.equal(analyzed.statusCode, 200);
  const prepared = await app.inject({ method: "POST", url: "/api/github-topic-plans/prepare", headers, payload: { analysisId: "analysis-1", topics: [{ id: "topic-1" }] } });
  assert.equal(prepared.statusCode, 200);
  const launched = await app.inject({ method: "POST", url: "/api/github-topic-plans/launch", headers, payload: { planIds: ["plan-1"] } });
  assert.equal(launched.json().launchedWorktrees, 2);
  assert.deepEqual(calls, [
    ["analyze", { repositoryId: "repository12345678" }],
    ["prepare", { analysisId: "analysis-1", topics: [{ id: "topic-1" }] }],
    ["launch", { planIds: ["plan-1"] }],
    ["invalidate"],
  ]);
});

test("falls back to an authenticated text screen when replay is unavailable", async (t) => {
  const cmux = fakeCmux();
  cmux.terminalReplay = async () => { throw new CmuxCommandError("unsupported"); };
  const app = await buildApp({ cmux, token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const fallback = await app.inject({ url: `/api/terminals/${TERM_ID}/replay?scrollback=77`, headers: { cookie } });
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.json().mode, "text");
  assert.equal(fallback.json().lines, 77);
});

test("paired clients cannot mutate from a foreign origin", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN });
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
  const app = await buildApp({ cmux, token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const response = await app.inject({ url: "/api/bootstrap", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().connected, false);
  assert.deepEqual(response.json().workspaces, []);
  assert.equal(response.json().error, "Waiting for cmux");
});

test("launches only catalogued repositories and exposes overview/inbox state", async (t) => {
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
  const app = await buildApp({ cmux, token: TOKEN, repoCatalog });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const launched = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { repoId: repo.id, agent: "codex", prompt: "test it", script: null } });
  assert.equal(launched.statusCode, 201);
  assert.deepEqual(cmux.calls.at(-1)[0], "create");
  assert.equal((await app.inject({ url: `/api/workspaces/${WS_ID}/overview`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/inbox", headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/repos", headers: { cookie } })).json().repos[0].id, repo.id);
  assert.equal((await app.inject({ url: `/api/repos/${repo.id}/pull-request`, headers: { cookie } })).json().pullRequest.number, 7);
});

test("serves Markdown, manages private previews, captures feedback, and controls the prompt queue", async (t) => {
  const cmux = fakeCmux();
  const repo = { id: "repo-safe", name: "safe", path: "/approved/safe", scripts: [] };
  const repoCatalog = {
    get: async (id) => { if (id !== repo.id) throw new TypeError("Unknown repository"); return repo; },
    list: async () => [repo],
    markdown: async (_id, file) => ({ repo, path: file, name: "README.md", content: "# Safe" }),
    asset: async () => ({ mime: "image/png", content: Buffer.from([0x89, 0x50]) }),
  };
  const calls = [];
  const preview = { id: "preview-safe", workspaceId: WS_ID, repoId: repo.id, targetPort: 3000, status: "detected" };
  const previewManager = {
    list: () => ({ previews: [preview], tailnetOnly: true }),
    syncWorkspaces: async () => {},
    discover: (value) => { calls.push(["discover", value]); return { preview, created: true }; },
    enable: async (id) => { calls.push(["enable", id]); return { preview: { ...preview, status: "active" } }; },
    stop: async (id) => { calls.push(["stop", id]); return { preview: { ...preview, status: "stopped" } }; },
    restart: async (id) => { calls.push(["restart", id]); return { preview: { ...preview, status: "active" } }; },
    remove: (id) => { calls.push(["remove", id]); return { removed: true }; },
    require: (id) => { if (id !== preview.id) throw new TypeError("Unknown preview"); return preview; },
  };
  const queued = { id: "11111111-2222-4333-8444-555555555555", workspaceId: WS_ID, surfaceId: TERM_ID, text: "queued" };
  const promptQueue = {
    attach: () => () => {}, on: () => {}, off: () => {},
    list: (query) => { calls.push(["queue-list", query]); return { items: [queued], count: 1 }; },
    enqueue: (body) => { calls.push(["queue-add", body]); return { item: queued, count: 1 }; },
    update: (id, body) => { calls.push(["queue-update", id, body]); return { item: { ...queued, text: body.text } }; },
    move: (id, direction) => { calls.push(["queue-move", id, direction]); return { item: queued }; },
    sendNow: async (id) => { calls.push(["queue-send", id]); return { sent: true, item: queued }; },
    remove: (id) => { calls.push(["queue-remove", id]); return { removed: true }; },
  };
  const previewCapture = async (input) => { calls.push(["capture", input]); return { buffer: Buffer.from("captured-png"), viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000/" }; };
  const app = await buildApp({ cmux, token: TOKEN, repoCatalog, previewManager, promptQueue, previewCapture });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const markdown = await app.inject({ url: `/api/repos/${repo.id}/markdown?file=README.md`, headers: { cookie } });
  assert.equal(markdown.json().content, "# Safe");
  const asset = await app.inject({ url: `/api/repos/${repo.id}/assets?file=flow.png`, headers: { cookie } });
  assert.equal(asset.headers["content-type"], "image/png");
  assert.equal((await app.inject({ url: "/api/previews", headers: { cookie } })).json().tailnetOnly, true);
  const detected = await app.inject({ method: "POST", url: "/api/previews/discover", headers, payload: { workspaceId: WS_ID, repoId: repo.id, port: 3000, url: "http://localhost:3000" } });
  assert.equal(detected.statusCode, 201);
  for (const action of ["enable", "stop", "restart"]) assert.equal((await app.inject({ method: "POST", url: `/api/previews/${preview.id}/${action}`, headers, payload: {} })).statusCode, 200);
  const capture = await app.inject({ method: "POST", url: `/api/previews/${preview.id}/capture`, headers, payload: { width: 390, height: 844 } });
  assert.equal(capture.statusCode, 201);
  assert.match(capture.json().dataUrl, /^data:image\/png;base64,/);
  assert.equal((await app.inject({ url: `/api/prompt-queue?workspaceId=${WS_ID}&surfaceId=${TERM_ID}`, headers: { cookie } })).json().count, 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/prompt-queue", headers, payload: { workspaceId: WS_ID, surfaceId: TERM_ID, text: "queued" } })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/api/prompt-queue", headers, payload: { workspaceId: WS_ID, surfaceId: "missing-terminal", text: "unsafe" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/prompt-queue/${queued.id}`, headers, payload: { text: "edited" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/prompt-queue/${queued.id}/move`, headers, payload: { direction: -1 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/prompt-queue/${queued.id}/send`, headers, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/prompt-queue/${queued.id}`, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/previews/${preview.id}`, headers })).statusCode, 200);
  assert.deepEqual(calls.map((call) => call[0]), ["discover", "enable", "stop", "restart", "capture", "queue-list", "queue-add", "queue-update", "queue-move", "queue-send", "queue-remove", "remove"]);
});

test("every state-changing route requires pairing and same-origin requests", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const mutations = [
    ["/api/auth/logout", {}],
    ["/api/workspaces", { repoId: "x" }],
    ["/api/worktree-dashboard/repositories/repository12345678/worktrees", { branch: "feature/safe", base: "main" }],
    ["/api/worktree-dashboard/worktree123456789/launch", { agent: "codex" }],
    ["/api/worktree-plans/plan-1/assemble", {}],
    ["/api/worktree-plans/plan-1/abort", {}],
    [`/api/workspaces/${WS_ID}/rename`, { title: "x" }],
    [`/api/workspaces/${WS_ID}/close`, {}],
    [`/api/workspaces/${WS_ID}/respawn`, { surfaceId: TERM_ID }],
    [`/api/workspaces/${WS_ID}/todos/${TERM_ID}/check`, {}],
    [`/api/terminals/${TERM_ID}/input`, { text: "x" }],
    [`/api/terminals/${TERM_ID}/key`, { key: "enter" }],
    [`/api/terminals/${TERM_ID}/viewport`, { clientId: "phone-client-123", generation: 1, columns: 42, rows: 18 }],
    ["/api/attachments/images", { dataUrl: "data:image/png;base64,aW1hZ2U=", name: "x.png" }],
    [`/api/workspaces/${WS_ID}/select`, {}],
    [`/api/inbox/${TERM_ID}/reply`, { kind: "permissionRequest", mode: "deny" }],
    [`/api/notifications/${TERM_ID}/read`, {}],
    ["/api/push/subscribe", {}],
    ["/api/push/settings", {}],
    ["/api/push/unsubscribe", {}],
    ["/api/push/test", {}],
    ["/api/previews/discover", { workspaceId: WS_ID, port: 3000 }],
    ["/api/previews/preview-safe/enable", {}],
    ["/api/previews/preview-safe/stop", {}],
    ["/api/previews/preview-safe/restart", {}],
    ["/api/previews/preview-safe/capture", {}],
    ["/api/prompt-queue", { workspaceId: WS_ID, surfaceId: TERM_ID, text: "x" }],
    ["/api/prompt-queue/11111111-2222-4333-8444-555555555555/move", { direction: 1 }],
    ["/api/prompt-queue/11111111-2222-4333-8444-555555555555/send", {}],
  ];
  for (const [url, payload] of mutations) {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401, url);
    assert.equal((await app.inject({ method: "POST", url, payload, headers: { cookie, host: "mac.tail.test", origin: "https://evil.test" } })).statusCode, 403, url);
  }
  const worktreeRemoval = "/api/worktree-dashboard/worktree123456789";
  assert.equal((await app.inject({ method: "DELETE", url: worktreeRemoval })).statusCode, 401);
  assert.equal((await app.inject({ method: "DELETE", url: worktreeRemoval, headers: { cookie, host: "mac.tail.test", origin: "https://evil.test" } })).statusCode, 403);
});

test("normalizes actionable requests separately from unread notifications", () => {
  const result = normalizeInbox({ items: [{ request_id: TERM_ID, kind: "permissionRequest", workspace_id: WS_ID, tool_name: "exec" }] }, { notifications: [{ id: WS_ID, title: "Done", is_read: false }, { id: TERM_ID, title: "Old", is_read: true }] });
  assert.equal(result.actionableCount, 1);
  assert.equal(result.unreadCount, 1);
  assert.deepEqual(result.items.map((item) => item.type), ["request", "notification"]);
});

function fakePlanner() {
  const calls = [];
  const draft = {
    planId: "plan-1",
    repositoryId: "repository12345678",
    goal: "Add billing",
    round: 1,
    status: "ready",
    questions: [],
    tasks: [{ id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", agent: "claude", agentReason: "Claude · best account 90% left" }],
  };
  return {
    calls,
    start: async (options) => { calls.push(["start", options]); return draft; },
    answer: async (planId, options) => { calls.push(["answer", planId, options]); return { ...draft, round: 2 }; },
    update: async (planId, options) => { calls.push(["update", planId, options]); return { ...draft, tasks: options.tasks }; },
    launch: async (planId) => { calls.push(["launch", planId]); return { planId, base: "origin/main", launched: 1, results: [{ id: "t1", title: "Billing", status: "launched" }] }; },
    list: async (options) => { calls.push(["list", options]); return { plans: [{ planId: "plan-1", goal: "Add billing", status: "draft", taskCount: 1 }] }; },
    detail: async (planId) => { calls.push(["detail", planId]); return { ...draft, events: [{ round: 0, kind: "goal", payload: { goal: "Add billing" }, createdAt: "2026-09-01T00:00:00.000Z" }] }; },
    resume: async (planId) => { calls.push(["resume", planId]); return draft; },
    remove: async (planId) => { calls.push(["remove", planId]); return { planId, deleted: true }; },
    startBackground: async (options) => { calls.push(["startBackground", options]); return { ...draft, round: 0, status: "questions", tasks: [], running: true }; },
    answerBackground: async (planId, options) => { calls.push(["answerBackground", planId, options]); return { ...draft, running: true }; },
    run: async (planId) => { calls.push(["run", planId]); return { ...draft, round: 0, running: true }; },
    feedback: async (planId, options) => { calls.push(["feedback", planId, options]); return { ...draft, round: 3 }; },
    feedbackBackground: async (planId, options) => { calls.push(["feedbackBackground", planId, options]); return { ...draft, running: true }; },
    activeRuns: () => { calls.push(["activeRuns"]); return { runs: [{ planId: "plan-1", kind: "plan", phase: "running", stage: "writing_spec", step: "Read app/page.tsx", startedAt: 1, finishedAt: null }] }; },
    abort: async (planId) => { calls.push(["abort", planId]); return { planId, aborted: true, alreadyAborted: false, closedSessionIds: ["ws-1"], failedSessionIds: ["ws-2"] }; },
  };
}

test("lists, reloads, resumes and deletes saved plans", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };

  const listed = await app.inject({ method: "GET", url: "/api/worktree-plans?repositoryId=repository12345678&status=draft&limit=10", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().plans[0].planId, "plan-1");
  assert.deepEqual(planner.calls[0][1], { repositoryId: "repository12345678", status: "draft", limit: "10" });

  const detail = await app.inject({ method: "GET", url: "/api/worktree-plans/plan-1", headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().events[0].kind, "goal");

  const resumed = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/resume", headers, payload: {} });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().planId, "plan-1");

  const deleted = await app.inject({ method: "DELETE", url: "/api/worktree-plans/plan-1", headers });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { planId: "plan-1", deleted: true });
  assert.deepEqual(planner.calls.map((call) => call[0]), ["list", "detail", "resume", "remove"]);
});

test("lists every plan when no filter is given", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const listed = await app.inject({ method: "GET", url: "/api/worktree-plans", headers });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(planner.calls[0][1], { repositoryId: null, status: null, limit: undefined });
});

test("turns an unknown saved plan into a 400", async (t) => {
  const planner = fakePlanner();
  planner.detail = async () => { throw new TypeError("Unknown plan. Start a new goal"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "GET", url: "/api/worktree-plans/nope", headers });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Unknown plan/);
});

test("starts a background plan round and reports it as running", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };

  const started = await app.inject({ method: "POST", url: "/api/worktree-plans", headers, payload: { repositoryId: "repository12345678", goal: "Add billing", background: true } });
  assert.equal(started.statusCode, 202);
  assert.equal(started.json().running, true);
  assert.equal(started.json().planId, "plan-1");
  assert.equal(planner.calls[0][0], "startBackground");

  const answered = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/answers", headers, payload: { skip: true, background: true } });
  assert.equal(answered.statusCode, 202);
  assert.equal(planner.calls[1][0], "answerBackground");
  assert.equal(planner.calls[1][2].skip, true);

  const runs = await app.inject({ method: "GET", url: "/api/worktree-plans/runs", headers });
  assert.equal(runs.statusCode, 200);
  assert.equal(runs.json().runs[0].planId, "plan-1");
  assert.equal(runs.json().runs[0].phase, "running");

  const rerun = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/run", headers, payload: {} });
  assert.equal(rerun.statusCode, 202);
  assert.equal(planner.calls.at(-1)[0], "run");
});

test("routes reviewer feedback to a new planner round, awaited or in the background", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };

  const awaited = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/feedback", headers, payload: { text: "These tasks share a file." } });
  assert.equal(awaited.statusCode, 200);
  assert.equal(awaited.json().round, 3);
  assert.deepEqual(planner.calls[0][2], { text: "These tasks share a file.", onEvent: null });

  const background = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/feedback", headers, payload: { text: "Still wrong.", background: true } });
  assert.equal(background.statusCode, 202);
  assert.equal(background.json().running, true);
  assert.equal(planner.calls[1][0], "feedbackBackground");
  assert.deepEqual(planner.calls[1][2], { text: "Still wrong." });
});

test("reports an empty feedback note as a 400 the sheet can show", async (t) => {
  const planner = fakePlanner();
  planner.feedback = async () => { throw new TypeError("Say what is wrong with this plan"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/feedback", headers, payload: { text: "  " } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Say what is wrong/);
});

test("refuses a request against a plan whose round is still running", async (t) => {
  const planner = fakePlanner();
  planner.launch = async () => { throw new TypeError("This goal is planning right now. Wait for the round to finish"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/launch", headers, payload: {} });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /planning right now/);
});

test("drives a worktree plan from goal to launch", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };

  const engine = { provider: "codex", model: "gpt-5.6-sol", effort: "high", reviewer: true };
  const started = await app.inject({ method: "POST", url: "/api/worktree-plans", headers, payload: { repositoryId: "repository12345678", goal: "Add billing", engine } });
  assert.equal(started.statusCode, 201);
  assert.equal(started.json().planId, "plan-1");
  assert.deepEqual(planner.calls[0][1], { repositoryId: "repository12345678", goal: "Add billing", images: undefined, engine, onEvent: null });

  const answered = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/answers", headers, payload: { answers: [{ id: "q1", text: "Postgres" }] } });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().round, 2);
  assert.deepEqual(planner.calls[1][2], { answers: [{ id: "q1", text: "Postgres" }], skip: false, onEvent: null });

  const skipped = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/answers", headers, payload: { skip: true } });
  assert.equal(skipped.statusCode, 200);
  assert.equal(planner.calls[2][2].skip, true);

  const patched = await app.inject({ method: "PATCH", url: "/api/worktree-plans/plan-1", headers, payload: { tasks: [{ id: "t1", title: "Billing", branch: "feature/billing", prompt: "Add billing.", agent: "codex" }] } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().tasks[0].agent, "codex");

  const launched = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/launch", headers, payload: {} });
  assert.equal(launched.statusCode, 200);
  assert.equal(launched.json().base, "origin/main");
  assert.equal(launched.json().launched, 1);
  assert.deepEqual(planner.calls.map((call) => call[0]), ["start", "answer", "answer", "update", "launch"]);
});

test("builds the single combined pull request through the goal integrator", async (t) => {
  const calls = [];
  const goalIntegrator = {
    assemble: async (planId) => {
      calls.push(planId);
      return { planId, deliveryMode: "combined", deliveryStatus: "pr_open", finalPrNumber: 42, finalPrUrl: "https://github.test/pr/42" };
    },
  };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: fakePlanner(), goalIntegrator });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/assemble", headers, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().finalPrNumber, 42);
  assert.deepEqual(calls, ["plan-1"]);
});

test("turns a planner rejection into a 400 with its own message", async (t) => {
  const planner = fakePlanner();
  planner.start = async () => { throw new TypeError("Describe the goal for this repository"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/worktree-plans",
    headers: { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { repositoryId: "repository12345678", goal: "" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Describe the goal for this repository");
});

test("refuses an unauthenticated plan request", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: fakePlanner() });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans", payload: { repositoryId: "repository12345678", goal: "Add billing" } });
  assert.equal(response.statusCode, 401);
});

test("accepts a full eight task plan without hitting the body limit", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const tasks = Array.from({ length: 8 }, (unused, index) => ({
    id: `t${index}`,
    title: `Task number ${index}`,
    branch: `feature/task-${index}`,
    prompt: "x".repeat(4_000),
    agent: "claude",
    agentReason: "Claude · best account 90% left",
  }));
  const response = await app.inject({
    method: "PATCH",
    url: "/api/worktree-plans/plan-1",
    headers: { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { tasks },
  });
  assert.equal(response.statusCode, 200, `a full plan must not be rejected, got ${response.statusCode}`);
  assert.equal(planner.calls.at(-1)[2].tasks.length, 8);
});

test("passes attached images through to the planner", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const images = [{ path: "/attachments/one.png", name: "one.png" }];
  const response = await app.inject({
    method: "POST",
    url: "/api/worktree-plans",
    headers: { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { repositoryId: "repository12345678", goal: "Add billing", images },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(planner.calls[0][1].images, images);
});

test("turns a bad images value into a 400", async (t) => {
  const planner = fakePlanner();
  planner.start = async () => { throw new TypeError("Attached images must be a list"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/worktree-plans",
    headers: { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { repositoryId: "repository12345678", goal: "Add billing", images: "one.png" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "Attached images must be a list");
});

const TRACE = "11111111-2222-4333-8444-555555555555";

test("the progress stream needs the session cookie", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: fakePlanner() });
  t.after(() => app.close());
  const unpaired = await app.inject({ method: "GET", url: `/api/worktree-plans/progress/${TRACE}` });
  assert.equal(unpaired.statusCode, 401);
});

test("rejects a progress id that is not a uuid", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: fakePlanner() });
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/api/worktree-plans/progress/not-a-uuid",
    headers: { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test" },
  });
  assert.equal(response.statusCode, 400);
});

// inject() cannot read a hijacked response that never ends, so this one listens
// on an ephemeral port and reads the frames off the wire.
test("streams a tool label to a subscriber, then ends the round", async (t) => {
  const planner = fakePlanner();
  planner.start = async (options) => {
    options.onEvent?.({ k: "tool", t: "Read server/app.mjs" });
    options.onEvent?.({ k: "text", t: "Thinking…" });
    return { planId: "plan-1", repositoryId: "repository12345678", goal: "Add billing", round: 1, status: "ready", questions: [], tasks: [] };
  };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, origin: base, "content-type": "application/json" };

  const stream = await fetch(`${base}/api/worktree-plans/progress/${TRACE}`, { headers });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);

  const frames = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (const block of buffer.split("\n\n")) {
        const line = block.trim();
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      if (frames.some((frame) => frame.k === "done")) return;
    }
  })();

  const started = await fetch(`${base}/api/worktree-plans`, { method: "POST", headers, body: JSON.stringify({ repositoryId: "repository12345678", goal: "Add billing", traceId: TRACE }) });
  assert.equal(started.status, 201);
  await reading;
  assert.deepEqual(frames.map((frame) => frame.t || frame.k), ["Read server/app.mjs", "Thinking…", "done"]);
});

test("a failed round ends its progress stream with an error", async (t) => {
  const planner = fakePlanner();
  planner.start = async () => { throw new TypeError("Describe the goal for this repository"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, origin: base, "content-type": "application/json" };

  const failed = await fetch(`${base}/api/worktree-plans`, { method: "POST", headers, body: JSON.stringify({ repositoryId: "repository12345678", goal: "", traceId: TRACE }) });
  assert.equal(failed.status, 400);
  // The buffer outlives the round, so a sheet that reconnects still learns it ended.
  const stream = await fetch(`${base}/api/worktree-plans/progress/${TRACE}`, { headers });
  const reader = stream.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /"k":"error"/);
  await reader.cancel();
});

test("aborting a goal cancels its scheduled work and reports every closure", async (t) => {
  const planner = fakePlanner();
  const calls = [];
  const goalIntegrator = { cancel: (planId) => { calls.push(["cancel", planId]); return { planId, cancelled: true }; }, assemble: async () => ({}) };
  const worktreeDashboard = { invalidate: () => calls.push(["invalidate"]) };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner, goalIntegrator, worktreeDashboard });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/abort", headers, payload: {} });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.aborted, true);
  assert.equal(body.alreadyAborted, false);
  assert.deepEqual(body.closedSessionIds, ["ws-1"]);
  assert.deepEqual(body.failedSessionIds, ["ws-2"], "a partial closure must reach the UI");
  // Cancel runs before the abort, so no armed timer can create a session, and
  // the caches are dropped afterwards.
  assert.deepEqual(calls, [["cancel", "plan-1"], ["invalidate"]]);
  assert.deepEqual(planner.calls.at(-1), ["abort", "plan-1"]);
});

test("a scheduling cancel that throws never stops the abort", async (t) => {
  const planner = fakePlanner();
  const goalIntegrator = { cancel: () => { throw new Error("timer map is gone"); }, assemble: async () => ({}) };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner, goalIntegrator });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/abort", headers, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().aborted, true);
});

test("a planner refusal to abort a merged goal answers 400 with its own sentence", async (t) => {
  const planner = fakePlanner();
  planner.abort = async () => { throw new TypeError("This goal is already merged, so it cannot be aborted"); };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const response = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/abort", headers, payload: {} });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /already merged/);
});

test("only an explicit GitHub refresh reconciles the goal board, and only after it succeeds", async (t) => {
  const order = [];
  const value = { generatedAt: "2026-09-01T00:00:00.000Z", summary: { repositories: 0, worktrees: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [] };
  const worktreeDashboard = { snapshot: async (input) => { order.push(["snapshot", input.refreshGitHub === true]); return value; }, invalidate: () => {} };
  const goalMergeWatch = { reconcile: async () => { order.push(["reconcile"]); return { recorded: [] }; } };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: fakePlanner(), worktreeDashboard, goalMergeWatch });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);

  assert.equal((await app.inject({ url: "/api/worktree-dashboard", headers: { cookie } })).statusCode, 200);
  assert.deepEqual(order, [["snapshot", false]], "an ordinary poll must not reconcile");

  assert.equal((await app.inject({ url: "/api/worktree-dashboard?github=1", headers: { cookie } })).statusCode, 200);
  assert.deepEqual(order, [["snapshot", false], ["snapshot", true], ["reconcile"]], "the board is written before the response returns");
});

test("a failed snapshot reconciles nothing, and a failed reconciliation still returns the dashboard", async (t) => {
  const order = [];
  const value = { generatedAt: "2026-09-01T00:00:00.000Z", summary: { repositories: 0, worktrees: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [], orphanSessions: [] };
  let snapshotFails = true;
  const worktreeDashboard = {
    snapshot: async () => { if (snapshotFails) throw new Error("git is unavailable"); order.push(["snapshot"]); return value; },
    invalidate: () => {},
  };
  const goalMergeWatch = { reconcile: async () => { order.push(["reconcile"]); throw new Error("the store is locked"); } };
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: fakePlanner(), worktreeDashboard, goalMergeWatch });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);

  assert.equal((await app.inject({ url: "/api/worktree-dashboard?github=1", headers: { cookie } })).statusCode, 500);
  assert.deepEqual(order, [], "a snapshot that failed must not reconcile");

  snapshotFails = false;
  const response = await app.inject({ url: "/api/worktree-dashboard?github=1", headers: { cookie } });
  assert.equal(response.statusCode, 200, "a reconciliation failure must not fail the refresh");
  assert.deepEqual(order, [["snapshot"], ["reconcile"]]);
});

test("the plan list and detail carry the lifecycle fields the board reads", async (t) => {
  const planner = fakePlanner();
  planner.list = async () => ({ plans: [{ planId: "plan-1", goal: "Add billing", status: "launched", running: false, runPhase: null, runStage: null, runStep: "", runError: "", boardStatus: null, boardPrState: "OPEN", boardState: "waiting_for_merge" }] });
  planner.detail = async () => ({ planId: "plan-1", status: "launched", running: true, runPhase: "running", runStage: "review_spec", runStep: "Read app/page.tsx", runError: "", boardStatus: null, boardState: "review_spec", events: [] });
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const listed = (await app.inject({ url: "/api/worktree-plans", headers })).json();
  assert.equal(listed.plans[0].boardState, "waiting_for_merge");
  assert.equal(listed.plans[0].boardPrState, "OPEN");
  const detail = (await app.inject({ url: "/api/worktree-plans/plan-1", headers })).json();
  assert.equal(detail.runStage, "review_spec");
  assert.equal(detail.boardState, "review_spec");
});
