import { TRACE_ID } from "./planner-progress.mjs";
import { normalizeReviewOptions } from "./review-options.mjs";
import { WRITE_SCHEMAS } from "./request-schemas.mjs";

export function registerPlannerRoutes(app, { planner, plannerProgress, reviewToken, health, invalidate }) {
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
  app.post("/api/worktree-plans", { schema: WRITE_SCHEMAS.createGoal }, async (request, reply) => {
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

  // A question about the contract that is on screen. It is not a round: it
  // changes nothing, so it takes the PATCH body limit only because the prompt
  // it builds quotes the whole contract back to the model.
  app.post("/api/worktree-plans/:planId/discuss", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const submitted = { text: request.body?.text };
    if (request.body?.background === true) return reply.code(202).send(await planner.discussBackground(request.params.planId, submitted));
    return reportRound(request.body?.traceId, (onEvent) => planner.discuss(request.params.planId, { ...submitted, onEvent }));
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

  // A launch creates a worktree and a cmux session per task, which takes long
  // enough that the sheet used to sit on a blocking screen. The background
  // branch answers 202 as soon as the launch is registered and reports the
  // outcome by push notification. The caches are invalidated by the settled
  // hook above, because nothing exists to invalidate when the 202 is sent.
  app.post("/api/worktree-plans/:planId/launch", async (request, reply) => {
    if (request.body?.background === true) return reply.code(202).send(await planner.launchBackground(request.params.planId));
    const result = await planner.launch(request.params.planId);
    invalidate();
    return result;
  });

  return { reportRound };
}
