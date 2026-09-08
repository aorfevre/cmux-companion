// Seeds historical records for delivery compatibility tests. It never starts a
// planner: replies are supplied by the test's in-memory fixture executor.
import { randomUUID } from "node:crypto";
import { parsePlannerReply, assignAgents, normalizePlannerEngine } from "../../server/worktree-planner.mjs";
import { safeReviewOptions } from "../../server/review-options.mjs";
import { normalizeSpecOptions } from "../../server/spec-options.mjs";
import { validateDeliveryContract } from "../../server/delivery-contract.mjs";
export async function seedLegacyPlan(planner, options) {
  const repo = (await planner.worktrees.snapshot()).repositories.find((repo) => repo.id === options.repositoryId);
  if (!repo) throw new TypeError("Unknown repository");
  const reply = parsePlannerReply((await planner.execute("fixture", [], {})).stdout);
  const spec = reply.legacy ? { ...reply.spec, outcome: options.goal } : reply.spec;
  const readiness = reply.status === "ready" ? validateDeliveryContract(spec, reply.tasks, options.specOptions) : null;
  const tasks = assignAgents(reply.tasks.map((task) => ({ ...task, wave: readiness?.waves.findIndex((wave) => wave.includes(task.id)) || 0 })), await planner.accountUsage?.snapshot());
  const draft = { ...options, planId: randomUUID(), repositoryName: repo.name, cwd: repo.path, images: options.images || [], issueNumbers: options.issueNumbers || [], issueUrls: options.issueUrls || [], deliveryPolicy: options.deliveryPolicy || "auto", engine: normalizePlannerEngine(options.engine, planner.modelSettings.roles), specOptions: normalizeSpecOptions(options.specOptions), reviewOptions: safeReviewOptions(options.reviewOptions), sessionId: reply.sessionId, round: 1, at: Date.now(), status: reply.status, questions: reply.questions, tasks, spec, readiness };
  planner.store?.createPlan(draft);
  planner.store?.recordRound(draft.planId, { round: 1, stage: reply.status, sessionId: reply.sessionId, questions: reply.questions, tasks, spec, readiness });
  planner.drafts.set(draft.planId, draft);
  return { ...draft, deliveryMode: draft.deliveryPolicy === "combined" || tasks.length > 1 ? "combined" : "single" };
}
