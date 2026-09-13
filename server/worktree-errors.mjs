// Keep this module browser-safe. Goal state and UI code can share these reason
// codes without pulling Node's filesystem or Git helpers into a client bundle.
export const WORKTREE_REASONS = Object.freeze({
  REGISTERED_WORKTREE: "registered-worktree",
  PRIMARY: "primary",
  MANAGED_RELEASE: "managed-release",
  LOCKED: "locked",
  DETACHED: "detached",
  RUNNING_SESSION: "running-session",
  SESSIONS_UNAVAILABLE: "sessions-unavailable",
  UNCOMMITTED_CHANGES: "uncommitted-changes",
  UNINSPECTABLE_WORKTREE: "uninspectable-worktree",
  UNREADABLE_COMMIT: "unreadable-commit",
  FOREIGN_COMMITS: "foreign-commits",
  BRANCH_EXISTS: "branch-exists",
  PATH_OCCUPIED: "path-occupied",
  ADD_FAILURE: "add-failure",
  CREATED_NOT_LOADABLE: "created-but-not-loadable",
  REMOVE_FAILURE: "remove-failure",
});

const REASON_SET = new Set(Object.values(WORKTREE_REASONS));

export function isWorktreeReason(reason) {
  return typeof reason === "string" && REASON_SET.has(reason);
}
