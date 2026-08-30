import Fastify from "fastify";
import websocket from "@fastify/websocket";
import httpProxy from "@fastify/http-proxy";
import { CmuxClient, CmuxCommandError } from "./cmux-client.mjs";
import { CmuxEventHub } from "./event-hub.mjs";
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
} = {}) {
  if (!token) throw new Error("A companion pairing token is required");

  const app = Fastify({
    logger,
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 32 * 1024,
  });
  const hub = eventHub || new CmuxEventHub({ bin: cmux.bin, socketPassword: cmux.socketPassword });

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
    const candidate = request.body?.token;
    if (typeof candidate !== "string" || !safeEqual(candidate.trim(), token)) {
      return reply.code(401).send({ error: "That pairing code is not valid", code: "INVALID_TOKEN" });
    }
    reply.header("Set-Cookie", sessionCookie(request, token));
    return { paired: true, identity: tailscaleIdentity(request) };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("Set-Cookie", "cmux_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return { paired: false };
  });

  app.get("/api/bootstrap", async () => {
    const [host, workspacePayload, capabilities] = await Promise.allSettled([
      cmux.hostStatus(),
      cmux.workspaceList(),
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

  app.addHook("onClose", async () => hub.stop());

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
