import Fastify from "fastify";
import websocket from "@fastify/websocket";
import httpProxy from "@fastify/http-proxy";
import { CmuxClient, CmuxCommandError } from "./cmux-client.mjs";
import { CmuxEventHub } from "./event-hub.mjs";
import { RepoCatalog } from "./repo-catalog.mjs";
import {
  isAuthorized,
  isSafeOrigin,
  safeEqual,
  sessionCookie,
  tailscaleIdentity,
} from "./security.mjs";

const PUBLIC_API = new Set(["/api/health", "/api/auth/status", "/api/auth/pair"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp({
  cmux = new CmuxClient(),
  token,
  frontendUpstream = null,
  logger = false,
  eventHub = null,
  repoCatalog = new RepoCatalog(),
  pushService = null,
} = {}) {
  if (!token) throw new Error("A companion pairing token is required");

  const app = Fastify({
    logger,
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 32 * 1024,
  });
  const hub = eventHub || new CmuxEventHub({ bin: cmux.bin, socketPassword: cmux.socketPassword });
  const pairAttempts = new Map();
  const detachPush = pushService?.attach({ hub, cmux }) || null;

  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");

    const path = request.url.split("?")[0];
    if (path.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      if (!PUBLIC_API.has(path) && !isAuthorized(request, token)) {
        return reply.code(401).send({ error: "Pair this device to continue", code: "UNAUTHORIZED" });
      }
      if (MUTATING.has(request.method) && !isSafeOrigin(request)) {
        return reply.code(403).send({ error: "Origin rejected", code: "BAD_ORIGIN" });
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    request.log?.error?.(error);
    if (error instanceof TypeError) {
      return reply.code(400).send({ error: error.message, code: "INVALID_REQUEST" });
    }
    if (error instanceof CmuxCommandError) {
      return reply.code(503).send({ error: "cmux is not available yet", code: "CMUX_UNAVAILABLE" });
    }
    return reply.code(error.statusCode || 500).send({
      error: error.statusCode && error.statusCode < 500 ? error.message : "Unexpected companion error",
      code: "COMPANION_ERROR",
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "cmux-companion",
    now: new Date().toISOString(),
  }));

  app.get("/api/auth/status", async (request) => ({
    paired: isAuthorized(request, token),
    identity: tailscaleIdentity(request),
  }));

  app.post("/api/auth/pair", async (request, reply) => {
    if (!allowPairAttempt(pairAttempts, request.ip)) {
      return reply.code(429).send({ error: "Too many pairing attempts. Try again later.", code: "PAIR_RATE_LIMIT" });
    }
    const candidate = request.body?.token;
    if (typeof candidate !== "string" || !safeEqual(candidate.trim(), token)) {
      return reply.code(401).send({ error: "That pairing code is not valid", code: "INVALID_TOKEN" });
    }
    reply.header("Set-Cookie", sessionCookie(request, token));
    pairAttempts.delete(request.ip);
    return { paired: true, identity: tailscaleIdentity(request) };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("Set-Cookie", "cmux_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return { paired: false };
  });

  app.get("/api/bootstrap", async () => {
    const [host, workspacePayload, capabilities] = await Promise.allSettled([
      cmux.hostStatus(),
      cmux.workspaceListDetailed ? cmux.workspaceListDetailed() : cmux.workspaceList(),
      cmux.capabilities(),
    ]);
    const connected = workspacePayload.status === "fulfilled";
    return {
      connected,
      host: host.status === "fulfilled" ? host.value : null,
      workspaces: connected ? workspacePayload.value.workspaces || [] : [],
      groups: connected ? workspacePayload.value.groups || [] : [],
      capabilities: capabilities.status === "fulfilled" ? capabilities.value : null,
      error: connected ? null : "Waiting for cmux",
      refreshedAt: new Date().toISOString(),
    };
  });

  app.get("/api/workspaces", async () => cmux.workspaceList());

  app.post("/api/workspaces", async (request, reply) => {
    const { repoId, title, agent = "shell", prompt = "", script = null } = request.body || {};
    const repo = await repoCatalog.get(repoId);
    if (script !== null && !repo.scripts.includes(script)) throw new TypeError("That package script is not available");
    const created = await cmux.workspaceCreate({
      cwd: repo.path,
      title: typeof title === "string" && title.trim() ? title : repo.name,
      agent,
      prompt,
      script,
    });
    repoCatalog.cache = null;
    return reply.code(201).send({ workspace: created, repo: { id: repo.id, name: repo.name } });
  });

  app.get("/api/workspaces/:id/overview", async (request) => cmux.workspaceOverview(request.params.id));

  app.post("/api/workspaces/:id/rename", async (request) => cmux.workspaceRename(request.params.id, request.body?.title));

  app.post("/api/workspaces/:id/close", async (request) => cmux.workspaceClose(request.params.id));

  app.post("/api/workspaces/:id/respawn", async (request) => (
    cmux.workspaceRespawn(request.params.id, request.body?.surfaceId)
  ));

  app.post("/api/workspaces/:id/todos/:todoId/:action", async (request) => (
    cmux.todoAction(request.params.id, request.params.todoId, request.params.action)
  ));

  app.get("/api/repos", async (request) => ({ repos: await repoCatalog.list({ refresh: request.query?.refresh === "1" }) }));

  app.get("/api/repos/:id/changes", async (request) => repoCatalog.changes(request.params.id));

  app.get("/api/repos/:id/diff", async (request) => {
    const file = request.query?.file;
    if (typeof file !== "string" || !file) throw new TypeError("A changed file is required");
    return repoCatalog.diff(request.params.id, file, { staged: request.query?.staged === "1" });
  });

  app.get("/api/inbox", async () => {
    const [feed, notifications] = await Promise.all([
      cmux.pendingFeed(),
      cmux.notifications().catch(() => ({ notifications: [] })),
    ]);
    return normalizeInbox(feed, notifications);
  });

  app.post("/api/inbox/:requestId/reply", async (request) => {
    const result = await cmux.feedReply(request.params.requestId, request.body?.kind, request.body || {});
    return { ok: true, result };
  });

  app.post("/api/notifications/:id/read", async (request) => cmux.markNotificationRead(request.params.id));

  app.get("/api/push/status", async (request) => {
    if (!pushService) return { supported: false, subscribed: false };
    return pushService.status(typeof request.query?.endpoint === "string" ? request.query.endpoint : null);
  });

  app.post("/api/push/subscribe", async (request) => {
    if (!pushService) throw serviceUnavailable("Push alerts are unavailable");
    return pushService.subscribe(request.body?.subscription, request.body?.settings);
  });

  app.post("/api/push/settings", async (request) => {
    if (!pushService) throw serviceUnavailable("Push alerts are unavailable");
    return pushService.updateSettings(request.body?.endpoint, request.body?.settings);
  });

  app.post("/api/push/unsubscribe", async (request) => {
    if (!pushService) throw serviceUnavailable("Push alerts are unavailable");
    return pushService.unsubscribe(request.body?.endpoint);
  });

  app.post("/api/push/test", async () => {
    if (!pushService) throw serviceUnavailable("Push alerts are unavailable");
    return pushService.test();
  });

  app.get("/api/terminals/:id/screen", async (request) => {
    return cmux.readScreen(request.params.id, request.query?.lines);
  });

  app.post("/api/terminals/:id/input", async (request) => {
    const { text, enter = false } = request.body || {};
    if (enter) await cmux.sendPrompt(request.params.id, text);
    else await cmux.sendText(request.params.id, text);
    return { ok: true };
  });

  app.post("/api/terminals/:id/key", async (request) => {
    await cmux.sendKey(request.params.id, request.body?.key);
    return { ok: true };
  });

  app.post("/api/workspaces/:id/select", async (request) => {
    await cmux.selectWorkspace(request.params.id);
    return { ok: true };
  });

  app.get("/api/events", { websocket: true }, (socket) => {
    const send = (type, payload) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type, payload }));
    };
    const onEvent = (payload) => send("cmux:event", payload);
    const onState = (payload) => send("cmux:state", payload);
    hub.on("event", onEvent);
    hub.on("state", onState);
    hub.addConsumer();
    send("companion:ready", { at: new Date().toISOString() });

    const heartbeat = setInterval(() => send("companion:heartbeat", { at: Date.now() }), 20_000);
    heartbeat.unref?.();
    socket.on("close", () => {
      clearInterval(heartbeat);
      hub.off("event", onEvent);
      hub.off("state", onState);
      hub.removeConsumer();
    });
  });

  app.addHook("onClose", async () => {
    detachPush?.();
    hub.stop();
  });

  if (frontendUpstream) {
    await app.register(httpProxy, {
      upstream: frontendUpstream,
      websocket: false,
      replyOptions: {
        rewriteRequestHeaders: (_request, headers) => ({
          ...headers,
          host: new URL(frontendUpstream).host,
        }),
      },
    });
  }

  return app;
}

export function normalizeInbox(feed = {}, notificationPayload = {}) {
  const actionable = (feed.items || [])
    .filter((item) => item.request_id && ["permissionRequest", "question", "exitPlan"].includes(item.kind))
    .map((item) => ({
      id: item.request_id,
      requestId: item.request_id,
      type: "request",
      kind: item.kind,
      workspaceId: item.workspace_id || null,
      surfaceId: item.surface_id || null,
      source: item.source || null,
      title: item.title || inboxTitle(item.kind),
      toolName: item.tool_name || null,
      toolInput: item.tool_input || null,
      questionOptions: item.question_options || item.questions?.[0]?.options || [],
      questions: item.questions || [],
      defaultMode: item.default_mode || null,
      createdAt: item.created_at || null,
    }));
  const notifications = (notificationPayload.notifications || [])
    .filter((item) => !item.is_read)
    .map((item) => ({
      id: item.id,
      type: "notification",
      kind: "notification",
      workspaceId: item.workspace_id || null,
      surfaceId: item.surface_id || null,
      title: item.title || "cmux",
      subtitle: item.subtitle || null,
      body: item.body || "",
      createdAt: item.created_at || null,
    }));
  return { items: [...actionable, ...notifications], actionableCount: actionable.length, unreadCount: notifications.length };
}

function inboxTitle(kind) {
  if (kind === "permissionRequest") return "Permission requested";
  if (kind === "question") return "Agent question";
  return "Plan ready for review";
}

function allowPairAttempt(store, ip) {
  const now = Date.now();
  const record = store.get(ip) || { count: 0, since: now };
  if (now - record.since > 15 * 60_000) {
    record.count = 0;
    record.since = now;
  }
  record.count += 1;
  store.set(ip, record);
  return record.count <= 8;
}

function serviceUnavailable(message) {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}
