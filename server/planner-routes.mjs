import { TRACE_ID } from "./planner-progress.mjs";
import { WRITE_SCHEMAS } from "./request-schemas.mjs";

export function registerPlannerRoutes(app, { planner, goalSessions, plannerProgress, health, invalidate }) {
  // Retired round mutations must never silently invoke a headless agent.
  for (const action of ["answers", "feedback", "discuss"]) app.post(`/api/worktree-plans/:planId/${action}`, async () => {
    throw Object.assign(new Error("Continue discovery in the goal's interactive cmux conversation"), { statusCode: 410 });
  });

  // Every round this process owns, so the dashboard can badge a running goal
  // without opening its sheet.
  app.get("/api/worktree-plans/runs", async () => planner.activeRuns());

  app.post("/api/worktree-plans/:planId/run", async (request) => {
    if (!goalSessions) throw new TypeError("Interactive goal discovery is unavailable");
    const plan = await goalSessions.continueDiscovery(request.params.planId);
    invalidate();
    return plan;
  });

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
    reply.raw.flushHeaders();
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
  app.patch("/api/worktree-plans/:planId", { bodyLimit: 64 * 1024, schema: WRITE_SCHEMAS.updateGoal }, async (request) => (
    planner.update(request.params.planId, { tasks: request.body?.tasks })
  ));

  // Starting development now always follows the native proposal approval.
  app.post("/api/worktree-plans/:planId/launch", async () => {
    throw Object.assign(new Error("Continue discovery and approve its proposal in the interactive goal conversation"), { statusCode: 410 });
  });

}
