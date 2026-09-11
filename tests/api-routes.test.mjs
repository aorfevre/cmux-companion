import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { normalizeInbox } from "../server/app.mjs";
import { CmuxCommandError } from "../server/cmux-client.mjs";
import { buildTestApp as buildApp } from "./helpers/api-app.mjs";

// Route-level coverage for the Fastify API: every handler that the broader
// api.test.mjs scenarios do not reach, exercised through app.inject with fakes.

const TOKEN = "route-token-that-is-deliberately-long-and-private";
const WS_ID = "11111111-2222-4333-8444-555555555555";
const TERM_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REPO_ID = "repository12345678";
const ORIGIN = { host: "mac.tail.test", origin: "https://mac.tail.test" };
const AUTH = { authorization: `Bearer ${TOKEN}`, ...ORIGIN };

function fakeCmux() {
  const calls = [];
  return {
    bin: "/fake/cmux",
    calls,
    hostStatus: async () => ({ mac_display_name: "Test Mac", workspace_count: 1 }),
    workspaceList: async () => ({ groups: [], workspaces: [{ id: WS_ID, title: "companion test", terminals: [{ id: TERM_ID, title: "terminal", is_ready: true }] }] }),
    capabilities: async () => ({ methods: ["mobile.workspace.list"] }),
    terminalViewport: async (id, viewport) => { calls.push(["viewport", id, viewport]); return { surface_id: id }; },
    sendKey: async (id, key) => calls.push(["key", id, key]),
    selectWorkspace: async (id) => calls.push(["select", id]),
    workspaceCreate: async (value) => { calls.push(["create", value]); return { workspace_id: WS_ID }; },
    workspaceClose: async (id) => { calls.push(["close", id]); return { closed: id }; },
    workspaceRespawn: async (id, surfaceId) => { calls.push(["respawn", id, surfaceId]); return { respawned: surfaceId }; },
    todoAction: async (id, todoId, action) => { calls.push(["todo", id, todoId, action]); return { ok: true }; },
    pendingFeed: async () => ({ items: [] }),
    notifications: async () => ({ notifications: [] }),
    feedReply: async (id, kind, body) => { calls.push(["reply", id, kind, body]); return { answered: id }; },
    markNotificationRead: async (id) => calls.push(["read", id]),
  };
}

function fakeHub() {
  const hub = new EventEmitter();
  hub.consumers = 0;
  hub.stopped = 0;
  hub.addConsumer = () => { hub.consumers += 1; };
  hub.removeConsumer = () => { hub.consumers -= 1; };
  hub.stop = () => { hub.stopped += 1; };
  return hub;
}

test("cmux command failures answer 503 and the auth status route reports pairing and identity", async (t) => {
  const cmux = fakeCmux();
  cmux.workspaceList = async () => { throw new CmuxCommandError("socket closed", { code: 1 }); };
  const app = await buildApp(t, { cmux, token: TOKEN });
  const failed = await app.inject({ url: "/api/workspaces", headers: AUTH });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "CMUX_UNAVAILABLE");
  const anonymous = await app.inject({ url: "/api/auth/status" });
  assert.equal(anonymous.statusCode, 200);
  assert.deepEqual(anonymous.json(), { paired: false, identity: { login: null, name: null, profilePicture: null } });
  const paired = await app.inject({ url: "/api/auth/status", headers: { ...AUTH, "tailscale-user-login": "alex@example.test" } });
  assert.equal(paired.json().paired, true);
  assert.equal(paired.json().identity.login, "alex@example.test");
});

test("pairing is rate limited per client and the window resets after fifteen minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN });
  const attempt = () => app.inject({ method: "POST", url: "/api/auth/pair", headers: ORIGIN, payload: { token: "wrong" } });
  for (let index = 0; index < 8; index += 1) assert.equal((await attempt()).statusCode, 401);
  const limited = await attempt();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "PAIR_RATE_LIMIT");
  t.mock.timers.tick(15 * 60_000 + 1);
  assert.equal((await attempt()).statusCode, 401, "a new window allows attempts again");
  const good = await app.inject({ method: "POST", url: "/api/auth/pair", headers: ORIGIN, payload: { token: TOKEN } });
  assert.equal(good.statusCode, 200);
  assert.match(good.headers["set-cookie"], /cmux_session=/);
});

test("bootstrap syncs detected previews and survives a sync that never finishes", async (t) => {
  const synced = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const previewManager = {
    list: () => ({ previews: [] }),
    syncWorkspaces: async (workspaces, repos) => { synced.push([workspaces.map((item) => item.id), repos]); if (synced.length === 1) await gate; },
  };
  const repoCatalog = { roots: [], list: async () => [{ id: REPO_ID, name: "fixture", path: "/repo/fixture" }], get: async () => { throw new TypeError("Unknown repository"); } };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, previewManager, repoCatalog, bootstrapTimeoutMs: 40 });
  const waiting = await app.inject({ url: "/api/bootstrap", headers: AUTH });
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.json().connected, false, "the page is not held hostage by a slow preview scan");
  assert.equal(waiting.json().error, "Waiting for cmux");
  await new Promise((resolve) => setTimeout(resolve, 60));
  release();
  const settled = await app.inject({ url: "/api/bootstrap", headers: AUTH });
  assert.equal(settled.json().connected, true, "the finished scan is served from its snapshot");
  assert.deepEqual(synced[0][0], [WS_ID]);
  assert.equal(synced[0][1][0].id, REPO_ID);
});

test("workspace lifecycle routes forward to cmux", async (t) => {
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN });
  const closed = await app.inject({ method: "POST", url: `/api/workspaces/${WS_ID}/close`, headers: AUTH, payload: {} });
  assert.equal(closed.statusCode, 200);
  assert.deepEqual(closed.json(), { closed: WS_ID });
  const respawned = await app.inject({ method: "POST", url: `/api/workspaces/${WS_ID}/respawn`, headers: AUTH, payload: { surfaceId: TERM_ID } });
  assert.equal(respawned.statusCode, 200);
  assert.deepEqual(respawned.json(), { respawned: TERM_ID });
  assert.equal((await app.inject({ method: "POST", url: `/api/workspaces/${WS_ID}/respawn`, headers: AUTH, payload: { surfaceId: "" } })).statusCode, 400);
  const todo = await app.inject({ method: "POST", url: `/api/workspaces/${WS_ID}/todos/todo-7/check`, headers: AUTH, payload: {} });
  assert.equal(todo.statusCode, 200);
  assert.deepEqual(cmux.calls.at(-1), ["todo", WS_ID, "todo-7", "check"]);
  assert.equal((await app.inject({ method: "POST", url: `/api/terminals/${TERM_ID}/key`, headers: AUTH, payload: { key: "enter" } })).statusCode, 200);
  assert.deepEqual(cmux.calls.at(-1), ["key", TERM_ID, "enter"]);
  assert.equal((await app.inject({ method: "POST", url: `/api/terminals/${TERM_ID}/key`, headers: AUTH, payload: { key: "" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/workspaces/${WS_ID}/select`, headers: AUTH, payload: {} })).statusCode, 200);
  assert.deepEqual(cmux.calls.at(-1), ["select", WS_ID]);
  assert.equal((await app.inject({ method: "POST", url: "/api/workspaces", headers: AUTH, payload: { repoId: "missing" } })).statusCode, 400);
});

test("a viewport lease is replaced by a newer one and released on clear", async (t) => {
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN });
  const url = `/api/terminals/${TERM_ID}/viewport`;
  const lease = { clientId: "phone-1", generation: 1, columns: 80, rows: 24 };
  assert.equal((await app.inject({ method: "POST", url, headers: AUTH, payload: lease })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url, headers: AUTH, payload: { ...lease, generation: 2 } })).statusCode, 200);
  const cleared = await app.inject({ method: "POST", url, headers: AUTH, payload: { clientId: "phone-1", generation: 3, clear: true } });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cmux.calls.map((call) => call[2].clear), [false, false, true]);
  await app.close();
  assert.equal(cmux.calls.length, 3, "a cleared lease is not cleared again on shutdown");
});

test("shutdown releases every viewport lease that is still held", async (t) => {
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN });
  await app.inject({ method: "POST", url: `/api/terminals/${TERM_ID}/viewport`, headers: AUTH, payload: { clientId: "phone-2", generation: 4, columns: 80, rows: 24 } });
  await app.close();
  assert.deepEqual(cmux.calls.at(-1), ["viewport", TERM_ID, { clientId: "phone-2", generation: 5, clear: true }]);
});

test("optional services answer 503 when the app was built without them", async (t) => {
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN });
  assert.deepEqual((await app.inject({ url: "/api/push/status", headers: AUTH })).json(), { supported: false, subscribed: false });
  const posts = ["/api/push/subscribe", "/api/push/settings", "/api/push/unsubscribe", "/api/push/test", "/api/previews/discover", "/api/previews/x/enable", "/api/previews/x/stop", "/api/previews/x/restart", "/api/previews/x/capture", "/api/prompt-queue/x/send"];
  for (const url of posts) assert.equal((await app.inject({ method: "POST", url, headers: AUTH, payload: {} })).statusCode, 503, url);
  for (const url of ["/api/previews", "/api/prompt-queue"]) assert.equal((await app.inject({ url, headers: AUTH })).statusCode, 503, url);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/previews/x", headers: AUTH })).statusCode, 503);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/prompt-queue/x", headers: AUTH })).statusCode, 503);
});

test("repository diffs require a file and forward the staged flag", async (t) => {
  const diffs = [];
  const repoCatalog = { roots: [], list: async () => [], get: async () => { throw new TypeError("Unknown repository"); }, diff: async (id, file, options) => { diffs.push([id, file, options]); return { file, patch: "+x" }; } };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, repoCatalog });
  assert.equal((await app.inject({ url: `/api/repos/${REPO_ID}/diff`, headers: AUTH })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/repos/${REPO_ID}/diff?file=`, headers: AUTH })).statusCode, 400);
  const staged = await app.inject({ url: `/api/repos/${REPO_ID}/diff?file=src/app.ts&staged=1`, headers: AUTH });
  assert.equal(staged.statusCode, 200);
  assert.deepEqual(diffs, [[REPO_ID, "src/app.ts", { staged: true }]]);
  assert.equal((await app.inject({ url: `/api/repos/${REPO_ID}/markdown`, headers: AUTH })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/repos/${REPO_ID}/assets`, headers: AUTH })).statusCode, 400);
});

test("the event stream fans out hub and queue events to a paired socket and detaches on close", async (t) => {
  const hub = fakeHub();
  const queue = new EventEmitter();
  queue.attach = () => () => {};
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, eventHub: hub, promptQueue: queue });
  await app.ready();
  const unauthorized = await app.injectWS("/api/events").catch((cause) => cause);
  assert.match(String(unauthorized.message), /401/);
  const messages = [];
  let serverSocket;
  app.websocketServer.once("connection", (connection) => { serverSocket = connection; });
  const socket = await app.injectWS("/api/events", { headers: { authorization: `Bearer ${TOKEN}` } }, {
    onInit: (client) => client.on("message", (data) => messages.push(JSON.parse(String(data)))),
  });
  const received = (count) => new Promise((resolve) => {
    const check = () => { if (messages.length >= count) resolve(); else socket.once("message", check); };
    check();
  });
  await received(1);
  assert.equal(messages[0].type, "companion:ready");
  assert.equal(hub.consumers, 1);
  assert.equal(hub.listenerCount("state"), 1);
  hub.emit("event", { name: "agent.hook.Stop" });
  hub.emit("state", { connected: true });
  queue.emit("changed", { workspaceId: WS_ID });
  await received(4);
  assert.deepEqual(messages.slice(1).map((message) => message.type), ["cmux:event", "cmux:state", "queue:changed"]);
  assert.deepEqual(messages[1].payload, { name: "agent.hook.Stop" });
  // The injected duplex never completes a close handshake, so the phone going
  // away is simulated the way it really happens: the connection is dropped.
  const closed = new Promise((resolve) => serverSocket.once("close", resolve));
  serverSocket.terminate();
  await closed;
  assert.equal(hub.consumers, 0, "the socket released its consumer");
  assert.equal(hub.listenerCount("state"), 0);
  assert.equal(queue.listenerCount("changed"), 0);
  await app.close();
  assert.equal(hub.stopped, 1);
});

test("non-API paths are proxied to the frontend with the upstream host header", async (t) => {
  const seen = [];
  const upstream = createServer((request, response) => { seen.push(request.headers.host); response.setHeader("content-type", "text/plain"); response.end(`frontend:${request.url}`); });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const frontendUpstream = `http://127.0.0.1:${upstream.address().port}`;
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, frontendUpstream });
  const page = await app.inject({ url: "/dashboard?tab=goals", headers: { host: "mac.tail.test" } });
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, "frontend:/dashboard?tab=goals");
  assert.deepEqual(seen, [new URL(frontendUpstream).host]);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal((await app.inject({ url: "/api/bootstrap", headers: { host: "mac.tail.test" } })).statusCode, 401, "the API stays in front of the proxy");
});

test("inbox items fall back to a title that names the request kind", () => {
  const result = normalizeInbox({ items: [
    { request_id: "r1", kind: "question", questions: [{ options: ["Yes", "No"] }] },
    { request_id: "r2", kind: "exitPlan", plan_summary: "Ship" },
    { request_id: "r3", kind: "permissionRequest" },
    { request_id: "r4", kind: "unknown" },
    { kind: "question" },
  ] });
  assert.deepEqual(result.items.map((item) => item.title), ["Agent question", "Plan ready for review", "Permission requested"]);
  assert.deepEqual(result.items[0].questionOptions, ["Yes", "No"]);
  assert.equal(result.items[1].body, "Ship");
  assert.equal(result.actionableCount, 3);
});

test("an idle viewport lease is released after twenty-five seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN });
  await app.inject({ method: "POST", url: `/api/terminals/${TERM_ID}/viewport`, headers: AUTH, payload: { clientId: "phone-3", generation: 7, columns: 80, rows: 24 } });
  assert.equal(cmux.calls.length, 1);
  t.mock.timers.tick(25_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cmux.calls.at(-1), ["viewport", TERM_ID, { clientId: "phone-3", generation: 8, clear: true }]);
  await app.close();
  assert.equal(cmux.calls.length, 2, "an expired lease is not cleared a second time on shutdown");
});
