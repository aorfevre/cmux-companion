import { plannerReviewPhase } from "./goal-options.mjs";
// One goal has one place on the board. This module owns that mapping and
// nothing else: no storage, no network, no Node built-ins. The dashboard, the
// API and the tests all read the same derivation, so a card can never sit in
// one column here and another column there.
//
// The board reads structured fields only. It never parses a display label such
// as `runStep`, because a wording change in the planner must not move a card.

// The columns, in board order, each named for who acts. Frozen so no caller
// can reorder or extend the lifecycle by mutating the shared array.
export const GOAL_BOARD_COLUMNS = Object.freeze([
  Object.freeze({ id: "discovering", label: "Discovering", description: "The agent reads the repository and drafts the delivery contract." }),
  Object.freeze({ id: "needs_you", label: "Needs you", description: "Answer a question, approve the contract or request changes." }),
  Object.freeze({ id: "building", label: "Building", description: "Agents are implementing the approved contract." }),
  Object.freeze({ id: "analysis_in_progress", label: "Analysis in progress", description: "The analyst is preparing a read-only report." }),
  Object.freeze({ id: "analysis_ready", label: "Analysis ready", description: "Read the saved report, challenge it or launch coding discovery." }),
  Object.freeze({ id: "in_review", label: "In review", description: "The pull request is open and waits for review and merge." }),
  Object.freeze({ id: "stopped", label: "Stopped", description: "The goal failed or its agent died. A person must decide.", collapsedByDefault: true }),
  Object.freeze({ id: "shipped", label: "Shipped", description: "The goal pull request is merged.", collapsedByDefault: true }),
  Object.freeze({ id: "aborted", label: "Aborted", description: "The goal was stopped on purpose and no more work is expected.", collapsedByDefault: true }),
]);

const COLUMN_IDS = Object.freeze(GOAL_BOARD_COLUMNS.map((column) => column.id));

// Returns the one board state for a plan. The input is either a list summary
// or a plan detail. It is never trusted: a null, an array, or a malformed
// nested value must produce a column, not an exception.
export function goalBoardState(plan) {
  const source = record(plan);

  // A terminal outcome is persisted, so it wins over every derived signal.
  // An aborted goal that also carries merge evidence stays aborted.
  const boardStatus = text(source.boardStatus);
  if (boardStatus === "aborted") return "aborted";
  // A launched goal whose agents all died is not "in progress". The sweep is
  // the only thing that can know this, so the caller passes its verdict in
  // `health`; a payload without one keeps the old derivation exactly.
  const health = text(source.health);
  const prState = text(source.boardPrState).toUpperCase();
  if (source.goalType !== "analysis" && (boardStatus === "merged" || prState === "MERGED")) return "shipped";

  // Managed goal sessions have no launched task row while the one owner is
  // conversing or editing. Their durable lifecycle is therefore the board
  // authority, never an empty legacy planner round.
  if (text(source.workflow) === "goal_session") {
    const session = text(source.goalSessionState);
    if (session === "unavailable" || text(source.goalSessionError) || source.transitionStatus === "uncertain") return "stopped";
    if (source.goalType === "analysis") {
      if (session === "analysis_ready") return "analysis_ready";
      if (session === "analyzing") return "analysis_in_progress";
    } else if (prState === "OPEN" || (prState !== "CLOSED" && text(source.finalPrUrl) !== "")) return "in_review";
    // A reviewer pass on a published contract is still discovery: nothing
    // waits on the person until the pass ends.
    const review = source.plannerReviewStatus || plannerReviewPhase(source);
    if (session === "awaiting_approval" && ["queued", "running", "pending"].includes(review)) return "discovering";
    if (session === "awaiting_approval" && ["failed", "uncertain", "stale"].includes(review)) return "stopped";
    // A question and a published contract both wait on the person. They are
    // the healthy path, never a failure, so they share one visible column.
    if (session === "awaiting_input" || session === "awaiting_approval") return "needs_you";
    if (session === "implementing") return "building";
    return "discovering";
  }

  if (!isLaunched(source)) return draftState(source);

  if (prState === "OPEN") return "in_review";
  const delivery = text(source.deliveryStatus);
  // A blocked delivery used to sit in "Waiting for merge", where it looked
  // exactly like work that was progressing. It is the state that most needs a
  // person, so it gets its own column and says so.
  if (delivery === "blocked") return "stopped";
  if (delivery === "assembling") return "in_review";
  // A closed pull request means the branch went back to development. It
  // overrides a stale `pr_open` status or a final URL left from the closed run.
  if (prState !== "CLOSED" && (delivery === "pr_open" || text(source.finalPrUrl) !== "")) return "in_review";
  // Live agents outrank a health verdict that is merely stale, so this is the
  // last check: everything above describes work that has already moved on.
  if (health === "dead" || health === "idle" || health === "failed") return "stopped";
  return "building";
}

// Groups plans into every column. Each column id is always present with an
// array value, so the board renders every column even with no goals at all.
export function groupGoalsByBoardState(plans) {
  const grouped = {};
  for (const id of COLUMN_IDS) grouped[id] = [];
  for (const plan of Array.isArray(plans) ? plans : []) grouped[goalBoardState(plan)].push(plan);
  return grouped;
}

function draftState(source) {
  if (source.running === true) {
    // The reviewer phase is a structured run stage, never a progress line.
    const runStage = text(source.runStage);
    // A discussion questions a contract that is already written. It changes
    // nothing, so the goal stays where the user left it rather than appearing
    // to be planned again. A discussion on a stage that is not ready has no
    // contract to sit beside, so it keeps the ordinary planning column.
    if (runStage === "discussing") return stage(source) === "ready" ? "needs_you" : "discovering";
    // The legacy reviewer pass is still discovery: nothing waits on the person.
    return "discovering";
  }
  // Round zero means the first planner round never produced a specification.
  if (!(Number(source.round) >= 1)) return "discovering";
  return stage(source) === "ready" ? "needs_you" : "discovering";
}

// A list summary carries the launch state in `status`. A plan detail carries it
// in `planStatus` and reuses `status` for the stage, so `planStatus` wins.
function isLaunched(source) {
  const value = text(source.planStatus) || text(source.status);
  return value === "launched";
}

// The stage is `stage` when the shape has one. A detail without `stage` keeps
// the stage in `status`, where the only stage values are `questions` and
// `ready`. A `status` that holds a launch value is not a stage.
function stage(source) {
  const explicit = text(source.stage);
  if (explicit) return explicit;
  const status = text(source.status);
  return status === "questions" || status === "ready" ? status : "";
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
