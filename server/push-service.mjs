import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import webpush from "web-push";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "push.json");

export class PushService {
  constructor({
    path = process.env.CMUX_COMPANION_PUSH_FILE || DEFAULT_PATH,
    sender = webpush,
  } = {}) {
    this.path = path;
    this.sender = sender;
    this.state = this.load();
    this.seen = new Set();
    this.inspectTimer = null;
    this.cmux = null;
    this.ensureKeys();
  }

  get publicKey() {
    return this.state.vapid.publicKey;
  }

  status(endpoint = null) {
    const subscription = endpoint
      ? this.state.subscriptions.find((item) => item.endpoint === endpoint)
      : null;
    return {
      supported: true,
      publicKey: this.publicKey,
      subscriptionCount: this.state.subscriptions.length,
      subscribed: Boolean(subscription),
      settings: subscription?.settings || defaultSettings(),
    };
  }

  subscribe(subscription, settings = {}) {
    validateSubscription(subscription);
    const record = {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime || null,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      createdAt: new Date().toISOString(),
      settings: normalizeSettings(settings),
    };
    const index = this.state.subscriptions.findIndex((item) => item.endpoint === record.endpoint);
    if (index >= 0) this.state.subscriptions[index] = record;
    else this.state.subscriptions.push(record);
    this.save();
    return this.status(record.endpoint);
  }

  updateSettings(endpoint, settings) {
    const record = this.state.subscriptions.find((item) => item.endpoint === endpoint);
    if (!record) throw new TypeError("Unknown push subscription");
    record.settings = normalizeSettings(settings);
    this.save();
    return this.status(endpoint);
  }

  unsubscribe(endpoint) {
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      throw new TypeError("Invalid push subscription");
    }
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.endpoint !== endpoint);
    this.save();
    return { subscribed: false };
  }

  async send({ title, body, kind = "attention", workspaceId = null, surfaceId = null, tag = null }) {
    const payloadFor = (record) => JSON.stringify({
      title: record.settings.hideContent ? "cmux companion" : title,
      body: record.settings.hideContent ? "A session needs your attention." : body,
      kind,
      workspaceId,
      surfaceId,
      tag: tag || `cmux-${kind}-${workspaceId || "general"}`,
      url: workspaceId ? `/?workspace=${encodeURIComponent(workspaceId)}` : "/?view=inbox",
    });
    const stale = [];
    const results = await Promise.allSettled(this.state.subscriptions
      .filter((record) => record.settings[kind] !== false)
      .map(async (record) => {
        try {
          await this.sender.sendNotification(
            { endpoint: record.endpoint, expirationTime: record.expirationTime, keys: record.keys },
            payloadFor(record),
            { TTL: 300, urgency: kind === "attention" ? "high" : "normal" },
          );
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) stale.push(record.endpoint);
          else throw error;
        }
      }));
    if (stale.length) {
      this.state.subscriptions = this.state.subscriptions.filter((item) => !stale.includes(item.endpoint));
      this.save();
    }
    return {
      sent: results.filter((result) => result.status === "fulfilled").length,
      failed: results.filter((result) => result.status === "rejected").length,
    };
  }

  async test() {
    return this.send({
      title: "cmux companion is ready",
      body: "Background alerts are enabled on this device.",
      kind: "attention",
      tag: "cmux-push-test",
    });
  }

  attach({ hub, cmux }) {
    this.cmux = cmux;
    const onEvent = (event) => this.handleEvent(event);
    hub.on("event", onEvent);
    hub.addConsumer();
    return () => {
      hub.off("event", onEvent);
      hub.removeConsumer();
    };
  }

  handleEvent(event) {
    const name = String(event?.name || "");
    const workspaceId = event?.workspace_id || event?.payload?.workspace_id || event?.data?.workspace_id || null;
    if (name === "agent.hook.Stop") {
      const key = event.id || `${name}:${workspaceId}:${event.seq || Date.now()}`;
      if (this.remember(key)) {
        this.send({
          title: "Agent finished",
          body: "A coding session completed and is ready for review.",
          kind: "completion",
          workspaceId,
          tag: `cmux-complete-${workspaceId || key}`,
        }).catch(() => {});
      }
      return;
    }
    if (name === "agent.hook.Notification" || name === "notification.created") {
      const key = event.id || `${name}:${workspaceId}:${event.seq || Date.now()}`;
      if (this.remember(key)) {
        this.send({
          title: "Session needs attention",
          body: "Open the companion to review the latest agent notification.",
          kind: "attention",
          workspaceId,
          surfaceId: event?.surface_id || event?.payload?.surface_id || event?.data?.surface_id || null,
        }).catch(() => {});
      }
      return;
    }
    if (name === "feed.item.received") this.scheduleInboxInspection();
  }

  scheduleInboxInspection() {
    clearTimeout(this.inspectTimer);
    this.inspectTimer = setTimeout(async () => {
      if (!this.cmux) return;
      try {
        const payload = await this.cmux.pendingFeed();
        for (const item of payload.items || []) {
          if (!item.request_id || !["permissionRequest", "question", "exitPlan"].includes(item.kind)) continue;
          if (!this.remember(`feed:${item.request_id}`)) continue;
          await this.send({
            title: item.title || inboxTitle(item.kind),
            body: inboxBody(item),
            kind: "attention",
            workspaceId: item.workspace_id || null,
            tag: `cmux-feed-${item.request_id}`,
          });
        }
      } catch {
        // cmux may be closing; the event stream will reconnect later.
      }
    }, 300);
    this.inspectTimer.unref?.();
  }

  remember(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    return true;
  }

  ensureKeys() {
    if (!this.state.vapid?.publicKey || !this.state.vapid?.privateKey) {
      this.state.vapid = this.sender.generateVAPIDKeys();
      this.save();
    }
    this.sender.setVapidDetails(
      process.env.CMUX_COMPANION_VAPID_SUBJECT || "mailto:cmux-companion@localhost",
      this.state.vapid.publicKey,
      this.state.vapid.privateKey,
    );
  }

  load() {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      return {
        vapid: value.vapid || null,
        subscriptions: Array.isArray(value.subscriptions) ? value.subscriptions : [],
      };
    } catch {
      return { vapid: null, subscriptions: [] };
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function validateSubscription(subscription) {
  if (
    !subscription
    || typeof subscription.endpoint !== "string"
    || !subscription.endpoint.startsWith("https://")
    || typeof subscription.keys?.p256dh !== "string"
    || typeof subscription.keys?.auth !== "string"
  ) {
    throw new TypeError("Invalid push subscription");
  }
}

function normalizeSettings(settings = {}) {
  return {
    attention: settings.attention !== false,
    completion: settings.completion !== false,
    hideContent: settings.hideContent !== false,
  };
}

function defaultSettings() {
  return { attention: true, completion: true, hideContent: true };
}

function inboxTitle(kind) {
  if (kind === "permissionRequest") return "Permission requested";
  if (kind === "question") return "Agent has a question";
  return "Plan ready for review";
}

function inboxBody(item) {
  if (item.kind === "permissionRequest") return `Review ${item.tool_name || "the requested tool"} before the agent continues.`;
  if (item.kind === "question") return item.question_prompt || "The agent is waiting for your answer.";
  return item.plan_summary || "The agent is waiting for plan approval.";
}

export { defaultSettings };
