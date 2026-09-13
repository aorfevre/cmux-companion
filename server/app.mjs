import { WRITE_SCHEMAS, schemaErrorFormatter } from "./request-schemas.mjs";
import { releaseRetention } from "./release-retention.mjs";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import websocket from "@fastify/websocket";
import httpProxy from "@fastify/http-proxy";
import { resolveExecutable } from "./local-settings.mjs";
import { registerSettingsRoutes } from "./settings-routes.mjs";
import { ModelSettings } from "./model-settings.mjs";
import { CmuxClient, CmuxCommandError } from "./cmux-client.mjs";
import { CmuxEventHub } from "./event-hub.mjs";
import { ImageAttachments, MAX_IMAGE_BYTES } from "./image-attachments.mjs";
import { capturePreview } from "./preview-capture.mjs";
import { RepoCatalog } from "./repo-catalog.mjs";
import { isWorktreeReason } from "./worktree-errors.mjs";
import { AccountUsage } from "./account-usage.mjs";
import { CcsReconnectManager } from "./ccs-reconnect.mjs";
import { deploymentStatus, updaterLaunchAgentRunning } from "./deployment-health.mjs";
import {
  isAuthorized,
  isSessionAuthorized,
  isSafeOrigin,
  safeEqual,
  sessionCookie,
  tailscaleIdentity,
} from "./security.mjs";

const PUBLIC_API = new Set(["/api/health", "/api/auth/status", "/api/auth/pair"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export async function buildApp({
  cmux = new CmuxClient(),
  modelSettings = new ModelSettings(),
  localSettings = null,
  onSettingsChange = async () => {},
  probeProvider,
  browseSettingsFolders,
  token,
  app: suppliedApp = null,
  frontendUpstream = null,
  logger = false,
  eventHub = null,
  repoCatalog = new RepoCatalog(),
  pushService = null,
  previewManager = null,
  promptQueue = null,
  previewCapture = capturePreview,
  imageAttachments = new ImageAttachments(),
  accountUsage = new AccountUsage(),
  ccsReconnect = null,
  releaseVersion = {
    gitSha: process.env.CMUX_COMPANION_RELEASE_SHA || "development",
    builtAt: process.env.CMUX_COMPANION_BUILT_AT || null,
  },
  updaterStatePath = process.env.CMUX_COMPANION_UPDATER_STATE || null,
  updaterConfigPath = process.env.CMUX_COMPANION_UPDATER_CONFIG || (updaterStatePath ? join(dirname(dirname(updaterStatePath)), "updater.json") : null),
  updaterProcessCheck = updaterLaunchAgentRunning,
  // A dashboard snapshot spawns one git child per repository, and bootstrap
  // spawns cmux children. On a saturated machine `posix_spawn` becomes slow
  // enough to hold the event loop, and a request with no deadline waits for
  // ever. These caps turn that wait into an answer the board can render.
  bootstrapTimeoutMs = Number(process.env.CMUX_COMPANION_BOOTSTRAP_TIMEOUT_MS) || 12_000,
} = {}) {
  if (!token) throw new Error("A companion pairing token is required");

  const app = suppliedApp || Fastify({
    logger,
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 32 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    schemaErrorFormatter,
  });
  const reconnect = ccsReconnect || new CcsReconnectManager({ accountUsage });
  const hub = eventHub || new CmuxEventHub({ bin: cmux.bin, socketPassword: cmux.socketPassword });
  const pairAttempts = new Map();
  const viewportLeases = new Map();
  let bootstrapSnapshot = null;
  let bootstrapPending = null;
  let inboxSnapshot = null;
  let inboxPending = null;
  const detachPush = pushService?.attach({ hub, cmux, repoCatalog, previewManager }) || null;
  const detachQueue = promptQueue?.attach({ hub, cmux }) || null;
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
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");

    const path = request.routeOptions.url || request.url.split("?")[0];
    if (path.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      const authorized = isAuthorized(request, token);
      if (!PUBLIC_API.has(path) && !authorized) {
        return reply.code(401).send({ error: "Pair this device to continue", code: "UNAUTHORIZED" });
      }
      if (authorized && path !== "/api/auth/pair" && path !== "/api/auth/logout" && isSessionAuthorized(request, token)) {
        reply.header("Set-Cookie", sessionCookie(request, token));
      }
      if (MUTATING.has(request.method) && !isSafeOrigin(request)) {
        return reply.code(403).send({ error: "Origin rejected", code: "BAD_ORIGIN" });
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    request.log?.error?.(error);
    if (error instanceof TypeError) {
      return reply.code(400).send({
        error: error.message,
        code: "INVALID_REQUEST",
        ...(typeof error.planId === "string" ? { planId: error.planId } : {}),
        ...(isWorktreeReason(error.reason) ? { reason: error.reason } : {}),
      });
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
    version: releaseVersion,
  }));

  app.get("/api/updater/status", async () => {
    if (!updaterStatePath) return { available: false };
    try {
      const state = JSON.parse(await readFile(updaterStatePath, "utf8"));
      const config = updaterConfigPath
        ? await readFile(updaterConfigPath, "utf8").then(JSON.parse).catch(() => null)
        : null;
      const health = deploymentStatus(state, releaseVersion, Date.now(), {
        updaterProcessRunning: await updaterProcessCheck(),
        updaterEnabled: config ? config.enabled !== false : true,
      });
      return {
        available: true,
        enabled: config ? config.enabled !== false : null,
        deployedSha: state.deployedSha || null,
        observedRemoteSha: state.observedRemoteSha || null,
        pendingSha: state.pendingSha || null,
        phase: state.phase || "idle",
        lastCheckAt: state.lastCheckAt || null,
        lastSuccessAt: state.lastSuccessAt || null,
        lastFailureAt: state.lastFailureAt || null,
        lastError: state.lastError || null,
        restartExpected: state.restartExpected === true,
        summary: health.summary,
        services: health.services,
      };
    } catch {
      return { available: false };
    }
  });

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

  const loadBootstrap = async () => {
    if (bootstrapSnapshot && Date.now() - bootstrapSnapshot.at < 1_500) return bootstrapSnapshot.value;
    if (bootstrapPending) return bootstrapPending;
    bootstrapPending = (async () => {
      const [host, workspacePayload, capabilities] = await Promise.allSettled([
        cmux.hostStatus(),
        cmux.workspaceListDetailed ? cmux.workspaceListDetailed() : cmux.workspaceList(),
        cmux.capabilities(),
      ]);
      const connected = workspacePayload.status === "fulfilled";
      // Preview syncing is a side effect of bootstrap, not part of its answer.
      // It scans every repository, so a saturated machine must not let it hold
      // the reply that the whole page waits on.
      if (connected && previewManager) {
        await withDeadline((async () => {
          const repos = await repoCatalog.list().catch(() => []);
          await previewManager.syncWorkspaces(workspacePayload.value.workspaces || [], repos).catch(() => {});
        })(), bootstrapTimeoutMs, "Preview sync timed out").catch((cause) => {
          app.log.warn({ err: cause }, "preview sync skipped");
        });
      }
      const value = {
        connected,
        ...(localSettings ? { setupRequired: !localSettings.read().settings.onboarding.completed } : {}),
        host: host.status === "fulfilled" ? host.value : null,
        workspaces: connected ? workspacePayload.value.workspaces || [] : [],
        groups: connected ? workspacePayload.value.groups || [] : [],
        capabilities: capabilities.status === "fulfilled" ? capabilities.value : null,
        error: connected ? null : "Waiting for cmux",
        refreshedAt: new Date().toISOString(),
      };
      bootstrapSnapshot = { at: Date.now(), value };
      return value;
    })();
    try {
      return await bootstrapPending;
    } finally {
      bootstrapPending = null;
    }
  };

  // The whole page waits on this call, so it answers "Waiting for cmux" rather
  // than holding the connection open when cmux cannot be reached in time.
  app.get("/api/bootstrap", async () => withDeadline(loadBootstrap(), bootstrapTimeoutMs, "cmux did not answer in time")
    .catch((cause) => {
      app.log.warn({ err: cause }, "bootstrap timed out");
      return {
        connected: false,
        host: null,
        workspaces: [],
        groups: [],
        capabilities: null,
        error: "Waiting for cmux",
        refreshedAt: new Date().toISOString(),
      };
    }));

  app.get("/api/account-usage", async (request) => accountUsage.snapshot({
    refresh: request.query?.refresh === "1",
  }));

  app.post("/api/account-usage/:accountId/reconnect", async (request, reply) => (
    reply.code(201).send(await reconnect.start(request.params.accountId))
  ));

  app.get("/api/account-usage/reconnect/:sessionId", async (request) => reconnect.status(request.params.sessionId));

  app.post("/api/account-usage/reconnect/:sessionId/callback", async (request) => (
    reconnect.submitCallback(request.params.sessionId, request.body?.callbackUrl)
  ));

  app.delete("/api/account-usage/reconnect/:sessionId", async (request) => reconnect.cancel(request.params.sessionId));

  app.get("/api/worktree-cleanup/releases", async () => releaseRetention("status"));
  app.patch("/api/worktree-cleanup/releases", async (request) => releaseRetention("configure", request.body));
  app.post("/api/worktree-cleanup/releases/preview", async () => releaseRetention("preview"));
  app.post("/api/worktree-cleanup/releases/run", async (request) => releaseRetention("run", { previewId: request.body?.previewId, ids: request.body?.ids }));

  if (localSettings) registerSettingsRoutes(app, { settings: localSettings, onChange: async value => {
    if (hub.bin !== value.settings.tools.cmux) { hub.stop(); hub.bin = value.settings.tools.cmux; hub.start(); }
    bootstrapSnapshot = null;
    await onSettingsChange(value);
  }, probeProvider, browse: browseSettingsFolders });

  if (!localSettings) app.get("/api/settings/local", async (_request, reply) => reply.code(409).send({ code: "SETTINGS_IMPORT_REQUIRED", error: "This installation uses the previous configuration format. Import its settings on the Mac to enable project management." }));
  app.get("/api/settings/models", async () => modelSettings.status());
  app.patch("/api/settings/models", async (request) => modelSettings.configure(request.body));

  app.get("/api/workspaces", async () => cmux.workspaceList());

  app.post("/api/workspaces", async (request, reply) => {
    const { repoId, title, agent = "shell", prompt = "", script = null } = request.body || {};
    const repo = await repoCatalog.get(repoId);
    if (script !== null && !repo.scripts.includes(script)) throw new TypeError("That package script is not available");
    const created = await cmux.workspaceCreate({
      cwd: repo.path,
      title: typeof title === "string" && title.trim() ? title : repo.name,
      ...modelSettings.workspace("coder", agent),
      prompt,
      script,
    });
    // Launching an agent into a repository changes its working tree, so the
    // cached status must go with the cached listing.
    if (repoCatalog.invalidate) repoCatalog.invalidate(); else repoCatalog.cache = null;
    return reply.code(201).send({ workspace: created, repo: { id: repo.id, name: repo.name } });
  });

  app.get("/api/workspaces/:id/overview", async (request) => cmux.workspaceOverview(request.params.id));

  app.post("/api/workspaces/:id/rename", async (request) => cmux.workspaceRename(request.params.id, request.body?.title));

  app.post("/api/workspaces/:id/close", async (request) => {
    const result = await cmux.workspaceClose(request.params.id);
    bootstrapSnapshot = null;
    return result;
  });

  app.post("/api/workspaces/:id/respawn", { schema: WRITE_SCHEMAS.respawn }, async (request) => (
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

  app.get("/api/repos/:id/pull-request", async (request) => (
    repoCatalog.pullRequest(request.params.id, { refresh: request.query?.refresh === "1" })
  ));

  app.get("/api/repos/:id/markdown", async (request) => {
    if (typeof request.query?.file !== "string") throw new TypeError("A Markdown file is required");
    return repoCatalog.markdown(request.params.id, request.query.file);
  });

  app.get("/api/repos/:id/assets", async (request, reply) => {
    if (typeof request.query?.file !== "string") throw new TypeError("A Markdown asset is required");
    const asset = await repoCatalog.asset(request.params.id, request.query.file);
    return reply.header("Cache-Control", "private, max-age=60").type(asset.mime).send(asset.content);
  });

  app.get("/api/previews", async () => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    return previewManager.list();
  });

  app.post("/api/previews/discover", async (request, reply) => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    const payload = await cmux.workspaceListDetailed?.() || await cmux.workspaceList();
    const workspace = (payload.workspaces || []).find((item) => item.id === request.body?.workspaceId);
    if (!workspace) throw new TypeError("Unknown workspace");
    let repo = null;
    if (request.body?.repoId) repo = await repoCatalog.get(request.body.repoId);
    const result = previewManager.discover({
      workspaceId: workspace.id, repoId: repo?.id || null,
      name: repo?.name || workspace.title || "Local app",
      targetPort: request.body?.port, sourceUrl: request.body?.url,
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post("/api/previews/:id/enable", async (request) => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    return previewManager.enable(request.params.id);
  });

  app.post("/api/previews/:id/stop", async (request) => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    return previewManager.stop(request.params.id);
  });

  app.post("/api/previews/:id/restart", async (request) => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    return previewManager.restart(request.params.id);
  });

  app.delete("/api/previews/:id", async (request) => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    return previewManager.remove(request.params.id);
  });

  app.post("/api/previews/:id/capture", async (request, reply) => {
    if (!previewManager) throw serviceUnavailable("Private previews are unavailable");
    const preview = previewManager.require(request.params.id);
    const captured = await previewCapture({
      sourceUrl: preview.sourceUrl,
      targetPort: preview.targetPort,
      width: request.body?.width,
      height: request.body?.height,
      ...(localSettings ? { executablePath: resolveExecutable(localSettings.read().settings.tools.chrome) || localSettings.read().settings.tools.chrome } : {}),
    });
    if (captured.buffer.length > MAX_IMAGE_BYTES) throw new TypeError("The captured preview is too large to annotate");
    const dataUrl = `data:image/png;base64,${captured.buffer.toString("base64")}`;
    return reply.code(201).send({ dataUrl, viewport: captured.viewport, sourceUrl: captured.sourceUrl });
  });

  const loadInbox = async () => {
    if (inboxSnapshot && Date.now() - inboxSnapshot.at < 1_500) return inboxSnapshot.value;
    if (inboxPending) return inboxPending;
    inboxPending = (async () => {
      const [feed, notifications] = await Promise.all([
        cmux.pendingFeed(),
        cmux.notifications().catch(() => ({ notifications: [] })),
      ]);
      const value = normalizeInbox(feed, notifications);
      inboxSnapshot = { at: Date.now(), value };
      return value;
    })();
    try {
      return await inboxPending;
    } finally {
      inboxPending = null;
    }
  };

  app.get("/api/inbox", async () => loadInbox());
  app.post("/api/inbox/:requestId/reply", async (request) => {
    const result = await cmux.feedReply(request.params.requestId, request.body?.kind, request.body || {});
    inboxSnapshot = null;
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

  app.post("/api/push/test", async (request) => {
    if (!pushService) throw serviceUnavailable("Push alerts are unavailable");
    return pushService.test(typeof request.body?.endpoint === "string" ? request.body.endpoint : null);
  });

  app.get("/api/terminals/:id/screen", async (request) => {
    return cmux.readScreen(request.params.id, request.query?.lines);
  });

  app.get("/api/terminals/:id/replay", async (request) => {
    const id = request.params.id;
    try {
      const replay = await cmux.terminalReplay(id, request.query?.scrollback);
      if (replay?.render_grid?.format === "cmux.render-grid.v1") {
        return { ...replay, mode: "grid" };
      }
    } catch (error) {
      if (!(error instanceof CmuxCommandError)) throw error;
    }
    const screen = await cmux.readScreen(id, request.query?.scrollback);
    return { ...screen, surface_id: id, mode: "text" };
  });

  app.post("/api/terminals/:id/viewport", async (request) => {
    const { clientId, generation, columns, rows, clear = false } = request.body || {};
    const surfaceId = request.params.id;
    const leaseKey = `${surfaceId}:${clientId}`;
    const previous = viewportLeases.get(leaseKey);
    const result = await cmux.terminalViewport(surfaceId, { clientId, generation, columns, rows, clear });
    if (clear) {
      if (previous) clearTimeout(previous.timer);
      viewportLeases.delete(leaseKey);
      return result;
    }
    if (previous) clearTimeout(previous.timer);
    const lease = { surfaceId, clientId, generation: Number(generation) + 1, timer: null };
    lease.timer = setTimeout(async () => {
      if (viewportLeases.get(leaseKey) !== lease) return;
      viewportLeases.delete(leaseKey);
      await cmux.terminalViewport(surfaceId, { clientId, generation: lease.generation, clear: true }).catch(() => {});
    }, 25_000);
    lease.timer.unref?.();
    viewportLeases.set(leaseKey, lease);
    return result;
  });

  app.post("/api/attachments/images", { bodyLimit: Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32 * 1024 }, async (request, reply) => {
    const image = await imageAttachments.save(request.body?.dataUrl, request.body?.name);
    return reply.code(201).send({ image });
  });

  app.post("/api/terminals/:id/input", { schema: WRITE_SCHEMAS.input }, async (request) => {
    const { text, enter = false } = request.body || {};
    if (enter) await cmux.sendPrompt(request.params.id, text);
    else await cmux.sendText(request.params.id, text);
    return { ok: true };
  });

  app.get("/api/prompt-queue", async (request) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    return promptQueue.list({
      workspaceId: typeof request.query?.workspaceId === "string" ? request.query.workspaceId : null,
      surfaceId: typeof request.query?.surfaceId === "string" ? request.query.surfaceId : null,
    });
  });

  app.post("/api/prompt-queue", { schema: WRITE_SCHEMAS.queue }, async (request, reply) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    const payload = await cmux.workspaceListDetailed?.() || await cmux.workspaceList();
    const workspace = (payload.workspaces || []).find((item) => item.id === request.body?.workspaceId);
    const terminal = workspace?.terminals?.find((item) => item.id === request.body?.surfaceId);
    if (!workspace || !terminal) throw new TypeError("Unknown cmux terminal");
    return reply.code(201).send(promptQueue.enqueue({ workspaceId: workspace.id, surfaceId: terminal.id, text: request.body?.text }));
  });

  app.patch("/api/prompt-queue/:id", { schema: WRITE_SCHEMAS.queueUpdate }, async (request) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    return promptQueue.update(request.params.id, request.body);
  });

  app.post("/api/prompt-queue/:id/move", { schema: WRITE_SCHEMAS.queueMove }, async (request) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    return promptQueue.move(request.params.id, request.body?.direction);
  });

  app.post("/api/prompt-queue/:id/send", async (request) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    return promptQueue.sendNow(request.params.id, cmux);
  });

  app.delete("/api/prompt-queue/:id", async (request) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    return promptQueue.remove(request.params.id);
  });

  app.post("/api/terminals/:id/key", { schema: WRITE_SCHEMAS.key }, async (request) => {
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
    const onQueue = (payload) => send("queue:changed", payload);
    hub.on("event", onEvent);
    hub.on("state", onState);
    promptQueue?.on("changed", onQueue);
    hub.addConsumer();
    send("companion:ready", { at: new Date().toISOString() });

    const heartbeat = setInterval(() => send("companion:heartbeat", { at: Date.now() }), 20_000);
    heartbeat.unref?.();
    socket.on("close", () => {
      clearInterval(heartbeat);
      hub.off("event", onEvent);
      hub.off("state", onState);
      promptQueue?.off("changed", onQueue);
      hub.removeConsumer();
    });
  });

  app.addHook("onClose", async () => {
    const leases = [...viewportLeases.values()];
    viewportLeases.clear();
    await Promise.allSettled(leases.map((lease) => {
      clearTimeout(lease.timer);
      return cmux.terminalViewport(lease.surfaceId, { clientId: lease.clientId, generation: lease.generation, clear: true });
    }));
    detachPush?.();
    detachQueue?.();
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
      subtitle: item.subtitle || null,
      body: item.question_prompt || item.plan_summary || item.body || "",
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

// Reject after `ms` instead of waiting for a child process that a saturated
// machine may never schedule. The underlying promise is left to settle on its
// own: cancelling it is not possible, and its own child-process timeout ends
// it. The timer stays referenced so the deadline still fires while a request
// is the only work in flight; it is cleared as soon as either side settles.
export function withDeadline(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(serviceUnavailable(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause) => { clearTimeout(timer); reject(cause); },
    );
  });
}

// An optional plan id. An empty body means every plan, which is what the timer
// pass does; anything that is present but not a usable id is a mistake worth
// reporting rather than silently widening the pass to every goal.
function serviceUnavailable(message) {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}
