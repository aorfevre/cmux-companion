import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_BOARD_COLUMNS, goalBoardState, groupGoalsByBoardState } from "../server/goal-board.mjs";

const SUMMARY = { planId: "plan-1", repositoryId: "repo-1", goal: "Ship the board", status: "draft", stage: "questions", round: 1 };
const LAUNCHED = { ...SUMMARY, planId: "plan-2", status: "launched", stage: "ready", deliveryStatus: "implementing" };

test("exports the eight ordered columns with labels and descriptions", () => {
  assert.deepEqual(GOAL_BOARD_COLUMNS.map((column) => column.id), [
    "writing_spec", "review_spec", "waiting_for_dev", "dev_in_progress", "waiting_for_merge", "blocked", "merged", "aborted",
  ]);
  assert.deepEqual(GOAL_BOARD_COLUMNS.map((column) => column.label), [
    "Writing Spec", "Review Spec", "Waiting for dev", "Dev in progress", "Waiting for merge", "Blocked", "Merged", "Aborted",
  ]);
  assert.equal(GOAL_BOARD_COLUMNS.every((column) => typeof column.description === "string" && column.description.length > 0), true);
  assert.equal(Object.isFrozen(GOAL_BOARD_COLUMNS), true);
  assert.equal(Object.isFrozen(GOAL_BOARD_COLUMNS[0]), true);
});

test("maps drafts to writing spec while the planner works", () => {
  assert.equal(goalBoardState(SUMMARY), "writing_spec");
  assert.equal(goalBoardState({ ...SUMMARY, running: true }), "writing_spec");
  assert.equal(goalBoardState({ ...SUMMARY, round: 0, stage: "ready" }), "writing_spec");
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready", running: true }), "writing_spec");
});

test("uses the structured run stage for the reviewer pass", () => {
  assert.equal(goalBoardState({ ...SUMMARY, running: true, runStage: "review_spec" }), "review_spec");
  // A display line must never move a card.
  assert.equal(goalBoardState({ ...SUMMARY, running: true, runStep: "Review Spec pass 2" }), "writing_spec");
  // A finished reviewer run is no longer in review.
  assert.equal(goalBoardState({ ...SUMMARY, running: false, runStage: "review_spec", stage: "ready" }), "waiting_for_dev");
});

test("maps an idle ready draft to waiting for dev", () => {
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready" }), "waiting_for_dev");
  // A detail keeps the stage in `status` next to `planStatus`.
  assert.equal(goalBoardState({ planId: "plan-3", planStatus: "draft", status: "ready", round: 2 }), "waiting_for_dev");
  assert.equal(goalBoardState({ planId: "plan-4", planStatus: "draft", status: "questions", round: 2 }), "writing_spec");
});

test("maps launched plans without a pull request to dev in progress", () => {
  assert.equal(goalBoardState(LAUNCHED), "dev_in_progress");
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "planning" }), "dev_in_progress");
  assert.equal(goalBoardState({ planId: "plan-5", planStatus: "launched", status: "ready", round: 1 }), "dev_in_progress");
});

test("maps assembling and open pull requests to waiting for merge", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "assembling" }), "waiting_for_merge");
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "OPEN" }), "waiting_for_merge");
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "pr_open" }), "waiting_for_merge");
  assert.equal(goalBoardState({ ...LAUNCHED, finalPrUrl: "https://github.test/pr/42" }), "waiting_for_merge");
});

// A blocked delivery is the state that most needs a person. Hidden inside
// "Waiting for merge" it looked exactly like work that was progressing.
test("gives a blocked delivery its own column", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "blocked" }), "blocked");
  // A goal whose every agent died is not in progress either. Only the health
  // sweep can know that, so it arrives as a verdict on the payload.
  assert.equal(goalBoardState({ ...LAUNCHED, health: "dead" }), "blocked");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "idle" }), "blocked");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "failed" }), "blocked");
  // A live agent, and a goal that already produced a pull request, both
  // outrank a health verdict.
  assert.equal(goalBoardState({ ...LAUNCHED, health: "working" }), "dev_in_progress");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "needs_you" }), "dev_in_progress");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "dead", boardPrState: "OPEN" }), "waiting_for_merge");
  // A payload with no verdict keeps the derivation it always had.
  assert.equal(goalBoardState(LAUNCHED), "dev_in_progress");
  // And a terminal outcome still wins over everything.
  assert.equal(goalBoardState({ ...LAUNCHED, health: "dead", boardStatus: "merged" }), "merged");
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "blocked", boardStatus: "aborted" }), "aborted");
});

test("treats a closed pull request as development again", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "CLOSED", deliveryStatus: "pr_open" }), "dev_in_progress");
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "CLOSED", finalPrUrl: "https://github.test/pr/42" }), "dev_in_progress");
  // An open pull request still wins over a stale blocked status.
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "OPEN", deliveryStatus: "blocked" }), "waiting_for_merge");
});

test("maps merged pull requests and merged board status to merged", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "MERGED" }), "merged");
  assert.equal(goalBoardState({ ...LAUNCHED, boardStatus: "merged" }), "merged");
  // A merged pull request beats every delivery signal below it.
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "MERGED", deliveryStatus: "blocked" }), "merged");
  // A merged goal that was still a draft is merged too.
  assert.equal(goalBoardState({ ...SUMMARY, boardStatus: "merged" }), "merged");
});

test("gives aborted terminal precedence over merge evidence", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, boardStatus: "aborted", boardPrState: "MERGED", finalPrUrl: "https://github.test/pr/42" }), "aborted");
  assert.equal(goalBoardState({ ...SUMMARY, boardStatus: "aborted", running: true, runStage: "review_spec" }), "aborted");
});

test("never throws for missing or malformed optional fields", () => {
  for (const input of [null, undefined, 0, "plan", [], [{ status: "launched" }], {}, { status: 7, stage: [], round: "many" }]) {
    assert.equal(goalBoardState(input), "writing_spec");
  }
  assert.equal(goalBoardState({ status: "launched", boardPrState: { state: "OPEN" }, finalPrUrl: 12, deliveryStatus: null }), "dev_in_progress");
  assert.equal(goalBoardState({ status: "launched", boardPrState: "open" }), "waiting_for_merge");
  assert.equal(goalBoardState({ status: "launched", boardStatus: " aborted " }), "aborted");
});

test("groups goals into every column, including the empty ones", () => {
  const empty = groupGoalsByBoardState([]);
  assert.deepEqual(Object.keys(empty), GOAL_BOARD_COLUMNS.map((column) => column.id));
  assert.equal(Object.values(empty).every((value) => Array.isArray(value) && value.length === 0), true);

  const plans = [
    SUMMARY,
    { ...SUMMARY, planId: "plan-review", running: true, runStage: "review_spec" },
    { ...SUMMARY, planId: "plan-ready", stage: "ready" },
    LAUNCHED,
    { ...LAUNCHED, planId: "plan-open", boardPrState: "OPEN" },
    { ...LAUNCHED, planId: "plan-merged", boardPrState: "MERGED" },
    { ...LAUNCHED, planId: "plan-aborted", boardStatus: "aborted" },
    { ...LAUNCHED, planId: "plan-blocked", deliveryStatus: "blocked" },
    { ...LAUNCHED, planId: "plan-dead", health: "dead" },
  ];
  const grouped = groupGoalsByBoardState(plans);
  assert.deepEqual(Object.fromEntries(Object.entries(grouped).map(([id, list]) => [id, list.map((plan) => plan.planId)])), {
    writing_spec: ["plan-1"],
    review_spec: ["plan-review"],
    waiting_for_dev: ["plan-ready"],
    dev_in_progress: ["plan-2"],
    waiting_for_merge: ["plan-open"],
    blocked: ["plan-blocked", "plan-dead"],
    merged: ["plan-merged"],
    aborted: ["plan-aborted"],
  });
  assert.deepEqual(groupGoalsByBoardState(null), empty);
});
