import { SPEC_OPTIONS } from "./worktree-planner-options.mjs";
import { REVIEW_OPTIONS } from "./review-options.mjs";

// Creation defaults are not storage recovery defaults: old opt-outs stay off.
export const NEW_GOAL_SPEC_OPTIONS = Object.freeze({ ...SPEC_OPTIONS.defaults, unitTests: true, e2eTests: true, edgeCases: true, refactorPass: true });
export const NEW_GOAL_REVIEW_OPTIONS = Object.freeze({ ...REVIEW_OPTIONS.defaults, codeReview: true });
export const NEW_GOAL_REVIEWER = true;
export const ANALYSIS_INAPPLICABLE = Object.freeze(["unitTests", "e2eTests", "refactorPass"]);

export function normalizeGoalType(value = "coding") {
  if (value !== "coding" && value !== "analysis") throw new TypeError("Goal type must be coding or analysis");
  return value;
}

export function applicableSpecOptions(type, options) {
  return type === "analysis" ? { ...options, unitTests: false, e2eTests: false, refactorPass: false } : options;
}

export function currentPlannerReview(plan) {
  return (Array.isArray(plan.reviews) ? plan.reviews : []).find((entry) => entry.kind === "planner" &&
    (entry.target === String(plan.proposalRevision) || (entry.assessment?.status === "completed" && entry.assessment.finalRevision === plan.proposalRevision)));
}

export function plannerReviewReady(plan) {
  if (!plan.engine?.reviewer) return true;
  const review = currentPlannerReview(plan);
  return review?.status === "completed" && review.assessment?.status === "completed" && review.assessment.finalRevision === plan.proposalRevision;
}

// One sentence for the state of an approval's delivery to the agent
// conversation. The card, the sheet and the sessions view all read it.
export function approvalDeliveryMessage(plan) {
  if (!plan || plan.goalSessionState !== "implementing" || plan.goalType === "analysis") return null;
  const status = plan.transitionStatus;
  if (status === "delivered") return null;
  if (status === "uncertain") return "The approval may not have reached the agent. Check the conversation in cmux, then continue there if it did not.";
  if (status === "sending") return "Approval is being sent to the agent.";
  if (status === "sent") return "Approval sent. The agent is starting the implementation.";
  if (status === "pending") return plan.approvalDelivery?.reason ? `Approval not sent yet: ${plan.approvalDelivery.reason}.` : "Approval saved. Companion is sending it to the agent.";
  return null;
}

export function plannerReviewPhase(plan) {
  const review = currentPlannerReview(plan);
  if (!review) return null;
  if (review.status !== "completed") return review.status;
  return review.assessment?.status === "completed" ? "completed" : review.assessment?.status || "pending";
}
