// One synced GitHub issue has one place on the board. This module owns that
// column's identity and nothing else: no storage, no network, no Node
// built-ins. The server, the API and the client bundle all import the same
// definition, exactly like server/goal-board.mjs, so the column can never be
// labelled one way in the API and another way in the UI.

// The issue column sits to the left of every goal column. It is frozen so no
// caller can rename or re-key it by mutation.
export const GITHUB_ISSUE_COLUMN = Object.freeze({
  id: "github_issues",
  label: "GitHub Issues",
  description: "Open GitHub issues from your starred repositories. Start a goal to move one into Discovering.",
});

// Shown when the column is empty because nothing was synced yet.
export const GITHUB_ISSUE_EMPTY_HINT = "No GitHub issues yet. Star a repository, then choose GitHub Sync to pull its open issues.";

// Shown when the column is empty because every synced issue already started a
// goal. That is a different state from "nothing was synced yet", so it gets its
// own words instead of the star-a-repository hint.
export const GITHUB_ISSUE_ALL_STARTED_HINT = "Every synced GitHub issue already has a goal. Each one is on the board in its lifecycle column.";

// Shown when a sync ran but no repository is starred. The sync says this
// plainly instead of reporting an empty success.
export const GITHUB_ISSUE_NO_FAVORITES = "No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.";

// The sync result status for that case. The API, the UI and the tests compare
// against this one constant.
export const GITHUB_ISSUE_SYNC_NO_FAVORITES = "no_starred_repositories";

// A card key. One repository plus one issue number is one card, so the same
// issue number in two repositories stays two cards.
export function githubIssueCardId({ repositoryId, number } = {}) {
  const id = typeof repositoryId === "string" ? repositoryId.trim() : "";
  const value = Number(number);
  if (!id || !Number.isInteger(value) || value <= 0) return "";
  return `${GITHUB_ISSUE_COLUMN.id}:${id}:${value}`;
}

// True when a stored issue already started a goal. The card reads this instead
// of testing the raw field, so "started" means one thing everywhere.
export function isGithubIssueStarted(issue) {
  const planId = issue && typeof issue === "object" ? issue.planId : null;
  return typeof planId === "string" && planId.trim() !== "";
}

// True when an issue still belongs in the issue column.
//
// A started issue is already on the board as its goal card, so the column drops
// it. The plan must be one the board actually knows about: a deleted goal
// leaves a stale planId behind, and an issue must never be stranded off the
// board because of it. Unknown plan means the issue comes back, startable.
//
// `knownPlanIds` is any iterable of plan ids, or a Set. Untrusted input never
// throws: a null issue, a malformed row or a missing id list keeps the issue
// visible.
export function isGithubIssueOnBoard(issue, knownPlanIds) {
  if (!isGithubIssueStarted(issue)) return true;
  const planId = issue.planId.trim();
  if (knownPlanIds instanceof Set) return !knownPlanIds.has(planId);
  if (!Array.isArray(knownPlanIds)) return true;
  return !knownPlanIds.some((id) => typeof id === "string" && id.trim() === planId);
}

// The column's card list. It reads the same predicate the header count reads,
// so the number and the cards can never disagree.
export function visibleGithubIssues(issues, knownPlanIds) {
  if (!Array.isArray(issues)) return [];
  const known = knownPlanIds instanceof Set ? knownPlanIds
    : new Set((Array.isArray(knownPlanIds) ? knownPlanIds : []).filter((id) => typeof id === "string").map((id) => id.trim()));
  return issues.filter((issue) => isGithubIssueOnBoard(issue, known));
}
