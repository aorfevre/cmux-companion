// One goal has one place on the board. This module owns that mapping and
// nothing else: no storage, no network, no Node built-ins. The dashboard, the
// API and the tests all read the same derivation, so a card can never sit in
// one column here and another column there.
//
// The board reads structured fields only. It never parses a display label such
// as `runStep`, because a wording change in the planner must not move a card.

// The seven columns, in board order. Frozen so no caller can reorder or extend
// the lifecycle by mutating the shared array.
export const GOAL_BOARD_COLUMNS = Object.freeze([
  Object.freeze({ id: "writing_spec", label: "Writing Spec", description: "The planner is still drafting the specification." }),
  Object.freeze({ id: "review_spec", label: "Review Spec", description: "A reviewer pass is checking the specification." }),
  Object.freeze({ id: "waiting_for_dev", label: "Waiting for dev", description: "The specification is ready to launch." }),
  Object.freeze({ id: "dev_in_progress", label: "Dev in progress", description: "Agents are working on the launched tasks." }),
  Object.freeze({ id: "waiting_for_merge", label: "Waiting for merge", description: "The work waits for the goal pull request to merge." }),
  Object.freeze({ id: "merged", label: "Merged", description: "The goal pull request is merged." }),
  Object.freeze({ id: "aborted", label: "Aborted", description: "The goal was stopped and no more work is expected." }),
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
  const prState = text(source.boardPrState).toUpperCase();
  if (boardStatus === "merged" || prState === "MERGED") return "merged";

  if (!isLaunched(source)) return draftState(source);

  if (prState === "OPEN") return "waiting_for_merge";
  const delivery = text(source.deliveryStatus);
  if (delivery === "assembling" || delivery === "blocked") return "waiting_for_merge";
  // A closed pull request means the branch went back to development. It
  // overrides a stale `pr_open` status or a final URL left from the closed run.
  if (prState !== "CLOSED" && (delivery === "pr_open" || text(source.finalPrUrl) !== "")) return "waiting_for_merge";
  return "dev_in_progress";
}

// Groups plans into every column. Each column id is always present with an
// array value, so the board renders seven columns even with no goals at all.
export function groupGoalsByBoardState(plans) {
  const grouped = {};
  for (const id of COLUMN_IDS) grouped[id] = [];
  for (const plan of Array.isArray(plans) ? plans : []) grouped[goalBoardState(plan)].push(plan);
  return grouped;
}

function draftState(source) {
  if (source.running === true) {
    // The reviewer phase is a structured run stage, never a progress line.
    return text(source.runStage) === "review_spec" ? "review_spec" : "writing_spec";
  }
  // Round zero means the first planner round never produced a specification.
  if (!(Number(source.round) >= 1)) return "writing_spec";
  return stage(source) === "ready" ? "waiting_for_dev" : "writing_spec";
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
