// The per-goal execution intensity. Like review-options.mjs, this is
// deliberately NOT a SPEC_OPTIONS entry: specOptionCoverage marks a requested
// spec option "missing" when no task evidences it, and no task can evidence
// "use more quota". The module is data-only so the browser sheet imports it.

export const BURST_OPTION = Object.freeze({
  id: "burst",
  label: "Burst",
  hint: "Uses more quota: extra reviewers and subagents.",
  description: "Extra independent reviewers on every finished task and on the goal pull request. Every task agent may run subagents.",
});

export function normalizeBurst(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new TypeError("Burst must be true or false");
  return value;
}

// Appended to every task brief of a burst goal. The last sentence matters:
// a subagent result the owner never read is the one way parallel work hides a
// regression.
export function burstBriefLines(burst) {
  if (burst !== true) return [];
  return [
    "Burst mode is on for this goal:",
    "- You may launch subagents for independent slices, for exploration and for review. Prefer parallel work where it is safe.",
    "- Quota is not a constraint for this task.",
    "- Every subagent result is your responsibility: verify it before you report it.",
  ];
}
