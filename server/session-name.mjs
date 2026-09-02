// Every cmux session Companion opens used to be titled with the bare task
// title. Twelve parallel sessions then read as twelve unrelated sentences, and
// nothing said which goal, which task, or which part of the work a session was.
//
// This module owns the one naming scheme, so the four launch sites and any
// later rename all produce the same name:
//
//   KRV-T2-api · Wire the health sweep into the board
//   └┬┘ └┬┘ └┬┘   └───────────────┬───────────────┘
//    │   │   │                    the task title, trimmed
//    │   │   the part: what kind of work this is
//    │   the task code within its goal
//    the project code
//
// The code half is deliberately first and deliberately short: cmux shows the
// start of a title in a narrow sidebar, so the part that identifies the session
// must survive truncation. The title half is what a person reads once they have
// found the right session.

// cmux refuses a title over 100 characters, and `workspaceRename` validates the
// same bound, so both halves are budgeted against it rather than trusting the
// caller to stay short.
export const MAX_TITLE = 100;
const SEPARATOR = " · ";

// The part is taken from the task type the planner already assigns. These are
// the contract's own values; anything else falls back to the generic `dev`
// rather than inventing a code from free text.
const PARTS = new Map([
  ["feature", "feat"],
  ["bugfix", "fix"],
  ["ui", "ui"],
  ["backend", "api"],
  ["docs", "docs"],
  ["test", "test"],
  ["migration", "migr"],
  ["investigation", "spike"],
  ["refactor", "rfac"],
]);

// A project code is derived from the repository name, not configured, so a new
// repository needs no setup: cmux-companion → CMX, rekord-api → RKR, karven →
// KRV. Vowels are dropped first because a consonant skeleton stays legible when
// it is squeezed to three characters.
export function projectCode(repositoryName) {
  const raw = text(repositoryName);
  if (!raw) return "GOAL";
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "GOAL";
  // Several words: take an initial from each, which is what a person would do.
  if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 4).toUpperCase();
  const word = words[0];
  const consonants = word.replace(/[^A-Za-z0-9]/g, "").replace(/[aeiou]/gi, "");
  const source = consonants.length >= 3 ? consonants : word;
  return source.slice(0, 3).toUpperCase();
}

// The task code is the planner's own task id when it already looks like one
// (T1, T2 …), because that id is what the contract, the brief filename and the
// commit trailer all use. A generated uuid is not readable, so it becomes a
// positional code instead.
export function taskCode(taskId, position = 0) {
  const raw = text(taskId).toUpperCase();
  if (/^T\d{1,3}$/.test(raw)) return raw;
  const index = Number(position);
  return `T${Number.isFinite(index) && index >= 0 ? index + 1 : 1}`;
}

export function partCode(taskType) {
  return PARTS.get(text(taskType).toLowerCase()) || "dev";
}

// The full name. `plan` and `task` are the shapes the store returns, so every
// caller passes what it already has in hand.
export function sessionTitle(plan, task, { suffix = "" } = {}) {
  const code = [
    projectCode(plan?.repositoryName),
    taskCode(task?.id, taskPosition(plan, task)),
    partCode(task?.type),
  ].join("-");
  const label = text(suffix) ? `${code}${SEPARATOR}${text(suffix)}` : code;
  const title = oneLine(task?.title);
  if (!title) return label.slice(0, MAX_TITLE);
  // The code is never truncated. When the budget is tight the title loses
  // characters, because a shortened title is still recognisable and a
  // shortened code is not.
  const room = MAX_TITLE - label.length - SEPARATOR.length;
  if (room < 8) return label.slice(0, MAX_TITLE);
  return `${label}${SEPARATOR}${clip(title, room)}`;
}

// The merge session belongs to the goal, not to one task, so it carries the
// project code and the goal text in the same shape.
export function mergeSessionTitle(plan) {
  const code = `${projectCode(plan?.repositoryName)}-MERGE`;
  // Both sides are trimmed before the choice. A whitespace-only outcome is
  // truthy, so an untrimmed `||` would let it win and then collapse to empty,
  // and the merge session would lose its goal text for no reason.
  const goal = oneLine(plan?.spec?.outcome) || oneLine(plan?.goal);
  const room = MAX_TITLE - code.length - SEPARATOR.length;
  if (!goal || room < 8) return code.slice(0, MAX_TITLE);
  return `${code}${SEPARATOR}${clip(goal, room)}`;
}

// Environment stamps that survive a rename. A title is what a person reads; a
// person can also edit it, and then no lookup by title works any more. These
// are the machine-readable identity, set once at creation.
export function sessionEnv(plan, task) {
  const env = {
    COMPANION_PROJECT: projectCode(plan?.repositoryName),
    COMPANION_PLAN: text(plan?.planId),
  };
  if (task) {
    env.COMPANION_TASK = taskCode(task.id, taskPosition(plan, task));
    env.COMPANION_PART = partCode(task.type);
  }
  return env;
}

function taskPosition(plan, task) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const index = tasks.findIndex((item) => item?.id === task?.id);
  return index >= 0 ? index : 0;
}

function oneLine(value) {
  return text(value).replace(/\s+/g, " ");
}

function clip(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
