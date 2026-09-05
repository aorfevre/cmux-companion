import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REVIEW_AGENT,
  REVIEW_AGENTS,
  REVIEW_OPTIONS,
  codeReviewRequested,
  normalizeReviewOptions,
  safeReviewOptions,
} from "../server/review-options.mjs";

const DEFAULTS = { codeReview: false, reviewer: "claude" };

test("the catalog is frozen data with a usable label and hint", () => {
  assert.deepEqual({ ...REVIEW_OPTIONS.defaults }, DEFAULTS);
  assert.ok(Object.isFrozen(REVIEW_OPTIONS));
  assert.ok(Object.isFrozen(REVIEW_OPTIONS.defaults));
  assert.ok(REVIEW_OPTIONS.label);
  assert.ok(REVIEW_OPTIONS.hint);
  assert.deepEqual([...REVIEW_AGENTS], ["claude", "codex"]);
  assert.equal(DEFAULT_REVIEW_AGENT, "claude");
});

test("missing input normalizes to a fresh all-off object", () => {
  assert.deepEqual(normalizeReviewOptions(undefined), DEFAULTS);
  assert.deepEqual(normalizeReviewOptions(null), DEFAULTS);
  // A fresh object every time, so a caller cannot mutate the shared default.
  const first = normalizeReviewOptions();
  first.codeReview = true;
  assert.deepEqual(normalizeReviewOptions(), DEFAULTS);
  assert.notEqual(normalizeReviewOptions(), REVIEW_OPTIONS.defaults);
});

test("a partial object keeps the defaults for what it omits", () => {
  assert.deepEqual(normalizeReviewOptions({ codeReview: true }), { codeReview: true, reviewer: "claude" });
  assert.deepEqual(normalizeReviewOptions({ reviewer: "codex" }), { codeReview: false, reviewer: "codex" });
  assert.deepEqual(normalizeReviewOptions({ codeReview: true, reviewer: "codex" }), { codeReview: true, reviewer: "codex" });
});

test("malformed input throws an actionable TypeError", () => {
  assert.throws(() => normalizeReviewOptions([]), /Review options must be an object/);
  assert.throws(() => normalizeReviewOptions("codeReview"), /Review options must be an object/);
  assert.throws(() => normalizeReviewOptions(7), /Review options must be an object/);
  assert.throws(() => normalizeReviewOptions({ codeReviews: true }), /Unknown review option codeReviews/);
  assert.throws(() => normalizeReviewOptions({ codeReview: "true" }), /Review option codeReview must be true or false/);
  assert.throws(() => normalizeReviewOptions({ reviewer: "gemini" }), /reviewer must be claude or codex/);
  assert.throws(() => normalizeReviewOptions({ reviewer: true }), /reviewer must be claude or codex/);
});

test("a stored value that predates the feature reads as no review", () => {
  // safeReviewOptions is what the store uses, so a legacy row or a hand-edited
  // database degrades to "no review" instead of breaking the plan it belongs to.
  assert.deepEqual(safeReviewOptions(undefined), DEFAULTS);
  assert.deepEqual(safeReviewOptions(null), DEFAULTS);
  assert.deepEqual(safeReviewOptions({}), DEFAULTS);
  assert.deepEqual(safeReviewOptions([]), DEFAULTS);
  assert.deepEqual(safeReviewOptions({ codeReview: "yes", reviewer: "gemini" }), DEFAULTS);
  assert.deepEqual(safeReviewOptions({ codeReview: true, reviewer: "codex" }), { codeReview: true, reviewer: "codex" });
});

test("codeReviewRequested answers only for a valid enabled request", () => {
  assert.equal(codeReviewRequested({ codeReview: true }), true);
  assert.equal(codeReviewRequested({ codeReview: false }), false);
  assert.equal(codeReviewRequested(undefined), false);
  assert.equal(codeReviewRequested({ codeReview: "true" }), false);
});
