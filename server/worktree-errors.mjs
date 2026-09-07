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

// These failures are tied to the requested branch or to a worktree already
// registered for it. A newly named branch can safely avoid that ownership;
// path and generic Git failures need to be resolved in place instead.
const FRESH_BRANCH_REASONS = new Set([
  WORKTREE_REASONS.REGISTERED_WORKTREE,
  WORKTREE_REASONS.PRIMARY,
  WORKTREE_REASONS.MANAGED_RELEASE,
  WORKTREE_REASONS.LOCKED,
  WORKTREE_REASONS.DETACHED,
  WORKTREE_REASONS.RUNNING_SESSION,
  WORKTREE_REASONS.SESSIONS_UNAVAILABLE,
  WORKTREE_REASONS.UNCOMMITTED_CHANGES,
  WORKTREE_REASONS.UNINSPECTABLE_WORKTREE,
  WORKTREE_REASONS.UNREADABLE_COMMIT,
  WORKTREE_REASONS.FOREIGN_COMMITS,
  WORKTREE_REASONS.BRANCH_EXISTS,
]);

export function isWorktreeReason(reason) {
  return typeof reason === "string" && REASON_SET.has(reason);
}

export function isFreshBranchSafeReason(reason) {
  return FRESH_BRANCH_REASONS.has(reason);
}

// Older goal rows only have the rendered error. Deliberately recognize just
// the two acquisition messages observed in production; this is not a general
// purpose attempt to reverse machine state out of prose.
export function classifyLegacyWorktreeError(message) {
  const text = typeof message === "string" ? message : "";
  if (/Git could not create this worktree: fatal: ['"].+['"] already exists/.test(text)) {
    return WORKTREE_REASONS.PATH_OCCUPIED;
  }
  if (text.includes("That branch already has a worktree with a running session")) {
    return WORKTREE_REASONS.RUNNING_SESSION;
  }
  return null;
}

class WorktreeStateError extends TypeError {
  constructor(message, reason) {
    super(message);
    this.name = "TypeError";
    if (!isWorktreeReason(reason)) throw new TypeError("Unknown worktree reason");
    this.reason = reason;
  }
}

export function worktreeStateError(message, reason) {
  return new WorktreeStateError(message, reason);
}
