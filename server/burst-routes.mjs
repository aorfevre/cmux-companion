import { BURST_ID, REPOSITORY_ID } from "./burst-contract.mjs";
import { WRITE_SCHEMAS } from "./request-schemas.mjs";

// The burst API. Every handler answers 503 when the app was built without goal
// sessions, because approval is a goal session start and nothing else.
export function registerBurstRoutes(app, { bursts, invalidate }) {
  const unavailable = () => Object.assign(new Error("Burst is unavailable"), { statusCode: 503 });
  const ids = (request) => {
    const burstId = String(request.params.burstId || "");
    const repositoryId = String(request.params.repositoryId || "");
    if (!BURST_ID.test(burstId)) throw new TypeError("Invalid burst id");
    if (!REPOSITORY_ID.test(repositoryId)) throw new TypeError("Invalid repository");
    return { burstId, repositoryId };
  };

  app.post("/api/bursts", async (_request, reply) => {
    if (!bursts) throw unavailable();
    const result = await bursts.create();
    return reply.code(result.burstId ? 201 : 200).send(result);
  });

  app.get("/api/bursts", async () => {
    if (!bursts) throw unavailable();
    return { bursts: bursts.list() };
  });

  app.get("/api/bursts/:burstId", async (request, reply) => {
    if (!bursts) throw unavailable();
    const burstId = String(request.params.burstId || "");
    const burst = BURST_ID.test(burstId) ? bursts.get(burstId) : null;
    if (!burst) return reply.code(404).send({ error: "Unknown burst", code: "NOT_FOUND" });
    return burst;
  });

  // Approval creates a goal, so the dashboard caches that list goals go stale.
  app.post("/api/bursts/:burstId/candidates/:repositoryId/approve", { schema: WRITE_SCHEMAS.burstApprove }, async (request) => {
    if (!bursts) throw unavailable();
    const { burstId, repositoryId } = ids(request);
    const candidate = await bursts.approve(burstId, repositoryId, request.body || {});
    invalidate();
    return candidate;
  });

  app.post("/api/bursts/:burstId/candidates/:repositoryId/decline", async (request) => {
    if (!bursts) throw unavailable();
    const { burstId, repositoryId } = ids(request);
    return bursts.decline(burstId, repositoryId);
  });

  app.post("/api/bursts/:burstId/candidates/:repositoryId/rescan", async (request) => {
    if (!bursts) throw unavailable();
    const { burstId, repositoryId } = ids(request);
    return bursts.rescan(burstId, repositoryId);
  });
}
