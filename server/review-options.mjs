// The post-delivery review request the user makes on the Plan a goal sheet.
//
// This is deliberately NOT part of SPEC_OPTIONS. The six spec options are
// promises the planner must evidence inside the delivery contract, and
// specOptionCoverage marks a requested option "missing" when no task and no
// acceptance criterion carry it. A code review happens after every task is
// finished and merged, so the planner can never evidence it. Routing it
// through optionEvidence would stamp a permanent false warning on every goal
// that asked for one.
//
// The module is data-only and has no storage, no network and no Node
// built-ins, because both the browser sheet and the server import it.

import { DEFAULT_MODEL_ROLES, currentModelId, normalizeModelId } from "./model-options.mjs";

export const REVIEW_AGENTS = Object.freeze(["claude", "codex"]);
export const DEFAULT_REVIEW_AGENT = "claude";

export const REVIEW_OPTIONS = Object.freeze({
  label: "Code review",
  hint: "After the pull request is created, a separate agent reviews the delivered goal and posts its findings on GitHub.",
  defaults: Object.freeze({
    codeReview: false,
    reviewer: DEFAULT_REVIEW_AGENT,
    reviewerModel: DEFAULT_MODEL_ROLES.codeReviewer.models.claude,
  }),
});

const KEYS = Object.freeze(Object.keys(REVIEW_OPTIONS.defaults));

// Strict for the same reason normalizeSpecOptions is strict: a silently
// dropped key would let the sheet promise a review that never runs.
export function normalizeReviewOptions(value, roles = DEFAULT_MODEL_ROLES) {
  if (value === undefined || value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Review options must be an object");
  const normalized = { ...REVIEW_OPTIONS.defaults };
  for (const [key, entry] of Object.entries(value)) {
    if (!KEYS.includes(key)) throw new TypeError(`Unknown review option ${key}`);
    if (key === "reviewerModel") {
      normalized.reviewerModel = normalizeModelId(currentModelId(entry));
      continue;
    }
    if (key === "reviewer") {
      if (typeof entry !== "string" || !REVIEW_AGENTS.includes(entry)) {
        throw new TypeError("Review option reviewer must be claude or codex");
      }
      normalized.reviewer = entry;
      continue;
    }
    if (typeof entry !== "boolean") throw new TypeError(`Review option ${key} must be true or false`);
    normalized[key] = entry;
  }
  if (value.reviewerModel === undefined) normalized.reviewerModel = roles.codeReviewer.models[normalized.reviewer];
  return normalized;
}

// A stored value that predates this feature, or one a hand-edited database
// corrupted, reads as "no review" rather than breaking the plan it belongs to.
export function safeReviewOptions(value) {
  try {
    return normalizeReviewOptions(value ?? undefined);
  } catch {
    return { ...REVIEW_OPTIONS.defaults };
  }
}

export function codeReviewRequested(value) {
  // Whether review was requested is independent of the chosen model.
  const request = value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, reviewerModel: REVIEW_OPTIONS.defaults.reviewerModel }
    : value;
  return safeReviewOptions(request).codeReview === true;
}
