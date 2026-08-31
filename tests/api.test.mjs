import assert from "node:assert/strict";
import test from "node:test";
import { buildApp, normalizeInbox } from "../server/app.mjs";
import { CmuxCommandError } from "../server/cmux-client.mjs";

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
    invalidate: () => calls.push(["invalidate"]),
  };
  const app = await buildApp({ cmux, token: TOKEN, worktreeDashboard });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const headers = { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" };
  const dashboard = await app.inject({ url: "/api/worktree-dashboard?refresh=1", headers: { cookie } });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.json().summary.worktrees, 1);
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
  assert.deepEqual(calls.map((call) => call[0]), ["snapshot", "create-worktree", "resolve", "invalidate", "remove", "archive"]);
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
  };
}

test("drives a worktree plan from goal to launch", async (t) => {
  const planner = fakePlanner();
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, host: "mac.tail.test", origin: "https://mac.tail.test" };

  const started = await app.inject({ method: "POST", url: "/api/worktree-plans", headers, payload: { repositoryId: "repository12345678", goal: "Add billing" } });
  assert.equal(started.statusCode, 201);
  assert.equal(started.json().planId, "plan-1");
  assert.deepEqual(planner.calls[0][1], { repositoryId: "repository12345678", goal: "Add billing" });

  const answered = await app.inject({ method: "POST", url: "/api/worktree-plans/plan-1/answers", headers, payload: { answers: [{ id: "q1", text: "Postgres" }] } });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().round, 2);
  assert.deepEqual(planner.calls[1][2], { answers: [{ id: "q1", text: "Postgres" }], skip: false });

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
