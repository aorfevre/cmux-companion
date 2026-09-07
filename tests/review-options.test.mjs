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

const DEFAULTS = { codeReview: false, reviewer: "claude", reviewerModel: "claude-fable-5-1" };

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
  assert.deepEqual(normalizeReviewOptions({ codeReview: true }), { codeReview: true, reviewer: "claude", reviewerModel: "claude-fable-5-1" });
  assert.deepEqual(normalizeReviewOptions({ reviewer: "codex" }), { codeReview: false, reviewer: "codex", reviewerModel: "gpt-5.6-sol" });
  assert.deepEqual(normalizeReviewOptions({ codeReview: true, reviewer: "codex" }), { codeReview: true, reviewer: "codex", reviewerModel: "gpt-5.6-sol" });
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
  assert.deepEqual(safeReviewOptions({ codeReview: true, reviewer: "codex" }), { codeReview: true, reviewer: "codex", reviewerModel: "gpt-5.6-sol" });
});

test("codeReviewRequested answers only for a valid enabled request", () => {
  assert.equal(codeReviewRequested({ codeReview: true }), true);
  assert.equal(codeReviewRequested({ codeReview: false }), false);
  assert.equal(codeReviewRequested(undefined), false);
  assert.equal(codeReviewRequested({ codeReview: "true" }), false);
});

test("safe custom reviewer models survive normalization", () => {
  for (const reviewerModel of ["claude-opus-5", "gpt-6-astra", "gpt-5.6-sol", "default", "provider/custom-reviewer"]) {
    const value = { ...DEFAULTS, codeReview: true, reviewerModel };
    assert.deepEqual(normalizeReviewOptions(normalizeReviewOptions(value)), value);
  }
  for (const reviewerModel of ["bad model", 42, null, {}, true]) {
    assert.throws(() => normalizeReviewOptions({ reviewerModel }), /Model must/);
    assert.deepEqual(safeReviewOptions({ codeReview: true, reviewerModel }), DEFAULTS);
    assert.equal(codeReviewRequested({ codeReview: true, reviewerModel }), true);
  }
  assert.throws(() => { REVIEW_OPTIONS.defaults.reviewerModel = "gpt-6-astra"; }, TypeError);
  assert.deepEqual(REVIEW_OPTIONS.defaults, DEFAULTS);
  assert.deepEqual(safeReviewOptions({ codeReview: false, reviewer: "claude" }), DEFAULTS);
});

test("a saved retired reviewer model is rewritten to its current id", () => {
  assert.equal(normalizeReviewOptions({ codeReview: true, reviewer: "codex", reviewerModel: "gpt-6" }).reviewerModel, "gpt-6-astra");
  assert.equal(safeReviewOptions({ codeReview: true, reviewer: "codex", reviewerModel: "gpt-6" }).reviewerModel, "gpt-6-astra");
});
