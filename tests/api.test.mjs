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
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/bootstrap" })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/terminals/${TERM_ID}/replay` })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: "wrong" } })).statusCode, 401);
});

test("paired clients can read state and safely control a terminal", async (t) => {
  const cmux = fakeCmux();
  const app = await buildApp({ cmux, token: TOKEN });
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

  const input = await app.inject({
    method: "POST",
    url: `/api/terminals/${TERM_ID}/input`,
    headers: { cookie, host: "mac.tail.test", origin: "https://mac.tail.test" },
    payload: { text: "continue", enter: true },
  });
  assert.equal(input.statusCode, 200);
  assert.deepEqual(cmux.calls[1], ["prompt", TERM_ID, "continue"]);
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

test("every state-changing route requires pairing and same-origin requests", async (t) => {
  const app = await buildApp({ cmux: fakeCmux(), token: TOKEN });
  t.after(() => app.close());
  const cookie = await pairedCookie(app);
  const mutations = [
    ["/api/auth/logout", {}],
    ["/api/workspaces", { repoId: "x" }],
    [`/api/workspaces/${WS_ID}/rename`, { title: "x" }],
    [`/api/workspaces/${WS_ID}/close`, {}],
    [`/api/workspaces/${WS_ID}/respawn`, { surfaceId: TERM_ID }],
    [`/api/workspaces/${WS_ID}/todos/${TERM_ID}/check`, {}],
    [`/api/terminals/${TERM_ID}/input`, { text: "x" }],
    [`/api/terminals/${TERM_ID}/key`, { key: "enter" }],
    [`/api/terminals/${TERM_ID}/viewport`, { clientId: "phone-client-123", generation: 1, columns: 42, rows: 18 }],
    [`/api/workspaces/${WS_ID}/select`, {}],
    [`/api/inbox/${TERM_ID}/reply`, { kind: "permissionRequest", mode: "deny" }],
    [`/api/notifications/${TERM_ID}/read`, {}],
    ["/api/push/subscribe", {}],
    ["/api/push/settings", {}],
    ["/api/push/unsubscribe", {}],
    ["/api/push/test", {}],
  ];
  for (const [url, payload] of mutations) {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401, url);
    assert.equal((await app.inject({ method: "POST", url, payload, headers: { cookie, host: "mac.tail.test", origin: "https://evil.test" } })).statusCode, 403, url);
  }
});

test("normalizes actionable requests separately from unread notifications", () => {
  const result = normalizeInbox({ items: [{ request_id: TERM_ID, kind: "permissionRequest", workspace_id: WS_ID, tool_name: "exec" }] }, { notifications: [{ id: WS_ID, title: "Done", is_read: false }, { id: TERM_ID, title: "Old", is_read: true }] });
  assert.equal(result.actionableCount, 1);
  assert.equal(result.unreadCount, 1);
  assert.deepEqual(result.items.map((item) => item.type), ["request", "notification"]);
});
