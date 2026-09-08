import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_BOARD_COLUMNS, goalBoardState, groupGoalsByBoardState } from "../server/goal-board.mjs";

const SUMMARY = { planId: "plan-1", repositoryId: "repo-1", goal: "Ship the board", status: "draft", stage: "questions", round: 1 };
const LAUNCHED = { ...SUMMARY, planId: "plan-2", status: "launched", stage: "ready", deliveryStatus: "implementing" };

test("exports the nine ordered columns, each named for who acts", () => {
  assert.deepEqual(GOAL_BOARD_COLUMNS.map((column) => column.id), [
    "discovering", "needs_you", "building", "analysis_in_progress", "analysis_ready", "in_review", "stopped", "shipped", "aborted",
  ]);
  assert.deepEqual(GOAL_BOARD_COLUMNS.map((column) => column.label), [
    "Discovering", "Needs you", "Building", "Analysis in progress", "Analysis ready", "In review", "Stopped", "Shipped", "Aborted",
  ]);
  assert.equal(GOAL_BOARD_COLUMNS.every((column) => typeof column.description === "string" && column.description.length > 0), true);
  assert.deepEqual(GOAL_BOARD_COLUMNS.filter((column) => column.collapsedByDefault).map((column) => column.id), ["stopped", "shipped", "aborted"]);
  assert.equal(Object.isFrozen(GOAL_BOARD_COLUMNS), true);
  assert.equal(GOAL_BOARD_COLUMNS.every((column) => Object.isFrozen(column)), true);
});

test("maps drafts to discovering while the planner works", () => {
  assert.equal(goalBoardState(SUMMARY), "discovering");
  assert.equal(goalBoardState({ ...SUMMARY, running: true }), "discovering");
  assert.equal(goalBoardState({ ...SUMMARY, round: 0, stage: "ready" }), "discovering");
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready", running: true }), "discovering");
});

test("a legacy reviewer pass is still discovery", () => {
  assert.equal(goalBoardState({ ...SUMMARY, running: true, runStage: "review_spec" }), "discovering");
  // A display line must never move a card.
  assert.equal(goalBoardState({ ...SUMMARY, running: true, runStep: "Review Spec pass 2" }), "discovering");
  // A finished reviewer run on a ready contract waits on the person.
  assert.equal(goalBoardState({ ...SUMMARY, running: false, runStage: "review_spec", stage: "ready" }), "needs_you");
});

test("maps an idle ready draft to needs you", () => {
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready" }), "needs_you");
  // A detail keeps the stage in `status` next to `planStatus`.
  assert.equal(goalBoardState({ planId: "plan-3", planStatus: "draft", status: "ready", round: 2 }), "needs_you");
  assert.equal(goalBoardState({ planId: "plan-4", planStatus: "draft", status: "questions", round: 2 }), "discovering");
});

test("maps launched plans without a pull request to building", () => {
  assert.equal(goalBoardState(LAUNCHED), "building");
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "planning" }), "building");
  assert.equal(goalBoardState({ planId: "plan-5", planStatus: "launched", status: "ready", round: 1 }), "building");
});

test("maps assembling and open pull requests to in review", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "assembling" }), "in_review");
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "OPEN" }), "in_review");
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "pr_open" }), "in_review");
  assert.equal(goalBoardState({ ...LAUNCHED, finalPrUrl: "https://github.test/pr/42" }), "in_review");
});

// A blocked delivery is the state that most needs a person. Hidden inside
// "Waiting for merge" it looked exactly like work that was progressing.
test("gives a blocked delivery its own column", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "blocked" }), "stopped");
  // A goal whose every agent died is not in progress either. Only the health
  // sweep can know that, so it arrives as a verdict on the payload.
  assert.equal(goalBoardState({ ...LAUNCHED, health: "dead" }), "stopped");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "idle" }), "stopped");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "failed" }), "stopped");
  // A live agent, and a goal that already produced a pull request, both
  // outrank a health verdict.
  assert.equal(goalBoardState({ ...LAUNCHED, health: "working" }), "building");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "needs_you" }), "building");
  assert.equal(goalBoardState({ ...LAUNCHED, health: "dead", boardPrState: "OPEN" }), "in_review");
  // A payload with no verdict keeps the derivation it always had.
  assert.equal(goalBoardState(LAUNCHED), "building");
  // And a terminal outcome still wins over everything.
  assert.equal(goalBoardState({ ...LAUNCHED, health: "dead", boardStatus: "merged" }), "shipped");
  assert.equal(goalBoardState({ ...LAUNCHED, deliveryStatus: "blocked", boardStatus: "aborted" }), "aborted");
});

test("treats a closed pull request as development again", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "CLOSED", deliveryStatus: "pr_open" }), "building");
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "CLOSED", finalPrUrl: "https://github.test/pr/42" }), "building");
  // An open pull request still wins over a stale blocked status.
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "OPEN", deliveryStatus: "blocked" }), "in_review");
});

test("maps merged pull requests and merged board status to merged", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "MERGED" }), "shipped");
  assert.equal(goalBoardState({ ...LAUNCHED, boardStatus: "merged" }), "shipped");
  // A merged pull request beats every delivery signal below it.
  assert.equal(goalBoardState({ ...LAUNCHED, boardPrState: "MERGED", deliveryStatus: "blocked" }), "shipped");
  // A merged goal that was still a draft is merged too.
  assert.equal(goalBoardState({ ...SUMMARY, boardStatus: "merged" }), "shipped");
});

test("gives aborted terminal precedence over merge evidence", () => {
  assert.equal(goalBoardState({ ...LAUNCHED, boardStatus: "aborted", boardPrState: "MERGED", finalPrUrl: "https://github.test/pr/42" }), "aborted");
  assert.equal(goalBoardState({ ...SUMMARY, boardStatus: "aborted", running: true, runStage: "review_spec" }), "aborted");
});

test("never throws for missing or malformed optional fields", () => {
  for (const input of [null, undefined, 0, "plan", [], [{ status: "launched" }], {}, { status: 7, stage: [], round: "many" }]) {
    assert.equal(goalBoardState(input), "discovering");
  }
  assert.equal(goalBoardState({ status: "launched", boardPrState: { state: "OPEN" }, finalPrUrl: 12, deliveryStatus: null }), "building");
  assert.equal(goalBoardState({ status: "launched", boardPrState: "open" }), "in_review");
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
    discovering: ["plan-1", "plan-review"],
    needs_you: ["plan-ready"],
    building: ["plan-2"],
    analysis_in_progress: [],
    analysis_ready: [],
    in_review: ["plan-open"],
    stopped: ["plan-blocked", "plan-dead"],
    shipped: ["plan-merged"],
    aborted: ["plan-aborted"],
  });
  assert.deepEqual(groupGoalsByBoardState(null), empty);
});

// A discussion questions a contract that is already written. It changes
// nothing, so the goal must not appear to be planned again.
test("keeps a discussing ready draft in needs you", () => {
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready", running: true, runStage: "discussing" }), "needs_you");
  // A detail keeps the stage in `status`.
  assert.equal(goalBoardState({ planId: "plan-9", planStatus: "draft", status: "ready", round: 2, running: true, runStage: "discussing" }), "needs_you");
  // Without a contract there is nothing to sit beside, so the ordinary
  // planning column applies.
  assert.equal(goalBoardState({ ...SUMMARY, stage: "questions", running: true, runStage: "discussing" }), "discovering");
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready", round: 0, running: true, runStage: "discussing" }), "needs_you");
  // A display line must never move a card.
  assert.equal(goalBoardState({ ...SUMMARY, stage: "ready", running: true, runStep: "Discussing the contract" }), "discovering");
  // A launched goal is past discussion entirely.
  assert.equal(goalBoardState({ ...LAUNCHED, running: true, runStage: "discussing" }), "building");
});

// A goal session that asks a question or publishes a contract waits on the
// person. Both used to fall into Blocked, a collapsed column, which hid the one
// moment the product needs the user.
test("maps a goal session by who acts next", () => {
  const session = { ...SUMMARY, workflow: "goal_session" };
  assert.equal(goalBoardState({ ...session, goalSessionState: "planning" }), "discovering");
  assert.equal(goalBoardState({ ...session, goalSessionState: "awaiting_input" }), "needs_you");
  assert.equal(goalBoardState({ ...session, goalSessionState: "awaiting_approval" }), "needs_you");
  assert.equal(goalBoardState({ ...session, goalSessionState: "awaiting_approval", plannerReviewStatus: "running" }), "discovering");
  assert.equal(goalBoardState({ ...session, goalSessionState: "implementing" }), "building");
  assert.equal(goalBoardState({ ...session, goalSessionState: "implementing", boardPrState: "OPEN" }), "in_review");
  assert.equal(goalBoardState({ ...session, goalSessionState: "implementing", boardPrState: "MERGED" }), "shipped");
  assert.equal(goalBoardState({ ...session, goalSessionState: "unavailable" }), "stopped");
  assert.equal(goalBoardState({ ...session, goalSessionState: "planning", goalSessionError: "spawn failed" }), "stopped");
  assert.equal(goalBoardState({ ...session, goalSessionState: "implementing", transitionStatus: "uncertain" }), "stopped");
});
