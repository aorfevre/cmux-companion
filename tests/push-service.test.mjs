import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyEventText, contextUrl, extractMarkdownPaths, isQuiet, PushService } from "../server/push-service.mjs";

function subscription(endpoint = "https://push.example.test/device") {
  return { endpoint, expirationTime: null, keys: { p256dh: "public-key", auth: "auth-key" } };
}

function fakeSender() {
  const sent = []; const vapid = [];
  return {
    sent, vapid,
    generateVAPIDKeys: () => ({ publicKey: "vapid-public", privateKey: "vapid-private" }),
    setVapidDetails: (...details) => { vapid.push(details); },
    sendNotification: async (target, payload) => { sent.push({ target, payload: JSON.parse(payload) }); },
  };
}

test("persists per-device subscriptions and applies privacy/settings filters", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-"));
  const path = join(directory, "push.json");
  const sender = fakeSender();
  const service = new PushService({ path, sender });
  assert.equal(sender.vapid[0][0], "https://cmux-companion.local");
  service.subscribe(subscription());
  assert.equal(service.status(subscription().endpoint).subscribed, true);
  assert.equal((await readFile(path, "utf8")).includes("vapid-private"), true);

  await service.send({ title: "Secret task", body: "Sensitive details", kind: "attention" });
  assert.equal(sender.sent[0].payload.title, "cmux companion");
  assert.doesNotMatch(sender.sent[0].payload.body, /Sensitive/);

  service.updateSettings(subscription().endpoint, { attention: false, completion: true, hideContent: false });
  const result = await service.send({ title: "Needs you", body: "Details", kind: "attention" });
  assert.equal(result.sent, 0);
  const reloaded = new PushService({ path, sender: fakeSender() });
  assert.equal(reloaded.status(subscription().endpoint).settings.attention, false);
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});

test("targets test alerts and reports push failures without exposing provider details", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-errors-"));
  const targetedSender = fakeSender();
  const targeted = new PushService({ path: join(directory, "targeted.json"), sender: targetedSender, vapidSubject: "https://mac.example.test:8443" });
  targeted.subscribe(subscription("https://push.example.test/first"), { attention: true });
  targeted.subscribe(subscription("https://push.example.test/second"), { attention: false });
  const targetResult = await targeted.test("https://push.example.test/second");
  assert.deepEqual({ sent: targetResult.sent, failed: targetResult.failed, skipped: targetResult.skipped }, { sent: 1, failed: 0, skipped: 1 });
  assert.equal(targetedSender.sent[0].target.endpoint, "https://push.example.test/second");
  assert.equal(targetedSender.vapid[0][0], "https://mac.example.test:8443");

  const rejectingSender = fakeSender();
  rejectingSender.sendNotification = async () => {
    throw Object.assign(new Error("provider response included private endpoint data"), {
      statusCode: 403,
      body: JSON.stringify({ reason: "BadJwtToken", endpoint: "https://secret.push.example/device", secret: "private-auth-key" }),
    });
  };
  const rejecting = new PushService({ path: join(directory, "rejecting.json"), sender: rejectingSender });
  rejecting.subscribe(subscription());
  const rejected = await rejecting.test(subscription().endpoint);
  assert.deepEqual(rejected.error, { code: "sender-authentication", message: "Push sender authentication failed. Reinstall the Mac companion.", statusCode: 403 });
  assert.deepEqual({ sent: rejected.sent, failed: rejected.failed }, { sent: 0, failed: 1 });
  assert.doesNotMatch(JSON.stringify(rejected), /secret|private-auth|endpoint data/i);
  assert.throws(() => new PushService({ path: join(directory, "invalid.json"), sender: fakeSender(), vapidSubject: "mailto:cmux-companion@localhost" }), /VAPID_SUBJECT/);
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});

test("removes expired subscriptions and does not count them as delivered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-expired-"));
  const sender = fakeSender();
  sender.sendNotification = async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); };
  const service = new PushService({ path: join(directory, "push.json"), sender });
  service.subscribe(subscription());
  const result = await service.test(subscription().endpoint);
  assert.deepEqual({ sent: result.sent, failed: result.failed, code: result.error.code }, { sent: 0, failed: 1, code: "subscription-expired" });
  assert.equal(service.status().subscriptionCount, 0);
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});

test("turns completion and actionable feed events into focused alerts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-events-"));
  const sender = fakeSender();
  const path = join(directory, "push.json");
  const service = new PushService({ path, sender });
  service.subscribe(subscription());
  const hub = new EventEmitter();
  hub.addConsumer = () => {};
  hub.removeConsumer = () => {};
  const detach = service.attach({ hub, cmux: { pendingFeed: async () => ({ items: [{ request_id: "req-1", kind: "question", title: "Choose", workspace_id: "ws-1" }] }) } });
  hub.emit("event", { name: "agent.hook.Stop", id: "stop-1", workspace_id: "ws-1" });
  hub.emit("event", { name: "feed.item.received" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sender.sent.length, 2);
  assert.equal(sender.sent[0].payload.kind, "completion");
  assert.equal(sender.sent[1].payload.url, "/?view=inbox&action=req-1&context=attention");
  detach();
  const secondSender = fakeSender();
  const reloaded = new PushService({ path, sender: secondSender });
  const detachReloaded = reloaded.attach({ hub, cmux: { pendingFeed: async () => ({ items: [{ request_id: "req-1", kind: "question", workspace_id: "ws-1" }] }) } });
  hub.emit("event", { name: "feed.item.received" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(secondSender.sent.length, 0, "pending decisions are deduplicated across restarts");
  detachReloaded();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});

test("classifies failures, builds contextual links, and respects quiet hours", async (t) => {
  assert.equal(classifyEventText("npm ERR! command failed"), "failure");
  assert.equal(classifyEventText("all tests passed"), "attention");
  assert.equal(classifyEventText("0 tests failed"), "attention");
  assert.deepEqual(extractMarkdownPaths("Review docs/plan.md and `README.md`"), ["docs/plan.md", "README.md"]);
  assert.equal(contextUrl({ workspaceId: "ws-1", repoId: "repo-1", file: "docs/plan.md", tab: "changes", kind: "completion" }), "/?workspace=ws-1&repo=repo-1&file=docs%2Fplan.md&tab=changes&context=completion");
  // A goal opens the worktree dashboard, which is a mode of the sessions view.
  assert.equal(contextUrl({ planId: "plan-1", kind: "attention" }), "/?view=sessions&mode=worktrees&plan=plan-1&context=attention");
  assert.equal(isQuiet({ quietEnabled: true, quietStart: "22:00", quietEnd: "08:00" }, new Date(2026, 1, 1, 23, 0)), true);
  assert.equal(isQuiet({ quietEnabled: true, quietStart: "22:00", quietEnd: "08:00" }, new Date(2026, 1, 1, 12, 0)), false);
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-quiet-"));
  const sender = fakeSender();
  const service = new PushService({ path: join(directory, "push.json"), sender, now: () => new Date(2026, 1, 1, 23, 0) });
  service.subscribe(subscription(), { hideContent: false, quietEnabled: true, quietStart: "22:00", quietEnd: "08:00" });
  assert.equal((await service.send({ title: "Failed", body: "Build failed", kind: "failure" })).sent, 0);
  service.updateSettings(subscription().endpoint, { hideContent: false, quietEnabled: false, failure: true, preview: false });
  await service.send({ title: "Failed", body: "Build failed", kind: "failure", workspaceId: "ws-1", file: "plan.md" });
  assert.equal(sender.sent.at(-1).payload.kind, "failure");
  assert.match(sender.sent.at(-1).payload.url, /file=plan.md/);
  assert.equal((await service.send({ title: "Preview", body: "Ready", kind: "preview" })).sent, 0);
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});

test("uses manually refreshed PR snapshots and never polls GitHub in the background", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-pr-"));
  const sender = fakeSender();
  const service = new PushService({ path: join(directory, "push.json"), sender });
  service.subscribe(subscription(), { hideContent: false });
  let failed = false; let previewSyncs = 0; let githubCalls = 0;
  service.cmux = { workspaceListDetailed: async () => ({ workspaces: [{ id: "ws-1", current_directory: "/repo", terminals: [] }] }) };
  service.repoCatalog = {
    list: async () => [{ id: "repo-1", path: "/repo" }],
    pullRequest: async () => { githubCalls += 1; throw new Error("background GitHub polling is forbidden"); },
  };
  service.previewManager = { syncWorkspaces: async () => { previewSyncs += 1; } };
  await service.inspectContext();
  await service.inspectContext();
  assert.equal(githubCalls, 0);
  assert.equal(previewSyncs, 2);
  const snapshot = () => ({ repositories: [{ id: "repo-1", worktrees: [{ branch: "feature/mobile", sessions: [{ id: "ws-1" }], pullRequest: { number: 12, reviewDecision: "REVIEW_REQUIRED", mergeState: "UNSTABLE", checks: { passed: 1, pending: failed ? 0 : 1, failed: failed ? 1 : 0, total: 2 } } }] }] });
  await service.inspectPullRequests(snapshot());
  assert.equal(sender.sent.length, 0, "first inspection establishes a baseline");
  failed = true;
  await service.inspectPullRequests(snapshot());
  assert.equal(sender.sent[0].payload.kind, "pullRequest");
  assert.match(sender.sent[0].payload.url, /workspace=ws-1/);
  assert.match(sender.sent[0].payload.url, /tab=changes/);
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});

function fakeHub() {
  const hub = new EventEmitter();
  hub.consumers = 0;
  hub.addConsumer = () => { hub.consumers += 1; };
  hub.removeConsumer = () => { hub.consumers -= 1; };
  return hub;
}

async function tempService(t, prefix, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const sender = fakeSender();
  const service = new PushService({ path: join(directory, "push.json"), sender, ...options });
  return { service, sender, directory };
}

test("unsubscribe validates the endpoint, forgets the device, and reports unknown targets", async (t) => {
  const { service, sender } = await tempService(t, "cmux-push-unsubscribe-");
  service.subscribe(subscription("https://push.example.test/a"));
  service.subscribe(subscription("https://push.example.test/b"));
  assert.throws(() => service.unsubscribe("http://push.example.test/a"), /Invalid push subscription/);
  assert.throws(() => service.unsubscribe(null), /Invalid push subscription/);
  assert.deepEqual(service.unsubscribe("https://push.example.test/a"), { subscribed: false });
  assert.equal(service.status("https://push.example.test/a").subscribed, false);
  assert.equal(service.status().subscriptionCount, 1);
  assert.throws(() => service.updateSettings("https://push.example.test/a", {}), /Unknown push subscription/);
  assert.throws(() => service.subscribe({ endpoint: "https://push.example.test/c", keys: { p256dh: "k" } }), /Invalid push subscription/);

  const missing = await service.test("https://push.example.test/a");
  assert.deepEqual(missing, { sent: 0, failed: 0, skipped: 1, error: { code: "subscription-not-found", message: "This device is no longer registered. Disable and re-enable alerts." } });
  assert.equal(sender.sent.length, 0);
  await assert.rejects(() => service.send({ title: "x", body: "y", kind: "bogus" }), /Unsupported notification kind/);

  service.unsubscribe("https://push.example.test/b");
  const empty = await service.send({ title: "x", body: "y" });
  assert.equal(empty.error.code, "no-subscriptions");
});

test("maps provider rejections to public error codes without leaking details", async (t) => {
  const { service, sender } = await tempService(t, "cmux-push-reject-");
  service.subscribe(subscription());
  sender.sendNotification = async () => { throw Object.assign(new Error("Too many"), { statusCode: 429, body: "x".repeat(3_000) }); };
  const rejected = await service.test();
  assert.deepEqual(rejected.error, { code: "push-rejected", message: "The push service rejected the alert (HTTP 429).", statusCode: 429 });
  sender.sendNotification = async () => { throw Object.assign(new Error("Forbidden"), { statusCode: 403, body: "not json" }); };
  assert.equal((await service.test()).error.code, "push-rejected", "a 403 without a VAPID reason is a plain rejection");
  sender.sendNotification = async () => { throw new Error("ECONNREFUSED"); };
  assert.deepEqual((await service.test()).error, { code: "push-unreachable", message: "The Mac could not reach the push notification service." });
  assert.equal(service.status().subscriptionCount, 1, "transient failures keep the subscription");
});

test("accepts a mailto VAPID subject and rejects malformed or credentialed HTTPS subjects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-vapid-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const sender = fakeSender();
  new PushService({ path: join(directory, "mail.json"), sender, vapidSubject: "mailto:ops@example.com" });
  assert.equal(sender.vapid.at(-1)[0], "mailto:ops@example.com");
  new PushService({ path: join(directory, "slash.json"), sender, vapidSubject: "https://mac.example.test/" });
  assert.equal(sender.vapid.at(-1)[0], "https://mac.example.test");
  for (const vapidSubject of ["https://user:pw@mac.example.test", "https://", "ftp://mac.example.test", 42]) {
    assert.throws(() => new PushService({ path: join(directory, "bad.json"), sender, vapidSubject }), /VAPID/);
  }
});

test("turns agent notifications into attention or failure alerts and deduplicates by event id", async (t) => {
  const { service, sender } = await tempService(t, "cmux-push-notify-");
  service.subscribe(subscription(), { hideContent: false });
  const hub = fakeHub();
  const detach = service.attach({ hub, cmux: {} });
  hub.emit("event", { name: "agent.hook.Notification", id: "n-1", workspace_id: "ws-1", surface_id: "sf-1", payload: { message: "Waiting for input, see notes/todo.md" } });
  hub.emit("event", { name: "notification.created", id: "n-1", workspace_id: "ws-1" });
  hub.emit("event", { name: "notification.created", seq: 7, data: { workspace_id: "ws-2", surface_id: "sf-2", message: "npm ERR! build failed\nsecond line" } });
  hub.emit("event", { name: "unrelated.event" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sender.sent.length, 2, "the duplicate id is delivered once");
  assert.equal(sender.sent[0].payload.title, "Session needs attention");
  assert.equal(sender.sent[0].payload.kind, "attention");
  assert.equal(sender.sent[0].payload.file, "notes/todo.md");
  assert.match(sender.sent[0].payload.url, /workspace=ws-1&surface=sf-1/);
  assert.equal(sender.sent[1].payload.title, "Session failed");
  assert.equal(sender.sent[1].payload.kind, "failure");
  assert.match(sender.sent[1].payload.body, /npm ERR! build failed/);
  assert.match(sender.sent[1].payload.url, /workspace=ws-2&surface=sf-2/);
  assert.equal(hub.consumers, 1);
  detach();
  assert.equal(hub.consumers, 0);
  assert.equal(hub.listenerCount("event"), 0);
});

test("announces detected and ready previews and drives context inspection from workspace events", async (t) => {
  const { service, sender } = await tempService(t, "cmux-push-preview-");
  service.subscribe(subscription(), { hideContent: false });
  const hub = fakeHub();
  const previewManager = new EventEmitter();
  const syncs = [];
  previewManager.syncWorkspaces = async (workspaces, repos) => { syncs.push({ workspaces, repos }); };
  const cmux = { workspaceListDetailed: async () => ({ workspaces: [{ id: "ws-1" }] }) };
  const repoCatalog = { list: async () => { throw new Error("catalog offline"); } };
  const detach = service.attach({ hub, cmux, repoCatalog, previewManager });
  const preview = { id: "pv-1", name: "web", targetPort: 3000, workspaceId: "ws-1", repoId: "repo-1" };
  previewManager.emit("detected", preview);
  previewManager.emit("ready", preview);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sender.sent.map((item) => item.payload.title), ["Local app detected", "Private preview ready"]);
  assert.equal(sender.sent[0].payload.body, "web is listening on localhost:3000.");
  assert.equal(sender.sent[0].payload.tag, "cmux-preview-detected-pv-1");
  assert.equal(sender.sent[1].payload.tag, "cmux-preview-ready-pv-1");
  assert.match(sender.sent[1].payload.url, /view=apps&preview=pv-1/);

  hub.emit("event", { name: "surface.title", workspace_id: "ws-1" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(syncs.length, 1, "attach and the event debounce into a single inspection");
  assert.deepEqual(syncs[0], { workspaces: [{ id: "ws-1" }], repos: [] });
  detach();
  assert.equal(previewManager.listenerCount("detected"), 0);
  assert.equal(previewManager.listenerCount("ready"), 0);
});

test("inbox inspection survives a closing cmux and labels each pending decision", async (t) => {
  const { service, sender, directory } = await tempService(t, "cmux-push-inbox-");
  service.subscribe(subscription(), { hideContent: false });
  const hub = fakeHub();
  let fail = true;
  const items = [
    { request_id: "r-perm", kind: "permissionRequest", tool_name: "Bash", workspace_id: "ws-1" },
    { request_id: "r-q", kind: "question", question_prompt: "Which one?" },
    { request_id: "r-plan", kind: "exitPlan", plan_summary: "Ship docs/plan.md" },
    { request_id: "r-skip", kind: "unknown" },
    { kind: "question" },
  ];
  const detach = service.attach({ hub, cmux: { pendingFeed: async () => { if (fail) throw new Error("socket closed"); return { items }; } } });
  hub.emit("event", { name: "feed.item.received" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sender.sent.length, 0);
  fail = false;
  hub.emit("event", { name: "feed.item.received" });
  hub.emit("event", { name: "feed.item.received" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(sender.sent.map((item) => [item.payload.title, item.payload.body]), [
    ["Permission requested", "Review Bash before the agent continues."],
    ["Agent has a question", "Which one?"],
    ["Plan ready for review", "Ship docs/plan.md"],
  ]);
  assert.equal(sender.sent[2].payload.file, "docs/plan.md");
  detach();
  // An inspection scheduled before attach has no cmux client and must stay silent.
  const idleSender = fakeSender();
  const idle = new PushService({ path: join(directory, "idle.json"), sender: idleSender });
  idle.subscribe(subscription());
  idle.scheduleInboxInspection();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(idleSender.sent.length, 0);
});

test("completion alerts tolerate a failing inspection and summarise changed files", async (t) => {
  const { service, sender } = await tempService(t, "cmux-push-complete-");
  service.subscribe(subscription(), { hideContent: false });
  service.cmux = { workspaceListDetailed: async () => { throw new Error("cmux gone"); } };
  await service.inspectCompletion("ws-1", { name: "agent.hook.Stop", payload: { note: "all good" } });
  assert.equal(sender.sent[0].payload.title, "Agent finished");
  assert.equal(sender.sent[0].payload.body, "The coding session completed and is ready for review.");
  assert.match(sender.sent[0].payload.url, /tab=terminal/);

  service.cmux = {
    workspaceListDetailed: async () => ({ workspaces: [{ id: "ws-1", terminals: [{ id: "t-1", current_directory: "/repo/app" }, { id: "t-2", is_focused: true }] }] }),
    readScreen: async (id) => ({ text: id === "t-2" ? "Done. See docs/summary.md" : "" }),
  };
  service.repoCatalog = { list: async () => [{ id: "repo-1", path: "/repo" }], changes: async () => ({ files: [{ path: "a" }] }) };
  await service.inspectCompletion("ws-1", { name: "agent.hook.Stop" });
  assert.equal(sender.sent[1].payload.body, "1 file changed and ready to review.");
  assert.equal(sender.sent[1].payload.file, "docs/summary.md");
  assert.match(sender.sent[1].payload.url, /repo=repo-1.*tab=changes/);

  service.repoCatalog.changes = async () => { throw new Error("no git"); };
  service.cmux.readScreen = async () => ({ text: "Error: tests failed\nexit code 1" });
  await service.inspectCompletion("ws-1", { name: "agent.hook.Stop" });
  assert.equal(sender.sent[2].payload.title, "Agent finished with a failure");
  assert.equal(sender.sent[2].payload.kind, "failure");
  assert.equal(sender.sent[2].payload.body, "exit code 1");

  await service.inspectCompletion(null, { name: "agent.hook.Stop", payload: { text: "exited with 1" } });
  assert.equal(sender.sent[3].payload.body, "Tests or a command failed. Open the session to inspect the output.", "a failure with no quotable line gets the generic body");
  assert.match(sender.sent[3].payload.tag, /^cmux-failure-\d+$/);
});

test("pull request summaries describe pending checks and review decisions", async (t) => {
  const { service, sender } = await tempService(t, "cmux-push-pr-summary-");
  service.subscribe(subscription(), { hideContent: false });
  const snapshot = (pullRequest) => ({ repositories: [{ id: "repo-1", worktrees: [{ branch: "feature/x", pullRequest }] }] });
  const base = { number: 4, mergeState: "CLEAN", reviewDecision: null, checks: { failed: 0, pending: 0 } };
  await service.inspectPullRequests(snapshot(base));
  await service.inspectPullRequests(snapshot({ ...base, checks: { failed: 0, pending: 2 } }));
  await service.inspectPullRequests(snapshot({ ...base, checks: { failed: 0, pending: 1 } }));
  await service.inspectPullRequests(snapshot({ ...base, reviewDecision: "APPROVED" }));
  await service.inspectPullRequests(snapshot({ ...base, reviewDecision: "CHANGES_REQUESTED" }));
  await service.inspectPullRequests(snapshot({ ...base, mergeState: "DIRTY" }));
  await service.inspectPullRequests(snapshot({ ...base, checks: { failed: 2, pending: 0 } }));
  await service.inspectPullRequests(snapshot(null));
  await service.inspectPullRequests(snapshot(base));
  await service.inspectPullRequests(undefined);
  assert.deepEqual(sender.sent.map((item) => item.payload.body), [
    "2 checks are still running.",
    "1 check is still running.",
    "The pull request is approved and its checks are complete.",
    "A reviewer requested changes.",
    "The pull request status changed.",
    "2 checks failed.",
    "The pull request status changed.",
  ]);
  assert.equal(sender.sent.length, 7, "a reopened PR after none is announced; a removed PR is not");
  assert.equal(sender.sent[5].payload.title, "PR #4 checks failed");
  assert.equal(sender.sent[0].payload.title, "PR #4 updated");
  assert.match(sender.sent[0].payload.url, /view=inbox/, "a PR without a session links to the inbox");
});

test("remembers at most 500 delivered keys and recovers an unreadable state file", async (t) => {
  const { service } = await tempService(t, "cmux-push-memory-");
  for (let index = 0; index < 505; index += 1) assert.equal(service.remember(`k-${index}`), true);
  assert.equal(service.remember("k-100"), false);
  assert.equal(service.seen.size, 500);
  assert.equal(service.seen.has("k-0"), false, "the oldest key is forgotten first");
  const reloaded = new PushService({ path: service.path, sender: fakeSender() });
  assert.equal(reloaded.seen.size, 500);
  assert.equal(reloaded.remember("k-504"), false);
});
