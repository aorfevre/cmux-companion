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

export function plannerReviewReady(plan) {
  if (!plan.engine?.reviewer) return true;
  const review = (Array.isArray(plan.reviews) ? plan.reviews : []).find((entry) => entry.kind === "planner" && entry.target === String(plan.proposalRevision));
  return review?.status === "completed" || (review?.status === "failed" && Boolean(review.acknowledgedAt));
}
