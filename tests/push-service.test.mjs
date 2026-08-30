import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PushService } from "../server/push-service.mjs";

function subscription(endpoint = "https://push.example.test/device") {
  return { endpoint, expirationTime: null, keys: { p256dh: "public-key", auth: "auth-key" } };
}

function fakeSender() {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: "vapid-public", privateKey: "vapid-private" }),
    setVapidDetails: () => {},
    sendNotification: async (target, payload) => { sent.push({ target, payload: JSON.parse(payload) }); },
  };
}

test("persists per-device subscriptions and applies privacy/settings filters", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-"));
  const path = join(directory, "push.json");
  const sender = fakeSender();
  const service = new PushService({ path, sender });
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

test("turns completion and actionable feed events into focused alerts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-push-events-"));
  const sender = fakeSender();
  const service = new PushService({ path: join(directory, "push.json"), sender });
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
  assert.equal(sender.sent[1].payload.url, "/?workspace=ws-1");
  detach();
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
});
