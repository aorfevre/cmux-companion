import { followupActionLabels } from "./goal-followup-actions.mjs";

// Every cmux session Companion opens used to be titled with the bare task
// title. Twelve parallel sessions then read as twelve unrelated sentences, and
// nothing said which goal, which task, or which part of the work a session was.
//
// This module owns the one naming scheme, so the four launch sites and any
// later rename all produce the same name:
//
//   CC · Every goal is visible on the board (plan) · T2-api · Wire the health sweep
//   └┬┘   └────────────────┬──────────────┘ └─┬─┘   └┬┘ └┬┘   └───────────┬───────┘
//    │                     │                  │      │   │                │
//    │                     │                  │      │   │  the task title, trimmed
//    │                     │                  │      │   the part: what kind of work
//    │                     │                  │      the task code within its goal
//    │                     │                  the first 4 alphanumerics of the plan id
//    │                     the goal text, on one line, clipped to its own budget
//    the project code
//
// The order is product, then goal, then task. That is the order a person asks
// the questions in, so a sidebar of parallel sessions groups by eye.
//
// The reorder has a cost, and the budgets pay it. The identifying code no
// longer leads, so it no longer survives truncation for free. Each segment
// therefore carries a hard budget - project 4, goal segment 44, task-part 10 -
// which keeps the `T2-api` segment at a near-fixed offset in cmux's narrow
// sidebar. Only the task title clips.
//
// The parenthesised id fragment is the same fragment `integrationBranch` in
// server/goal-integrator.mjs puts on a goal branch. It is what keeps two goals
// in one repository apart when they open with the same words, so the goal text
// clips around it and it is never the part that is cut.

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

// The budgets that keep the task-part code at a near-fixed offset. Only the
// task title is allowed to clip, so every segment before it is bounded here.
const GOAL_TEXT_BUDGET = 36;
const FRAGMENT_LENGTH = 4;

// The plan-id fragment, in the same shape `integrationBranch` in
// server/goal-integrator.mjs already puts on a goal branch. A plan with no
// usable id still gets a readable fragment, because an empty pair of
// parentheses would say nothing and would still cost three characters.
function goalFragment(planId) {
  return text(planId).replace(/[^a-z0-9]/gi, "").slice(0, FRAGMENT_LENGTH).toLowerCase() || "goal";
}

// The goal segment: the goal's own words, then the fragment that tells two
// same-worded goals apart. The words clip; the fragment never does.
export function goalSegment(plan) {
  const fragment = `(${goalFragment(plan?.planId)})`;
  // Both sides are trimmed before the choice. A whitespace-only outcome is
  // truthy, so an untrimmed `||` would let it win and then collapse to empty,
  // and the segment would lose its goal text for no reason.
  const goal = goalText(plan?.spec?.outcome) || goalText(plan?.goal);
  return goal ? `${clip(goal, GOAL_TEXT_BUDGET)} ${fragment}` : fragment;
}

// The full name. `plan` and `task` are the shapes the store returns, so every
// caller passes what it already has in hand.
export function sessionTitle(plan, task, { suffix = "" } = {}) {
  const taskPart = `${taskCode(task?.id, taskPosition(plan, task))}-${partCode(task?.type)}`;
  const segments = [projectCode(plan?.repositoryName), goalSegment(plan), taskPart];
  if (text(suffix)) segments.push(text(suffix));
  const label = segments.join(SEPARATOR);
  const title = oneLine(task?.title);
  if (!title) return label.slice(0, MAX_TITLE);
  // The segments before the title are never truncated. When the budget is
  // tight the title loses characters, because a shortened title is still
  // recognisable and a shortened code is not.
  const room = MAX_TITLE - label.length - SEPARATOR.length;
  if (room < 8) return label.slice(0, MAX_TITLE);
  return `${label}${SEPARATOR}${clip(title, room)}`;
}

// The merge session belongs to the goal, not to one task, so it carries the
// project code and the goal segment, then MERGE where a task-part would sit.
// The goal text lives inside the segment, so it is not repeated after it.
export function mergeSessionTitle(plan) {
  return [projectCode(plan?.repositoryName), goalSegment(plan), "MERGE"].join(SEPARATOR).slice(0, MAX_TITLE);
}

// A follow-up belongs to the goal branch rather than to one task. Its code is
// therefore project-scoped, while the readable half says both which goal and
// which catalogue actions opened it. The code is never clipped.
export function followupSessionTitle(plan, actions) {
  const code = `${projectCode(plan?.repositoryName)}-ASK`;
  const label = goalText(plan?.spec?.outcome)
    || goalText(plan?.goal)
    || followupActionLabels(actions).join(", ")
    || "Goal follow-up";
  const room = MAX_TITLE - code.length - SEPARATOR.length;
  return `${code}${SEPARATOR}${clip(label, room)}`;
}

// Environment stamps that survive a rename. A title is what a person reads; a
// person can also edit it, and then no lookup by title works any more. These
// are the machine-readable identity, set once at creation.
export function sessionEnv(plan, task) {
  const env = {
    COMPANION_PROJECT: projectCode(plan?.repositoryName),
    COMPANION_PLAN: text(plan?.planId),
    COMPANION_GOAL: goalFragment(plan?.planId),
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

function goalText(value) {
  // A person types the goal, so it can carry the separator itself or a pair of
  // parentheses. Either would make the name read as more or fewer than four
  // segments, and the board parser slices on those segments.
  return oneLine(text(value).replace(/\u00b7/g, "-").replace(/[()]/g, ""));
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
