import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { normalizeInbox } from "../server/app.mjs";
import { CmuxCommandError } from "../server/cmux-client.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
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

function fakeDashboard(calls = []) {
  return {
    calls,
    snapshot: async (input) => { calls.push(["snapshot", input]); return { repositories: [], summary: {} }; },
    removeCleanWorktrees: async (id, input) => { calls.push(["remove-clean", id, input]); return { removed: [] }; },
    resolveRepository: async (id) => { if (id !== REPO_ID) throw new TypeError("Unknown repository"); return { id, name: "Fixture", primaryPath: "/repo/fixture" }; },
    create: async () => ({ worktree: { path: "/repo/new-goal" } }),
    invalidate: () => calls.push(["invalidate"]),
  };
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

test("workspace lifecycle routes forward to cmux and drop the cached board", async (t) => {
  const cmux = fakeCmux();
  const calls = [];
  const app = await buildApp(t, { cmux, token: TOKEN, worktreeDashboard: fakeDashboard(calls) });
  const closed = await app.inject({ method: "POST", url: `/api/workspaces/${WS_ID}/close`, headers: AUTH, payload: {} });
  assert.equal(closed.statusCode, 200);
  assert.deepEqual(closed.json(), { closed: WS_ID });
  assert.deepEqual(calls, [["invalidate"]]);
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

test("the worktree cleanup run drops the cached board and the remove-clean route forwards live sessions", async (t) => {
  const cleanupCalls = [];
  const worktreeCleanup = {
    start: () => () => {},
    status: async () => ({ policy: { enabled: true } }),
    configure: async (body) => { cleanupCalls.push(["configure", body]); return { policy: body }; },
    preview: async () => ({ previewId: "preview-1", candidates: [] }),
    run: async (input) => { cleanupCalls.push(["run", input]); return { removed: ["one"] }; },
  };
  const dashboardCalls = [];
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, worktreeCleanup, worktreeDashboard: fakeDashboard(dashboardCalls) });
  assert.equal((await app.inject({ url: "/api/worktree-cleanup", headers: AUTH })).json().policy.enabled, true);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/worktree-cleanup", headers: AUTH, payload: { enabled: false } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/worktree-cleanup/preview", headers: AUTH, payload: {} })).json().previewId, "preview-1");
  const run = await app.inject({ method: "POST", url: "/api/worktree-cleanup/run", headers: AUTH, payload: { previewId: "preview-1", ids: ["one"], prune: true } });
  assert.equal(run.statusCode, 200);
  assert.deepEqual(cleanupCalls.at(-1), ["run", { previewId: "preview-1", ids: ["one"], prune: true }]);
  assert.deepEqual(dashboardCalls, [["invalidate"]]);
  const cleaned = await app.inject({ method: "POST", url: `/api/worktree-dashboard/repositories/${REPO_ID}/remove-clean`, headers: AUTH, payload: {} });
  assert.equal(cleaned.statusCode, 200);
  assert.deepEqual(dashboardCalls.at(-1), ["remove-clean", REPO_ID, { workspaces: (await fakeCmux().workspaceList()).workspaces, workspacesAvailable: true }]);
});

test("a manual GitHub refresh inspects pull requests for push alerts, and a failed inspection still answers", async (t) => {
  const inspected = [];
  let fail = false;
  const pushService = {
    attach: () => () => {},
    status: (endpoint) => ({ supported: true, subscribed: endpoint === "https://push.example/sub", endpoint }),
    subscribe: (subscription, settings) => ({ subscribed: true, subscription, settings }),
    updateSettings: (endpoint, settings) => ({ endpoint, settings }),
    unsubscribe: (endpoint) => ({ removed: endpoint }),
    test: (endpoint) => ({ sent: true, endpoint }),
    inspectPullRequests: async (dashboard) => { inspected.push(dashboard); if (fail) throw new Error("gh exploded"); },
  };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, pushService, eventHub: fakeHub(), worktreeDashboard: fakeDashboard() });
  assert.equal((await app.inject({ url: "/api/worktree-dashboard?github=1", headers: AUTH })).statusCode, 200);
  assert.equal(inspected.length, 1);
  fail = true;
  assert.equal((await app.inject({ url: "/api/worktree-dashboard?github=1", headers: AUTH })).statusCode, 200);
  assert.equal(inspected.length, 2);
  assert.equal((await app.inject({ url: "/api/worktree-dashboard", headers: AUTH })).statusCode, 200);
  assert.equal(inspected.length, 2, "a plain read inspects nothing");
  assert.equal((await app.inject({ url: "/api/worktree-dashboard?github=1&repositoryId=short", headers: AUTH })).statusCode, 400);

  const status = await app.inject({ url: "/api/push/status?endpoint=https://push.example/sub", headers: AUTH });
  assert.deepEqual(status.json(), { supported: true, subscribed: true, endpoint: "https://push.example/sub" });
  assert.equal((await app.inject({ url: "/api/push/status", headers: AUTH })).json().endpoint, null);
  const subscribed = await app.inject({ method: "POST", url: "/api/push/subscribe", headers: AUTH, payload: { subscription: { endpoint: "e" }, settings: { quiet: true } } });
  assert.deepEqual(subscribed.json(), { subscribed: true, subscription: { endpoint: "e" }, settings: { quiet: true } });
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/push/settings", headers: AUTH, payload: { endpoint: "e", settings: { quiet: false } } })).json(), { endpoint: "e", settings: { quiet: false } });
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/push/unsubscribe", headers: AUTH, payload: { endpoint: "e" } })).json(), { removed: "e" });
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/push/test", headers: AUTH, payload: { endpoint: 42 } })).json(), { sent: true, endpoint: null });
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

test("a manual GitHub issue sync joins the scheduler's shared pass", async (t) => {
  let passes = 0;
  const githubIssueSyncScheduler = { start: () => () => {}, syncNow: async () => { passes += 1; return { synced: passes }; } };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, githubIssueSyncScheduler });
  const synced = await app.inject({ method: "POST", url: "/api/github-issues/sync", headers: AUTH, payload: {} });
  assert.equal(synced.statusCode, 200);
  assert.deepEqual(synced.json(), { synced: 1 });
  assert.equal((await app.inject({ method: "POST", url: "/api/github-issues/bad/1/goal", headers: AUTH, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/github-issues/${REPO_ID}/0/goal`, headers: AUTH, payload: {} })).statusCode, 400);
});

test("native cmux inbox replies reach cmux, and a broken feed still serves durable goal questions", async (t) => {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const cmux = fakeCmux();
  const app = await buildApp(t, { cmux, token: TOKEN, worktreePlanStore: store, goalReviews: { start: () => () => {} } });
  const replied = await app.inject({ method: "POST", url: `/api/inbox/${TERM_ID}/reply`, headers: AUTH, payload: { kind: "permissionRequest", mode: "allow" } });
  assert.equal(replied.statusCode, 200);
  assert.deepEqual(replied.json(), { ok: true, result: { answered: TERM_ID } });
  assert.deepEqual(cmux.calls.at(-1), ["reply", TERM_ID, "permissionRequest", { kind: "permissionRequest", mode: "allow" }]);
  assert.equal((await app.inject({ method: "POST", url: `/api/notifications/${WS_ID}/read`, headers: AUTH, payload: {} })).statusCode, 200);
  assert.deepEqual(cmux.calls.at(-1), ["read", WS_ID]);

  cmux.pendingFeed = async () => { throw new CmuxCommandError("cmux is away", { code: 1 }); };
  assert.equal((await app.inject({ url: "/api/inbox", headers: AUTH })).statusCode, 503, "with nothing durable to show, the cmux failure is the answer");
  store.createPlan({ planId: "inbox-goal", repositoryId: REPO_ID, cwd: "/fixture", goal: "Choose billing" });
  store.reserveGoalSession("inbox-goal", { branch: "goal-session/inbox", generation: 1 });
  store.recordGoalSessionStart("inbox-goal", { worktreePath: "/fixture-goal", workspaceId: WS_ID, generation: 1 });
  store.publishGoalSessionQuestions("inbox-goal", { generation: 1, questions: [{ id: "q1", text: "Card or invoice?" }, { id: "q2", text: "Monthly or yearly?" }] });
  const inbox = await app.inject({ url: "/api/inbox", headers: AUTH });
  assert.equal(inbox.statusCode, 200);
  assert.equal(inbox.json().actionableCount, 1);
  assert.deepEqual(inbox.json().items[0].questionOptions, ["Write reply…"], "several questions offer only a free reply");
  assert.equal(inbox.json().unreadCount, 0);
  assert.equal((await app.inject({ method: "POST", url: `/api/inbox/${inbox.json().items[0].requestId}/reply`, headers: AUTH, payload: { kind: "question", selections: [] } })).statusCode, 400);
});

async function goalFixture(t) {
  const store = new WorktreePlanStore({ path: ":memory:" });
  t.after(() => store.close());
  const reviewCalls = [];
  const runnerCalls = [];
  const goalReviews = {
    start: () => () => {},
    reconcile: async (planId, reviewId) => { reviewCalls.push(["reconcile", planId, reviewId]); return { planId, reviewId, reconciled: true }; },
    requestCode: async (planId) => { reviewCalls.push(["code", planId]); },
  };
  const cmux = { ...fakeCmux(), workspaceListDetailed: async () => ({ workspaces: [] }), workspaceStartGoalSessionRunner: async (...args) => runnerCalls.push(args) };
  const app = await buildApp(t, { cmux, token: TOKEN, worktreePlanStore: store, goalReviews, worktreeDashboard: fakeDashboard() });
  const plan = (id, patch = {}) => {
    store.createPlan({ planId: id, repositoryId: REPO_ID, cwd: "/fixture", goal: `Goal ${id}`, engine: { provider: "codex", reviewer: false }, ...patch });
    store.reserveGoalSession(id, { branch: `goal-session/${id}`, generation: 1 });
    store.recordGoalSessionStart(id, { worktreePath: `/fixture/${id}`, workspaceId: `${id}-workspace`, generation: 1 });
    store.recordGoalSessionProviderSession(id, { generation: 1, providerSessionId: `${id}-session` });
    return store.get(id);
  };
  return { app, store, plan, reviewCalls, runnerCalls };
}

const proposal = { intendedBehavior: "Add billing", acceptanceCriteria: [{ text: "Charges", verification: "Test" }] };

test("goal session conversation routes drive the durable state machine", async (t) => {
  const { app, store, plan, runnerCalls } = await goalFixture(t);
  plan("chat");
  const found = await app.inject({ url: "/api/goal-sessions/workspace/chat-workspace", headers: AUTH });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().plan.planId, "chat");
  assert.equal((await app.inject({ url: "/api/goal-sessions/workspace/unknown-workspace", headers: AUTH })).json().plan, null);

  store.publishGoalSessionQuestions("chat", { generation: 1, questions: [{ id: "q1", text: "Which provider?", options: ["Stripe"] }] });
  const answered = await app.inject({ method: "POST", url: "/api/goal-sessions/chat/answer", headers: AUTH, payload: { generation: 1, questionRevision: 1, feedback: "Stripe" } });
  assert.equal(answered.statusCode, 200, answered.body);
  assert.equal(answered.json().goalSessionState, "planning");
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/chat/answer", headers: AUTH, payload: { generation: 1, feedback: "Again" } })).statusCode, 400);

  store.publishProposal("chat", { generation: 1, providerSessionId: "chat-session", proposal });
  const changes = await app.inject({ method: "POST", url: "/api/goal-sessions/chat/request-changes", headers: AUTH, payload: { generation: 1, revision: 1, feedback: "Support invoices too" } });
  assert.equal(changes.statusCode, 200, changes.body);
  assert.equal(changes.json().goalSessionState, "planning");
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/chat/approve", headers: AUTH, payload: { generation: 1, revision: 1 } })).statusCode, 400, "a superseded revision cannot be approved");
  store.publishProposal("chat", { generation: 1, providerSessionId: "chat-session", proposal });
  const approved = await app.inject({ method: "POST", url: "/api/goal-sessions/chat/approve", headers: AUTH, payload: { generation: 1, revision: 2 } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().goalSessionState, "implementing");

  plan("resume");
  const continued = await app.inject({ method: "POST", url: "/api/goal-sessions/resume/continue", headers: AUTH, payload: {} });
  assert.equal(continued.statusCode, 200, continued.body);
  assert.equal(continued.json().planId, "resume", "an open conversation is simply returned");
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/missing/continue", headers: AUTH, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/resume/restart", headers: AUTH, payload: {} })).statusCode, 400, "only an aborted goal restarts");

  const recovered = await app.inject({ method: "POST", url: "/api/goal-sessions/resume/recover", headers: AUTH, payload: {} });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0][0], "resume-workspace");
  assert.equal(runnerCalls[0][1].planId, "resume");
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/missing/recover", headers: AUTH, payload: {} })).statusCode, 400);
});

test("review routes act on the stored review and hand reconciliation and code requests to the reviewer", async (t) => {
  const { app, store, plan, reviewCalls } = await goalFixture(t);
  plan("reviewed", { engine: { provider: "codex", reviewer: true } });
  store.publishProposal("reviewed", { generation: 1, providerSessionId: "reviewed-session", proposal });
  const review = store.get("reviewed").reviews[0];
  assert.equal(review.status, "queued");
  const claimed = store.outcomes.claim(review.id);
  store.outcomes.finish(review.id, claimed.attempt, { status: "failed", error: "provider timeout" });

  const acknowledged = await app.inject({ method: "POST", url: "/api/goal-sessions/reviewed/reviews/acknowledge", headers: AUTH, payload: { reviewId: review.id } });
  assert.equal(acknowledged.statusCode, 200, acknowledged.body);
  assert.ok(acknowledged.json().reviews[0].acknowledgedAt);
  const retried = await app.inject({ method: "POST", url: "/api/goal-sessions/reviewed/reviews/retry", headers: AUTH, payload: { reviewId: review.id } });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().reviews[0].status, "queued");
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/reviewed/reviews/retry", headers: AUTH, payload: { reviewId: review.id } })).statusCode, 400, "a queued review cannot be retried again");
  const reconciled = await app.inject({ method: "POST", url: "/api/goal-sessions/reviewed/reviews/reconcile", headers: AUTH, payload: { reviewId: review.id } });
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.deepEqual(reconciled.json(), { planId: "reviewed", reviewId: review.id, reconciled: true });
  assert.equal((await app.inject({ method: "POST", url: "/api/goal-sessions/missing/reviews/retry", headers: AUTH, payload: { reviewId: review.id } })).statusCode, 400);
  const code = await app.inject({ method: "POST", url: "/api/goal-sessions/reviewed/reviews/code", headers: AUTH, payload: {} });
  assert.equal(code.statusCode, 200, code.body);
  assert.equal(code.json().planId, "reviewed");
  assert.deepEqual(reviewCalls, [["reconcile", "reviewed", review.id], ["code", "reviewed"]]);
});

test("aborted goals return their GitHub issues to the backlog exactly once", async (t) => {
  const { app, store, plan } = await goalFixture(t);
  plan("issues", { issueNumbers: [12, 13], issueUrls: ["https://github.com/x/y/issues/12", "https://github.com/x/y/issues/13"] });
  assert.equal((await app.inject({ method: "POST", url: "/api/worktree-plans/issues/return-issues", headers: AUTH, payload: {} })).statusCode, 400, "only aborted goals release their issues");
  store.recordGoalAborted("issues", { reason: "test" });
  const returned = await app.inject({ method: "POST", url: "/api/worktree-plans/issues/return-issues", headers: AUTH, payload: {} });
  assert.equal(returned.statusCode, 200, returned.body);
  assert.equal(returned.json().planId, "issues");
  assert.ok(returned.json().issuesReturnedAt);
  assert.equal((await app.inject({ method: "POST", url: "/api/worktree-plans/issues/return-issues", headers: AUTH, payload: {} })).json().issuesReturnedAt, returned.json().issuesReturnedAt);
  assert.equal((await app.inject({ method: "POST", url: "/api/worktree-plans/missing/return-issues", headers: AUTH, payload: {} })).statusCode, 400);
});

test("a burst approval drops the cached board so the new goal appears", async (t) => {
  const approvals = [];
  const burstService = { approve: async (burstId, repositoryId, body) => { approvals.push([burstId, repositoryId, body]); return { burstId, repositoryId, planId: "goal-1" }; } };
  const calls = [];
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, burstService, worktreeDashboard: fakeDashboard(calls) });
  const approved = await app.inject({ method: "POST", url: `/api/bursts/burst-abc/candidates/${REPO_ID}/approve`, headers: AUTH, payload: { goal: "Ship it" } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(approvals, [["burst-abc", REPO_ID, { goal: "Ship it" }]]);
  assert.deepEqual(calls, [["invalidate"]]);
});

test("a settled background launch drops the cached board through the planner hook", async (t) => {
  const planner = { abort: async () => ({}) };
  const calls = [];
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, worktreePlanner: planner, worktreeDashboard: fakeDashboard(calls) });
  assert.equal(typeof planner.onLaunchSettled, "function");
  planner.onLaunchSettled();
  assert.deepEqual(calls, [["invalidate"]]);
  const retirable = await app.inject({ url: "/api/goals/sessions/retirable?planId=%20plan-9%20", headers: AUTH });
  assert.equal(retirable.statusCode, 503, "no plan store means no session retirement");
});

test("a padded plan id is trimmed before the dry run looks it up", async (t) => {
  const looked = [];
  const store = { list: () => [], get: (id) => { looked.push(id); return null; }, recordSessionsRetired: () => {} };
  const app = await buildApp(t, { cmux: fakeCmux(), token: TOKEN, worktreePlanner: { abort: async () => ({}) }, worktreePlanStore: store });
  const retirable = await app.inject({ url: "/api/goals/sessions/retirable?planId=%20plan-9%20", headers: AUTH });
  assert.equal(retirable.statusCode, 200, retirable.body);
  assert.equal(retirable.json().sessionsAvailable, false);
  assert.deepEqual(looked, ["plan-9"]);
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
  // The durable delivery controller holds its own consumer on an injected hub.
  assert.equal(hub.consumers, 2);
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
  assert.equal(hub.consumers, 1, "the socket released its consumer");
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

test("the discovery run route returns the open conversation and drops the cached board", async (t) => {
  const { app, plan } = await goalFixture(t);
  plan("running");
  const run = await app.inject({ method: "POST", url: "/api/worktree-plans/running/run", headers: AUTH, payload: {} });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().planId, "running");
  assert.equal((await app.inject({ method: "POST", url: "/api/worktree-plans/missing/run", headers: AUTH, payload: {} })).statusCode, 400);
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
