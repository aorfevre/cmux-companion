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
  description: "Open GitHub issues from your starred repositories. Start a goal to move one into Writing Spec.",
});

// Shown when the column is empty because nothing was synced yet.
export const GITHUB_ISSUE_EMPTY_HINT = "No GitHub issues yet. Star a repository, then choose GitHub Sync to pull its open issues.";

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
