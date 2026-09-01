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
