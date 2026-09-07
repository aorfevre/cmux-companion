import { readPrivateJson } from "./private-json-state.mjs";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import webpush from "web-push";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "push.json");
const EVENT_KINDS = new Set(["attention", "completion", "failure", "pullRequest", "preview"]);

export class PushService {
  constructor({
    path = process.env.CMUX_COMPANION_PUSH_FILE || DEFAULT_PATH,
    sender = webpush,
    now = () => new Date(),
    vapidSubject = process.env.CMUX_COMPANION_VAPID_SUBJECT || "https://cmux-companion.local",
  } = {}) {
    this.path = path;
    this.sender = sender;
    this.now = now;
    this.state = this.load();
    this.seen = new Set(this.state.delivered || []);
    this.inspectTimer = null;
    this.contextDebounce = null;
    this.contextTimer = null;
    this.cmux = null;
    this.repoCatalog = null;
    this.previewManager = null;
    this.prFingerprints = new Map();
    this.vapidSubject = validateVapidSubject(vapidSubject);
    this.ensureKeys();
  }

  get publicKey() { return this.state.vapid.publicKey; }

  status(endpoint = null) {
    const subscription = endpoint ? this.state.subscriptions.find((item) => item.endpoint === endpoint) : null;
    return {
      supported: true, publicKey: this.publicKey, subscriptionCount: this.state.subscriptions.length,
      subscribed: Boolean(subscription), settings: subscription?.settings || defaultSettings(),
    };
  }

  subscribe(subscription, settings = {}) {
    validateSubscription(subscription);
    const record = {
      endpoint: subscription.endpoint, expirationTime: subscription.expirationTime || null,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      createdAt: new Date().toISOString(), settings: normalizeSettings(settings),
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
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) throw new TypeError("Invalid push subscription");
    this.state.subscriptions = this.state.subscriptions.filter((item) => item.endpoint !== endpoint);
    this.save();
    return { subscribed: false };
  }

  async send({ title, body, kind = "attention", workspaceId = null, surfaceId = null, actionId = null, repoId = null, file = null, previewId = null, planId = null, tab = null, tag = null, bypassQuiet = false, bypassPreferences = false, targetEndpoint = null }) {
    if (!EVENT_KINDS.has(kind)) throw new TypeError("Unsupported notification kind");
    const url = contextUrl({ workspaceId, surfaceId, actionId, repoId, file, previewId, planId, tab, kind });
    const stale = [];
    const subscriptions = this.state.subscriptions;
    const targets = subscriptions
      .filter((record) => !targetEndpoint || record.endpoint === targetEndpoint)
      .filter((record) => bypassPreferences || (record.settings[kind] !== false && (bypassQuiet || !isQuiet(record.settings, this.now()))));
    if (targetEndpoint && !subscriptions.some((record) => record.endpoint === targetEndpoint)) {
      return { sent: 0, failed: 0, skipped: subscriptions.length, error: { code: "subscription-not-found", message: "This device is no longer registered. Disable and re-enable alerts." } };
    }
    if (!subscriptions.length) {
      return { sent: 0, failed: 0, skipped: 0, error: { code: "no-subscriptions", message: "No device is registered for background alerts." } };
    }
    const results = await Promise.allSettled(targets
      .map(async (record) => {
        const payload = JSON.stringify({
          title: record.settings.hideContent ? "cmux companion" : title,
          body: record.settings.hideContent ? discreetBody(kind) : body,
          kind, workspaceId, surfaceId, actionId, repoId, file, previewId, planId,
          tag: tag || `cmux-${kind}-${actionId || previewId || planId || workspaceId || "general"}`, url,
        });
        try {
          await this.sender.sendNotification(
            { endpoint: record.endpoint, expirationTime: record.expirationTime, keys: record.keys }, payload,
            { TTL: kind === "completion" ? 900 : 300, urgency: ["attention", "failure"].includes(kind) ? "high" : "normal" },
          );
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) stale.push(record.endpoint);
          throw error;
        }
      }));
    if (stale.length) {
      this.state.subscriptions = this.state.subscriptions.filter((item) => !stale.includes(item.endpoint));
      this.save();
    }
    const failures = results.filter((result) => result.status === "rejected");
    return {
      sent: results.filter((result) => result.status === "fulfilled").length,
      failed: failures.length,
      skipped: subscriptions.length - targets.length,
      error: failures.length ? publicPushError(failures[0].reason) : null,
    };
  }

  test(endpoint = null) {
    return this.send({ title: "cmux companion is ready", body: "Background alerts are enabled on this device.", kind: "attention", tag: "cmux-push-test", bypassQuiet: true, bypassPreferences: true, targetEndpoint: endpoint });
  }

  attach({ hub, cmux, repoCatalog = null, previewManager = null }) {
    this.cmux = cmux;
    this.repoCatalog = repoCatalog;
    this.previewManager = previewManager;
    const onEvent = (event) => this.handleEvent(event);
    const onPreviewDetected = (preview) => this.send({
      title: "Local app detected", body: `${preview.name} is listening on localhost:${preview.targetPort}.`,
      kind: "preview", workspaceId: preview.workspaceId, repoId: preview.repoId, previewId: preview.id,
      tag: `cmux-preview-detected-${preview.id}`,
    }).catch(() => {});
    const onPreviewReady = (preview) => this.send({
      title: "Private preview ready", body: `${preview.name} can now be opened from your phone.`,
      kind: "preview", workspaceId: preview.workspaceId, repoId: preview.repoId, previewId: preview.id,
      tag: `cmux-preview-ready-${preview.id}`,
    }).catch(() => {});
    hub.on("event", onEvent);
    previewManager?.on("detected", onPreviewDetected);
    previewManager?.on("ready", onPreviewReady);
    hub.addConsumer();
    this.contextTimer = setInterval(() => this.inspectContext().catch(() => {}), 60_000);
    this.contextTimer.unref?.();
    this.scheduleContextInspection();
    return () => {
      hub.off("event", onEvent);
      previewManager?.off("detected", onPreviewDetected);
      previewManager?.off("ready", onPreviewReady);
      hub.removeConsumer();
      clearTimeout(this.inspectTimer);
      clearTimeout(this.contextDebounce);
      clearInterval(this.contextTimer);
    };
  }

  handleEvent(event) {
    const name = String(event?.name || "");
    const workspaceId = event?.workspace_id || event?.payload?.workspace_id || event?.data?.workspace_id || null;
    if (name === "agent.hook.Stop") {
      const key = event.id || `${name}:${workspaceId}:${event.seq || Date.now()}`;
      if (this.remember(key)) this.inspectCompletion(workspaceId, event).catch(() => {});
      this.scheduleContextInspection();
      return;
    }
    if (name === "agent.hook.Notification" || name === "notification.created") {
      const key = event.id || `${name}:${workspaceId}:${event.seq || Date.now()}`;
      if (this.remember(key)) {
        const text = eventText(event);
        const classification = classifyEventText(text);
        this.send({
          title: classification === "failure" ? "Session failed" : "Session needs attention",
          body: classification === "failure" ? conciseFailure(text) : "Open the companion to review the latest agent notification.",
          kind: classification, workspaceId,
          surfaceId: event?.surface_id || event?.payload?.surface_id || event?.data?.surface_id || null,
          file: extractMarkdownPaths(text)[0] || null,
        }).catch(() => {});
      }
      this.scheduleContextInspection();
      return;
    }
    if (name === "feed.item.received") this.scheduleInboxInspection();
    this.scheduleContextInspection();
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
          const text = JSON.stringify(item);
          await this.send({
            title: item.title || inboxTitle(item.kind), body: inboxBody(item), kind: "attention",
            workspaceId: item.workspace_id || null, surfaceId: item.surface_id || null,
            actionId: item.request_id, file: extractMarkdownPaths(text)[0] || null,
            tag: `cmux-feed-${item.request_id}`,
          });
        }
      } catch {
        // cmux may be closing; the event stream will reconnect later.
      }
    }, 300);
    this.inspectTimer.unref?.();
  }

  scheduleContextInspection() {
    if (!this.previewManager && !this.repoCatalog) return;
    clearTimeout(this.contextDebounce);
    this.contextDebounce = setTimeout(() => this.inspectContext().catch(() => {}), 1_000);
    this.contextDebounce.unref?.();
  }

  async inspectContext() {
    if (!this.cmux) return;
    const [workspacePayload, repos] = await Promise.all([
      this.cmux.workspaceListDetailed?.().catch(() => ({ workspaces: [] })) || { workspaces: [] },
      this.repoCatalog?.list().catch(() => []) || [],
    ]);
    const workspaces = workspacePayload.workspaces || [];
    await this.previewManager?.syncWorkspaces(workspaces, repos);
  }

  // GitHub state arrives only from an explicit dashboard refresh. Reusing that
  // snapshot preserves PR notifications without a second background request.
  async inspectPullRequests(dashboard) {
    for (const repository of dashboard?.repositories || []) {
      for (const worktree of repository.worktrees || []) {
        const pullRequest = worktree.pullRequest;
        const key = `${repository.id}:${worktree.branch}`;
        const fingerprint = pullRequest ? JSON.stringify([pullRequest.number, pullRequest.reviewDecision, pullRequest.checks, pullRequest.mergeState]) : "none";
        const previous = this.prFingerprints.get(key);
        this.prFingerprints.set(key, fingerprint);
        if (!previous || previous === fingerprint || !pullRequest) continue;
        const workspace = worktree.sessions?.[0];
        await this.send({
          title: pullRequest.checks.failed ? `PR #${pullRequest.number} checks failed` : `PR #${pullRequest.number} updated`,
          body: pullRequestSummary(pullRequest), kind: "pullRequest", workspaceId: workspace?.id || null,
          repoId: repository.id, tab: "changes", tag: `cmux-pr-${repository.id}-${fingerprint}`,
        });
      }
    }
  }

  async inspectCompletion(workspaceId, event) {
    let screen = ""; let workspace = null; let repo = null;
    try {
      const [payload, repos] = await Promise.all([this.cmux?.workspaceListDetailed?.() || { workspaces: [] }, this.repoCatalog?.list() || []]);
      workspace = payload.workspaces?.find((item) => item.id === workspaceId) || null;
      const directory = workspace?.current_directory || workspace?.terminals?.[0]?.current_directory;
      repo = repos.find((item) => directory && (directory === item.path || directory.startsWith(`${item.path}/`))) || null;
      const terminal = workspace?.terminals?.find((item) => item.is_focused) || workspace?.terminals?.[0];
      if (terminal && this.cmux?.readScreen) screen = (await this.cmux.readScreen(terminal.id, 100)).text || "";
    } catch {
      // Completion notifications still work if contextual inspection fails.
    }
    const text = `${eventText(event)}\n${screen}`;
    const failed = classifyEventText(text) === "failure";
    const markdown = extractMarkdownPaths(text)[0] || null;
    let changes = null;
    if (repo) changes = await this.repoCatalog.changes(repo.id).catch(() => null);
    const changeCount = changes?.files?.length || 0;
    await this.send({
      title: failed ? "Agent finished with a failure" : "Agent finished",
      body: failed ? conciseFailure(text) : changeCount ? `${changeCount} file${changeCount === 1 ? "" : "s"} changed and ready to review.` : "The coding session completed and is ready for review.",
      kind: failed ? "failure" : "completion", workspaceId, repoId: repo?.id || null,
      file: markdown, tab: changeCount ? "changes" : "terminal",
      tag: `cmux-${failed ? "failure" : "complete"}-${workspaceId || Date.now()}`,
    });
    this.scheduleContextInspection();
  }

  remember(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    this.state.delivered = [...this.seen];
    this.save();
    return true;
  }

  ensureKeys() {
    if (!this.state.vapid?.publicKey || !this.state.vapid?.privateKey) { this.state.vapid = this.sender.generateVAPIDKeys(); this.save(); }
    this.sender.setVapidDetails(this.vapidSubject, this.state.vapid.publicKey, this.state.vapid.privateKey);
  }

  load() {
    const value = readPrivateJson(this.path, { vapid: null, subscriptions: [], delivered: [] }, value => value !== null && typeof value === "object" && Array.isArray(value.subscriptions));
    return { vapid: value.vapid || null, subscriptions: Array.isArray(value.subscriptions) ? value.subscriptions.map((item) => ({ ...item, settings: normalizeSettings(item.settings) })) : [], delivered: Array.isArray(value.delivered) ? value.delivered.filter((item) => typeof item === "string").slice(-500) : [] };
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function classifyEventText(text) {
  const normalized = String(text || "").replace(/\b(?:0\s+(?:tests?\s+)?failed|failed\s*[:=]\s*0|0\s+failures?)\b/gi, "");
  return /(?:\bfailed\b|\bfailure\b|\berror:|npm err!|tests? failed|build failed|command failed|exit(?:ed)? (?:code|with) [1-9])/i.test(normalized) ? "failure" : "attention";
}

export function extractMarkdownPaths(text) {
  const values = [];
  const source = String(text || "");
  const patterns = [
    /\[[^\]]*\]\(([^)]+\.(?:md|markdown))(?:#[^)]+)?\)/gim,
    /(?:^|[\s`'"(]|\[)((?:\.{0,2}\/|\/)?[a-zA-Z0-9_~.@+-][a-zA-Z0-9_~.@+\-/]*\.(?:md|markdown))(?=$|[\s`'"),\]:])/gim,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    const value = match[1].trim().replace(/^<|>$/g, "");
    if (value.length <= 1_024 && !values.includes(value)) values.push(value);
  }
  return values.slice(0, 12);
}

export function contextUrl({ workspaceId, surfaceId, actionId, repoId, file, previewId, planId, tab, kind } = {}) {
  const query = new URLSearchParams();
  if (actionId) { query.set("view", "inbox"); query.set("action", actionId); }
  else if (previewId) { query.set("view", "apps"); query.set("preview", previewId); }
  // A goal lives on the worktree dashboard, which is a mode of the sessions
  // view rather than a view of its own.
  else if (planId) { query.set("view", "sessions"); query.set("mode", "worktrees"); query.set("plan", planId); }
  else if (workspaceId) query.set("workspace", workspaceId);
  else query.set("view", "inbox");
  if (surfaceId) query.set("surface", surfaceId);
  if (repoId) query.set("repo", repoId);
  if (file) query.set("file", file);
  if (tab) query.set("tab", tab);
  if (kind) query.set("context", kind);
  return `/?${query}`;
}

function validateSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://") || typeof subscription.keys?.p256dh !== "string" || typeof subscription.keys?.auth !== "string") throw new TypeError("Invalid push subscription");
}

function validateVapidSubject(value) {
  if (typeof value !== "string") throw new TypeError("Invalid VAPID subject");
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      if (url.hostname && !url.username && !url.password) return url.href.replace(/\/$/, "");
    } catch {
      // Fall through to the actionable configuration error below.
    }
  }
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(value)) return value;
  throw new TypeError("CMUX_COMPANION_VAPID_SUBJECT must be a valid HTTPS URL or public email address");
}

function publicPushError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  let reason = "";
  if (typeof error?.body === "string" && error.body.length <= 2_048) {
    try { reason = String(JSON.parse(error.body)?.reason || ""); } catch { reason = ""; }
  }
  if (statusCode === 403 && /jwt|vapid/i.test(reason)) {
    return { code: "sender-authentication", message: "Push sender authentication failed. Reinstall the Mac companion.", statusCode };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { code: "subscription-expired", message: "This device's alert registration expired. Disable and re-enable alerts.", statusCode };
  }
  if (statusCode) return { code: "push-rejected", message: `The push service rejected the alert (HTTP ${statusCode}).`, statusCode };
  return { code: "push-unreachable", message: "The Mac could not reach the push notification service." };
}

function normalizeSettings(settings = {}) {
  const quietStart = /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.quietStart) ? settings.quietStart : "22:00";
  const quietEnd = /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.quietEnd) ? settings.quietEnd : "08:00";
  return {
    attention: settings.attention !== false, completion: settings.completion !== false,
    failure: settings.failure !== false, pullRequest: settings.pullRequest !== false,
    preview: settings.preview !== false, hideContent: settings.hideContent !== false,
    quietEnabled: settings.quietEnabled === true, quietStart, quietEnd,
  };
}

function defaultSettings() { return normalizeSettings(); }

function isQuiet(settings, now) {
  if (!settings.quietEnabled) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinutes(settings.quietStart); const end = toMinutes(settings.quietEnd);
  return start === end ? true : start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function discreetBody(kind) {
  if (kind === "completion") return "A session is ready for review.";
  if (kind === "preview") return "A private app preview is available.";
  if (kind === "pullRequest") return "A pull request changed.";
  if (kind === "failure") return "A session needs attention after a failure.";
  return "A session needs your attention.";
}

function eventText(event) { try { return JSON.stringify(event?.payload || event?.data || event || {}); } catch { return ""; } }

function conciseFailure(text) {
  const line = String(text || "").split("\n").map((item) => item.trim()).reverse().find((item) => /failed|failure|error|npm err|exit code/i.test(item));
  return (line || "Tests or a command failed. Open the session to inspect the output.").slice(0, 220);
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

function pullRequestSummary(pullRequest) {
  if (pullRequest.checks.failed) return `${pullRequest.checks.failed} check${pullRequest.checks.failed === 1 ? "" : "s"} failed.`;
  if (pullRequest.checks.pending) return `${pullRequest.checks.pending} check${pullRequest.checks.pending === 1 ? " is" : "s are"} still running.`;
  if (pullRequest.reviewDecision === "APPROVED") return "The pull request is approved and its checks are complete.";
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") return "A reviewer requested changes.";
  return "The pull request status changed.";
}

export { isQuiet };
