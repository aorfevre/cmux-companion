import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import websocket from "@fastify/websocket";
import httpProxy from "@fastify/http-proxy";
import { CmuxClient, CmuxCommandError } from "./cmux-client.mjs";
import { CmuxEventHub } from "./event-hub.mjs";
import { PlannerProgress, TRACE_ID } from "./planner-progress.mjs";
import { ImageAttachments, MAX_IMAGE_BYTES } from "./image-attachments.mjs";
import { capturePreview } from "./preview-capture.mjs";
import { RepoCatalog } from "./repo-catalog.mjs";
import { WorktreeDashboard } from "./worktree-dashboard.mjs";
import { AgentBriefs } from "./agent-brief.mjs";
import { WorktreePlanner } from "./worktree-planner.mjs";
import { WorktreePlanStore } from "./worktree-plan-store.mjs";
import { GoalIntegrator } from "./goal-integrator.mjs";
import { GoalFollowups } from "./goal-followup.mjs";
import { GitHubReviewToken } from "./github-review-token.mjs";
import { normalizeReviewOptions } from "./review-options.mjs";
import { agentCapacity } from "./agent-capacity.mjs";
import { GoalHealthSweep } from "./goal-health.mjs";
import { GoalWatchdog } from "./goal-watchdog.mjs";
import { GoalSessionReaper } from "./goal-session-reaper.mjs";
import { GoalMergeWatch } from "./goal-merge-watch.mjs";
import { GitHubIssuePlanner } from "./github-issue-planner.mjs";
import { GitHubIssueStore } from "./github-issue-store.mjs";
import { GitHubIssueSync } from "./github-issue-sync.mjs";
import { GitHubIssueSyncScheduler } from "./github-issue-sync-scheduler.mjs";
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
// The dashboard sends this sentence itself, so the board can tell an overloaded
// Mac apart from a broken companion. Both sides compare against this constant.
const DASHBOARD_TIMEOUT_MESSAGE = "The worktree scan did not finish in time. This Mac may be overloaded.";
// `CMUX_COMPANION_AUTO_CLOSE_SESSIONS`. Automatic retirement is on by default;
// these three words turn the timer pass off.
const AUTO_CLOSE_OFF = new Set(["0", "off", "false"]);

export async function buildApp({
  cmux = new CmuxClient(),
  token,
  frontendUpstream = null,
  logger = false,
  eventHub = null,
  repoCatalog = new RepoCatalog(),
  worktreeDashboard = null,
  worktreePlanner = null,
  worktreePlanStore = null,
  goalIntegrator = null,
  goalFollowups = null,
  githubReviewToken = null,
  goalMergeWatch = null,
  goalHealthSweep = null,
  goalSessionReaper = null,
  goalWatchdog = null,
  // Accepted but deliberately unused: see the header of cmux-groups.mjs for why
  // cmux workspace grouping is inert. The option stays in the signature so
  // grouping can be restored, and injected, without another API change here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cmuxGroups = null,
  githubIssuePlanner = null,
  githubIssueSync = null,
  githubIssueSyncScheduler = null,
  plannerProgress = new PlannerProgress(),
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
  dashboardTimeoutMs = Number(process.env.CMUX_COMPANION_DASHBOARD_TIMEOUT_MS) || 45_000,
} = {}) {
  if (!token) throw new Error("A companion pairing token is required");

  const app = Fastify({
    logger,
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 32 * 1024,
  });
  const reconnect = ccsReconnect || new CcsReconnectManager({ accountUsage });
  const hub = eventHub || new CmuxEventHub({ bin: cmux.bin, socketPassword: cmux.socketPassword });
  const worktrees = worktreeDashboard || new WorktreeDashboard({ repoCatalog, log: app.log });
  // The planner and delivery controller share one durable goal record. Tests
  // that inject a whole planner do not open the production database implicitly.
  const planStore = worktreePlanStore || (!worktreePlanner ? new WorktreePlanStore() : null);
  // One brief store for both: every agent session reads its brief from the same
  // directory, and one cleanup pass covers the whole companion.
  const briefs = new AgentBriefs();
  const planner = worktreePlanner
    || new WorktreePlanner({ worktrees, cmux, accountUsage, log: app.log, store: planStore, progress: plannerProgress, pushService, briefs });
  const integrator = goalIntegrator
    || (planStore ? new GoalIntegrator({ store: planStore, worktrees, repoCatalog, cmux, log: app.log, briefs }) : null);
  const followups = goalFollowups
    || (planStore ? new GoalFollowups({ store: planStore, cmux, log: app.log, briefs }) : null);
  // The identity a goal code review posts under. It is separate from the
  // machine's own gh credential on purpose: GitHub refuses a verdict on your
  // own pull request, and the goal pull request is opened with that credential.
  const reviewToken = githubReviewToken
    || new GitHubReviewToken({ execute: repoCatalog.execute?.bind(repoCatalog), log: app.log });
  // The watcher never runs `gh`. It reads what the dashboard already cached
  // during the one Refresh GitHub command per repository.
  const mergeWatch = goalMergeWatch
    || (planStore ? new GoalMergeWatch({ store: planStore, worktrees, log: app.log }) : null);
  // The one thing no other module does: ask cmux whether each launched task's
  // agent is still alive. It writes nothing, so a sweep can never move a goal
  // on its own.
  const health = goalHealthSweep
    || (planStore ? new GoalHealthSweep({ store: planStore, cmux, log: app.log }) : null);
  // The one writer in the supervision path. It closes a cmux session only when
  // the plan records it and its work is delivered, so it is always safe to call
  // it; the switch below is about the timer, not about the rule.
  const reaper = goalSessionReaper
    || (planStore ? new GoalSessionReaper({ store: planStore, cmux, log: app.log }) : null);
  // The kill switch. An operator who wants to keep every workspace open sets
  // it, and the supervision timer stops retiring sessions. The on-demand routes
  // stay available either way: an explicit request is the user asking, which is
  // exactly what the switch does not need to protect them from.
  const autoCloseSessions = !AUTO_CLOSE_OFF.has(String(process.env.CMUX_COMPANION_AUTO_CLOSE_SESSIONS ?? "").trim().toLowerCase());
  const issuePlanner = githubIssuePlanner
    || new GitHubIssuePlanner({ worktrees, planner, execute: repoCatalog.execute?.bind(repoCatalog), log: app.log });
  // GitHub Sync owns its own durable store. A test that injects the whole
  // service never opens the production file, exactly like the planner above.
  const issueSync = githubIssueSync
    || new GitHubIssueSync({ worktrees, planner, store: new GitHubIssueStore(), execute: repoCatalog.execute?.bind(repoCatalog), log: app.log });
  // The timer that keeps the issue column current without anyone pressing
  // GitHub Sync. The interval is read here rather than inside the class, so the
  // class stays purely injected and a test never depends on the environment.
  const issueSyncScheduler = githubIssueSyncScheduler
    || new GitHubIssueSyncScheduler({
      sync: issueSync,
      log: app.log,
      ...(Number(process.env.CMUX_COMPANION_GITHUB_ISSUE_SYNC_INTERVAL_MS) > 0
        ? { intervalMs: Number(process.env.CMUX_COMPANION_GITHUB_ISSUE_SYNC_INTERVAL_MS) }
        : {}),
    });
  const pairAttempts = new Map();
  const viewportLeases = new Map();
  let bootstrapSnapshot = null;
  let bootstrapPending = null;
  let inboxSnapshot = null;
  let inboxPending = null;
  // A background launch creates the worktrees after its request has ended, so
  // the dashboard caches only go stale once that launch settles. The hook is
  // assigned rather than passed to the constructor, so an injected planner gets
  // it too, and it is declared here because it closes over the caches above.
  planner.onLaunchSettled = () => {
    bootstrapSnapshot = null;
    worktrees.invalidate();
  };
  // The sweep answers when asked. This asks, on a timer, and pushes once when a
  // goal's health gets worse — so a dead agent reaches the user instead of
  // waiting to be noticed. It moves no goal: every recovery stays explicit.
  const watchdog = goalWatchdog
    || (health ? new GoalWatchdog({ health, pushService, mergeWatch, worktrees, sessionReaper: autoCloseSessions ? reaper : null, log: app.log }) : null);
  const detachWatchdog = watchdog?.start() || null;
  const detachIssueSyncScheduler = issueSyncScheduler?.start() || null;
  const detachPush = pushService?.attach({ hub, cmux, repoCatalog, previewManager }) || null;
  const detachQueue = promptQueue?.attach({ hub, cmux }) || null;
  // Production already keeps the event stream alive for push/queue handling.
  // A bare buildApp test should not spawn the real cmux CLI just because the
  // durable delivery controller exists.
  const detachIntegrator = integrator && (eventHub || pushService || promptQueue) ? integrator.attach({ hub }) : null;

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

    const path = request.url.split("?")[0];
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
    worktrees.invalidate();
    return result;
  });

  app.post("/api/workspaces/:id/respawn", async (request) => (
    cmux.workspaceRespawn(request.params.id, request.body?.surfaceId)
  ));

  app.post("/api/workspaces/:id/todos/:todoId/:action", async (request) => (
    cmux.todoAction(request.params.id, request.params.todoId, request.params.action)
  ));

  app.get("/api/repos", async (request) => ({ repos: await repoCatalog.list({ refresh: request.query?.refresh === "1" }) }));

  app.get("/api/worktree-dashboard", async (request, reply) => {
    const refreshGitHub = request.query?.github === "1";
    const refreshGitHubRepositoryId = refreshGitHub ? request.query?.repositoryId || null : null;
    if (refreshGitHubRepositoryId && !/^[A-Za-z0-9_-]{18}$/.test(refreshGitHubRepositoryId)) throw new TypeError("Invalid repository");
    // cmux supplies the live sessions that decorate each worktree. It is not
    // what the board is made of. A cmux call that stalls must cost the board
    // its session badges, not every repository and every goal on the page.
    const bootstrap = await withDeadline(loadBootstrap(), bootstrapTimeoutMs, "cmux did not answer in time")
      .catch((cause) => {
        app.log.warn({ err: cause }, "bootstrap timed out; serving the dashboard without live sessions");
        return { workspaces: [] };
      });
    // The generic error handler hides the reason behind any 5xx. A scan that
    // ran out of time is the one thing the person can act on, so this route
    // sends that sentence itself instead of "Unexpected companion error".
    let dashboard;
    try {
      dashboard = await withDeadline(worktrees.snapshot({
        workspaces: bootstrap.workspaces,
        refresh: request.query?.refresh === "1",
        refreshGitHub,
        ...(refreshGitHubRepositoryId ? { refreshGitHubRepositoryId } : {}),
      }), dashboardTimeoutMs, DASHBOARD_TIMEOUT_MESSAGE);
    } catch (cause) {
      if (cause?.message !== DASHBOARD_TIMEOUT_MESSAGE) throw cause;
      app.log.warn({ err: cause }, "worktree scan timed out");
      return reply.code(503).send({ error: DASHBOARD_TIMEOUT_MESSAGE, code: "DASHBOARD_TIMEOUT" });
    }
    if (refreshGitHub && pushService?.inspectPullRequests) {
      try { await pushService.inspectPullRequests(dashboard); }
      catch (cause) { app.log.warn({ err: cause }, "manual PR notification inspection failed"); }
    }
    // Only an explicit refresh reconciles the board, and only after the
    // snapshot succeeded, so the lifecycle is written before the client asks
    // for the refreshed goal list. A failure here still returns the dashboard.
    if (refreshGitHub && mergeWatch?.reconcile) {
      try { await mergeWatch.reconcile(); }
      catch (cause) { app.log.warn({ err: cause }, "goal merge reconciliation failed"); }
    }
    return dashboard;
  });

  app.post("/api/worktree-dashboard/repositories/:id/worktrees", async (request, reply) => {
    const created = await worktrees.create(request.params.id, request.body || {});
    return reply.code(201).send(created);
  });

  app.post("/api/worktree-dashboard/:id/launch", async (request, reply) => {
    const target = await worktrees.resolve(request.params.id);
    const { agent = "codex", prompt = "", title } = request.body || {};
    const created = await cmux.workspaceCreate({
      cwd: target.path,
      title: typeof title === "string" && title.trim() ? title : `${target.repoName}: ${target.branch}`,
      agent,
      prompt,
    });
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return reply.code(201).send({
      workspace: created,
      worktree: { id: target.id, repoId: target.repoId, branch: target.branch, path: target.path },
    });
  });

  app.delete("/api/worktree-dashboard/:id", async (request) => {
    const bootstrap = await loadBootstrap();
    return worktrees.remove(request.params.id, {
      workspaces: bootstrap.workspaces,
      discardChanges: request.query?.discardChanges === "1",
    });
  });

  app.post("/api/worktree-dashboard/repositories/:id/remove-clean", async (request) => {
    const bootstrap = await loadBootstrap();
    return worktrees.removeCleanWorktrees(request.params.id, { workspaces: bootstrap.workspaces });
  });

  app.patch("/api/worktree-dashboard/repositories/:id/archive", async (request) => {
    const bootstrap = await loadBootstrap();
    return worktrees.setRepositoryArchived(request.params.id, request.body?.archived, { workspaces: bootstrap.workspaces });
  });

  app.patch("/api/worktree-dashboard/repositories/:id/favorite", async (request) => {
    const bootstrap = await loadBootstrap();
    return worktrees.setRepositoryFavorite(request.params.id, request.body?.favorite, { workspaces: bootstrap.workspaces });
  });

  // A round says nothing for minutes. This carries its live steps to the sheet
  // that started it, keyed by a trace id the client made before it posted.
  const progressReporter = (traceId) => (
    TRACE_ID.test(String(traceId || "")) ? (event) => plannerProgress.publish(traceId, event) : null
  );

  async function reportRound(traceId, run) {
    try {
      const draft = await run(progressReporter(traceId));
      plannerProgress.publish(traceId, { k: "done" });
      return draft;
    } catch (cause) {
      plannerProgress.publish(traceId, { k: "error" });
      throw cause;
    }
  }

  // A background round answers as soon as the plan row exists, so the sheet is
  // free to close and the next goal can start at once. The round then streams on
  // its own plan id. The synchronous path stays for callers that want the round.
  app.post("/api/worktree-plans", async (request, reply) => {
    const goal = { repositoryId: request.body?.repositoryId, goal: request.body?.goal, images: request.body?.images, engine: request.body?.engine, specOptions: request.body?.specOptions, reviewOptions: request.body?.reviewOptions };
    // A disabled checkbox is a courtesy. This is the enforcement: a review the
    // companion cannot post is refused now, not silently skipped later on a
    // goal the user believed was being reviewed.
    if (normalizeReviewOptions(goal.reviewOptions).codeReview && !reviewToken.status().configured) {
      throw new TypeError("Add a GitHub review token in Settings before asking for a code review");
    }
    if (request.body?.background === true) return reply.code(202).send(await planner.startBackground(goal));
    return reply.code(201).send(await reportRound(request.body?.traceId, (onEvent) => planner.start({ ...goal, onEvent })));
  });

  app.post("/api/worktree-plans/:planId/answers", async (request, reply) => {
    const submitted = { answers: request.body?.answers, skip: request.body?.skip === true };
    if (request.body?.background === true) return reply.code(202).send(await planner.answerBackground(request.params.planId, submitted));
    return reportRound(request.body?.traceId, (onEvent) => planner.answer(request.params.planId, { ...submitted, onEvent }));
  });

  // The reviewer rejected the split. This is a fresh planner round on the same
  // plan, so it takes the same body limit as a PATCH: the prompt it builds
  // quotes every rejected task back to the model.
  app.post("/api/worktree-plans/:planId/feedback", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const submitted = { text: request.body?.text };
    if (request.body?.background === true) return reply.code(202).send(await planner.feedbackBackground(request.params.planId, submitted));
    return reportRound(request.body?.traceId, (onEvent) => planner.feedback(request.params.planId, { ...submitted, onEvent }));
  });

  // Every round this process owns, so the dashboard can badge a running goal
  // without opening its sheet.
  app.get("/api/worktree-plans/runs", async () => planner.activeRuns());

  // A companion restart kills the ccs child mid-round and leaves the plan at
  // round zero. This starts its opening round again.
  app.post("/api/worktree-plans/:planId/run", async (request, reply) => (
    reply.code(202).send(await planner.run(request.params.planId))
  ));

  // EventSource cannot set an Authorization header, but it does send cookies,
  // and the onRequest hook already accepts the cmux_session cookie for /api/.
  app.get("/api/worktree-plans/progress/:traceId", (request, reply) => {
    const traceId = String(request.params.traceId || "");
    if (!TRACE_ID.test(traceId)) throw new TypeError("Invalid progress id");
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();
    const write = (event) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
    const detach = plannerProgress.subscribe(traceId, write);
    // The stream sits silent through the six seconds of ccs startup, so a
    // comment line keeps an idle intermediary from closing it.
    const beat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n"); }, 15_000);
    beat.unref?.();
    reply.raw.on("close", () => { clearInterval(beat); detach(); });
  });

  // Every saved plan, newest first. The list carries no prompt, so the sheet
  // can show a history without loading each task body.
  // `health=1` asks cmux whether each launched goal's agents are still alive,
  // so the board can put a goal whose agents all died in Blocked instead of
  // reporting it as progressing. It costs one cmux call, so the board asks for
  // it and a cheap poll does not.
  app.get("/api/worktree-plans", async (request) => planner.list({
    repositoryId: request.query?.repositoryId || null,
    status: request.query?.status || null,
    limit: request.query?.limit,
  }, { health: request.query?.health === "1" ? health : null }));

  app.get("/api/worktree-plans/:planId", async (request) => planner.detail(request.params.planId));

  // Reload a plan into the live planner, so the next answer resumes the same
  // ccs session instead of starting the goal again.
  app.post("/api/worktree-plans/:planId/resume", async (request) => planner.resume(request.params.planId));

  app.delete("/api/worktree-plans/:planId", async (request) => planner.remove(request.params.planId));

  // A full plan is 8 tasks with prompts of up to 4,000 characters each, which
  // measures about 33KB and so exceeds the global 32KB limit.
  app.patch("/api/worktree-plans/:planId", { bodyLimit: 64 * 1024 }, async (request) => (
    planner.update(request.params.planId, { tasks: request.body?.tasks })
  ));

  // A launch creates a worktree and a cmux session per task, which takes long
  // enough that the sheet used to sit on a blocking screen. The background
  // branch answers 202 as soon as the launch is registered and reports the
  // outcome by push notification. The caches are invalidated by the settled
  // hook above, because nothing exists to invalidate when the 202 is sent.
  app.post("/api/worktree-plans/:planId/launch", async (request, reply) => {
    if (request.body?.background === true) return reply.code(202).send(await planner.launchBackground(request.params.planId));
    const result = await planner.launch(request.params.planId);
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  // Abort is terminal and idempotent. The integrator drops its scheduled work
  // first, so no timer can create a session between the two calls.
  app.post("/api/worktree-plans/:planId/abort", async (request) => {
    try { integrator?.cancel?.(request.params.planId); }
    catch (cause) { app.log.warn({ err: cause, planId: request.params.planId }, "cancelling scheduled goal work failed"); }
    const result = await planner.abort(request.params.planId);
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  // Check every launched goal at once: the answer to "is this dev still
  // running, or did it die an hour ago". Read-only by design.
  // Which provider takes the next task, and what would change that answer. The
  // dispatcher has always known this; nothing showed it.
  app.get("/api/goals/capacity", async (request) => (
    agentCapacity(await accountUsage.snapshot({ refresh: request.query?.refresh === "1" }))
  ));

  app.get("/api/goals/health", async () => {
    if (!health) throw serviceUnavailable("Goal supervision is unavailable");
    return health.sweep();
  });

  // The same pass the watchdog runs on its timer, forced. "Check all devs":
  // one action that inspects every launched goal and reports what it found.
  // "Is this actually merged?" answered for one goal, on demand. The board's own
  // reconciliation runs on the watchdog timer and on a manual GitHub refresh,
  // which leaves a gap the user can see: a goal they know is merged still says
  // Waiting for merge until the next pass. This closes that gap per card.
  app.post("/api/worktree-plans/:planId/check-merge", async (request) => {
    if (!mergeWatch) throw serviceUnavailable("Goal pull-request tracking is unavailable");
    const planId = String(request.params.planId || "");
    const before = planStore?.get(planId);
    if (!before) throw new TypeError("Unknown plan. Start a new goal");
    // The watcher reads what the dashboard cached, so GitHub is refreshed for
    // this goal's repository first. Without it the check would report the state
    // of the last refresh rather than the state now.
    await worktrees.snapshot({ refresh: true, refreshGitHub: true, refreshGitHubRepositoryId: before.repositoryId });
    const { recorded } = await mergeWatch.reconcile();
    const change = recorded.find((entry) => entry.planId === planId) || null;
    const after = planStore.get(planId);
    bootstrapSnapshot = null;
    return {
      planId,
      changed: Boolean(change),
      state: after?.boardPrState || null,
      boardStatus: after?.boardStatus || null,
      pullRequest: change ? { number: change.number, url: change.url } : (after?.boardPrUrl ? { number: after.boardPrNumber, url: after.boardPrUrl } : null),
      // A goal whose branch GitHub has never seen is the common surprise: the
      // agent never pushed, or it opened its pull request from another branch.
      checked: true,
    };
  });

  app.post("/api/worktree-plans/:planId/followups", async (request) => {
    if (!followups) throw serviceUnavailable("Goal follow-ups are unavailable");
    const result = await followups.launch(request.params.planId, request.body);
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  app.post("/api/goals/health/check", async () => {
    if (!watchdog) throw serviceUnavailable("Goal supervision is unavailable");
    return watchdog.check();
  });

  // The same retirement pass the watchdog runs on its timer, forced. "Close the
  // sessions that are finished": one action, and it reports every session it
  // closed, kept and failed to close, so a kept session can always be explained.
  app.post("/api/goals/sessions/reap", async (request) => {
    if (!reaper) throw serviceUnavailable("Goal session retirement is unavailable");
    const planId = readPlanId(request.body?.planId);
    const report = await reaper.reap(planId ? { planId } : {});
    // Closing a session changes what the board and the sidebar show, so the
    // cached snapshots are dropped rather than served stale.
    if (report.closed.length) {
      bootstrapSnapshot = null;
      worktrees.invalidate();
    }
    return report;
  });

  // What the pass would close, without closing it. The UI shows this before it
  // asks the user to act, so nobody has to run the real pass to find out.
  app.get("/api/goals/sessions/retirable", async (request) => {
    if (!reaper) throw serviceUnavailable("Goal session retirement is unavailable");
    const planId = readPlanId(request.query?.planId);
    return dryRun(reaper).reap(planId ? { planId } : {});
  });

  app.get("/api/worktree-plans/:planId/health", async (request) => {
    if (!health) throw serviceUnavailable("Goal supervision is unavailable");
    return health.inspect(request.params.planId);
  });

  // Start one task again on a plan that is already launched. `continue` keeps
  // the worktree and its work; `restart` discards both and rebuilds from base.
  app.post("/api/worktree-plans/:planId/tasks/:taskId/relaunch", async (request) => {
    const result = await planner.relaunchTask(request.params.planId, request.params.taskId, {
      mode: request.body?.mode || "continue",
      closeLive: request.body?.closeLive === true,
    });
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  // Drop one task, so a single dead task stops blocking every other task's
  // finished work from reaching a pull request.
  app.post("/api/worktree-plans/:planId/tasks/:taskId/skip", async (request) => {
    const result = await planner.skipTask(request.params.planId, request.params.taskId, { reason: request.body?.reason || null });
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  app.post("/api/worktree-plans/:planId/assemble", async (request) => {
    if (!integrator) throw serviceUnavailable("Combined goal delivery is unavailable");
    const result = await integrator.assemble(request.params.planId);
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  app.post("/api/github-topic-plans/analyze", async (request) => (
    reportRound(request.body?.traceId, (onEvent) => issuePlanner.analyze({
      repositoryId: request.body?.repositoryId,
      ...(onEvent ? { onEvent } : {}),
    }))
  ));

  app.post("/api/github-topic-plans/prepare", { bodyLimit: 64 * 1024 }, async (request) => (
    reportRound(request.body?.traceId, (onEvent) => issuePlanner.prepare({
      analysisId: request.body?.analysisId,
      topics: request.body?.topics,
      ...(onEvent ? { onEvent } : {}),
    }))
  ));

  app.post("/api/github-topic-plans/launch", async (request) => {
    const result = await reportRound(request.body?.traceId, (onEvent) => issuePlanner.launch({
      planIds: request.body?.planIds,
      ...(onEvent ? { onEvent } : {}),
    }));
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

  // GitHub Sync. The board reads the stored column here, so a reload shows the
  // last sync without touching GitHub again.
  app.get("/api/github-issues", async () => issueSync.read());

  // Delegated to the scheduler so a manual press and a scheduled pass share one
  // in-flight guard. The response is whatever GitHubIssueSync.sync() returns,
  // unchanged: a caller that joins a running pass gets that pass's own result.
  app.post("/api/github-issues/sync", async () => (
    issueSyncScheduler ? issueSyncScheduler.syncNow() : issueSync.sync()
  ));

  // One issue becomes one goal plan. The plan then appears in Writing Spec
  // like every other draft, so the caches that feed the board are dropped.
  app.post("/api/github-issues/:repositoryId/:number/goal", async (request) => {
    const repositoryId = String(request.params.repositoryId || "");
    const number = Number(request.params.number);
    if (!/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    if (!Number.isInteger(number) || number <= 0) throw new TypeError("Invalid issue number");
    const result = await issueSync.startGoal({ repositoryId, number });
    bootstrapSnapshot = null;
    worktrees.invalidate();
    return result;
  });

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

  app.get("/api/inbox", loadInbox);

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

  // The token itself is never returned. `status()` omits it by construction,
  // so no future edit here can leak it by spreading that object.
  app.get("/api/github/review-token", async () => reviewToken.status());

  app.post("/api/github/review-token", async (request) => reviewToken.save(request.body?.token));

  app.delete("/api/github/review-token", async () => reviewToken.clear());

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

  app.post("/api/terminals/:id/input", async (request) => {
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

  app.post("/api/prompt-queue", async (request, reply) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    const payload = await cmux.workspaceListDetailed?.() || await cmux.workspaceList();
    const workspace = (payload.workspaces || []).find((item) => item.id === request.body?.workspaceId);
    const terminal = workspace?.terminals?.find((item) => item.id === request.body?.surfaceId);
    if (!workspace || !terminal) throw new TypeError("Unknown cmux terminal");
    return reply.code(201).send(promptQueue.enqueue({ workspaceId: workspace.id, surfaceId: terminal.id, text: request.body?.text }));
  });

  app.patch("/api/prompt-queue/:id", async (request) => {
    if (!promptQueue) throw serviceUnavailable("Prompt queue is unavailable");
    return promptQueue.update(request.params.id, request.body);
  });

  app.post("/api/prompt-queue/:id/move", async (request) => {
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
    detachIntegrator?.();
    detachWatchdog?.();
    detachIssueSyncScheduler?.();
    hub.stop();
    if (!worktreePlanStore && planStore) planStore.close();
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
function readPlanId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Invalid plan id");
  return value.trim();
}

// The dry run. It is the real reaper, over a store that records nothing and a
// cmux that closes nothing, so the answer comes from the one policy rather than
// from a second copy of it that could drift away from what really happens.
//
// The two adapters forward only the reads. Wrapping the objects themselves
// would carry every other method along, and one of them closing a session is
// exactly what a dry run must not be able to do.
function dryRun(reaper) {
  const store = {
    list: (options) => reaper.store.list(options),
    get: (planId) => reaper.store.get(planId),
    recordSessionsRetired: () => {},
  };
  const cmux = reaper.cmux?.workspaceListDetailed
    ? {
      workspaceListDetailed: () => reaper.cmux.workspaceListDetailed(),
      workspaceClose: async () => ({ ok: true }),
    }
    : reaper.cmux;
  return new GoalSessionReaper({ store, cmux, log: reaper.log, enabled: reaper.enabled });
}

function serviceUnavailable(message) {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}
