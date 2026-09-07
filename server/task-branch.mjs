import { isFreshBranchSafeReason, isWorktreeReason } from "./worktree-errors.mjs";

const MAX_TASK_BRANCH_LENGTH = 81;
const MAX_TASK_BRANCH_SUFFIX = 20;

const TASK_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const FALLBACK_SUFFIX = /-(\d+)$/;

// A task keeps its effective branch in the plan row. When that branch is
// already a fallback, continue its sequence instead of growing names such as
// feature/payments-2-2. The suffix range is deliberately finite: an unhealthy
// repository produces one visible failure rather than an unbounded search.
export function taskBranchCandidates(branch) {
  const requested = String(branch || "").trim();
  if (!TASK_BRANCH.test(requested) || requested.includes("..")) {
    throw new TypeError("Choose a valid Git branch name");
  }
  const match = requested.match(FALLBACK_SUFFIX);
  const storedSuffix = match ? Number(match[1]) : null;
  const continuesFallback = Number.isInteger(storedSuffix) && storedSuffix >= 2 && storedSuffix <= MAX_TASK_BRANCH_SUFFIX;
  const stem = continuesFallback ? requested.slice(0, -match[0].length) : requested;
  const first = continuesFallback ? storedSuffix + 1 : 2;
  const candidates = [];
  for (let suffix = first; suffix <= MAX_TASK_BRANCH_SUFFIX; suffix += 1) {
    const tail = `-${suffix}`;
    // Truncation can expose a slash or dot that used to be internal. Remove it
    // before adding the suffix, then let git perform the final authoritative
    // validation below.
    const clipped = stem.slice(0, MAX_TASK_BRANCH_LENGTH - tail.length).replace(/[/.]+$/g, "");
    const candidate = `${clipped}${tail}`;
    if (candidate.length <= MAX_TASK_BRANCH_LENGTH && TASK_BRANCH.test(candidate) && !candidate.includes("..")) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

// Candidate discovery is read-only. Local refs catch an unowned branch and
// the supplied dashboard branches catch registered worktrees in lightweight
// test doubles (and races where an inventory is newer than a ref listing).
export async function selectTaskBranchCandidate({ branch, cwd, git, registeredBranches = [] } = {}) {
  if (typeof git !== "function") throw new TypeError("A Git runner is required to select a task branch");
  const occupied = new Set((registeredBranches || []).map((value) => String(value || "")).filter(Boolean));
  const local = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .then((output) => String(output || "").split("\n").map((value) => value.trim()).filter(Boolean), () => []);
  for (const value of local) occupied.add(value);

  for (const candidate of taskBranchCandidates(branch)) {
    if (occupied.has(candidate)) continue;
    const valid = await git(cwd, ["check-ref-format", "--branch", candidate]).then(() => true, () => false);
    if (valid) return candidate;
  }
  throw acquisitionError(
    `No fresh task branch is available for ${branch}; fallback suffixes are exhausted through -${MAX_TASK_BRANCH_SUFFIX}`,
    { effectiveBranch: String(branch || "") },
  );
}

// Every task acquisition gets exactly two opportunities: its persisted branch,
// then one selected fresh branch when (and only when) T1 classified the first
// refusal as safe to avoid by changing ownership. Nothing here parses prose.
export async function acquireTaskWorktree({
  worktrees,
  repositoryId,
  repositoryPath,
  branch,
  base,
  inventory = { available: false, workspaces: [] },
  git,
  planId = null,
  taskId = null,
  log = null,
  forceFresh = false,
  fallbackReason = null,
} = {}) {
  const originalBranch = String(branch || "");
  const options = (selectedBranch) => ({
    branch: selectedBranch,
    base,
    reuseIfAtBase: true,
    requireFreshAtBase: true,
    workspaces: Array.isArray(inventory?.workspaces) ? inventory.workspaces : [],
    workspacesAvailable: inventory?.available === true,
  });

  if (forceFresh) {
    const registeredBranches = await registeredBranchesFor(worktrees, repositoryId);
    const selectedBranch = await selectTaskBranchCandidate({
      branch: originalBranch,
      cwd: repositoryPath,
      git,
      registeredBranches,
    });
    log?.warn?.({ originalBranch, selectedBranch, reason: fallbackReason, planId, taskId }, "rebranching task acquisition onto a fresh branch");
    try {
      const created = await worktrees.create(repositoryId, options(selectedBranch));
      return { ...created, branch: selectedBranch };
    } catch (cause) {
      throw acquisitionError(cause, { effectiveBranch: selectedBranch, fallbackReason });
    }
  }

  try {
    const created = await worktrees.create(repositoryId, options(originalBranch));
    return { ...created, branch: originalBranch };
  } catch (cause) {
    if (!isFreshBranchSafeReason(cause?.reason)) throw acquisitionError(cause, { effectiveBranch: originalBranch });

    const registeredBranches = await registeredBranchesFor(worktrees, repositoryId);
    let selectedBranch;
    try {
      selectedBranch = await selectTaskBranchCandidate({
        branch: originalBranch,
        cwd: repositoryPath,
        git,
        registeredBranches,
      });
    } catch (selectionCause) {
      throw acquisitionError(selectionCause, {
        effectiveBranch: originalBranch,
        fallbackReason: cause.reason,
        reason: cause.reason,
      });
    }
    log?.warn?.({
      originalBranch,
      selectedBranch,
      reason: cause.reason,
      planId,
      taskId,
    }, "retrying task acquisition on a fresh branch");
    try {
      const created = await worktrees.create(repositoryId, options(selectedBranch));
      return { ...created, branch: selectedBranch };
    } catch (retryCause) {
      throw acquisitionError(retryCause, {
        effectiveBranch: selectedBranch,
        fallbackReason: cause.reason,
      });
    }
  }
}

export function launchReason(cause) {
  return isWorktreeReason(cause?.reason) ? cause.reason : null;
}

export function effectiveTaskBranch(cause, fallback) {
  return typeof cause?.effectiveBranch === "string" && cause.effectiveBranch ? cause.effectiveBranch : fallback;
}

async function registeredBranchesFor(worktrees, repositoryId) {
  if (typeof worktrees?.snapshot !== "function") return [];
  try {
    const dashboard = await worktrees.snapshot({ refresh: true });
    const repository = dashboard?.repositories?.find((item) => item?.id === repositoryId);
    return [...(repository?.worktrees || []), ...(repository?.releases || [])]
      .map((item) => item?.branch)
      .filter(Boolean);
  } catch {
    // The local ref inventory remains authoritative, and create() repeats the
    // fresh-at-base check before Git is allowed to add a worktree.
    return [];
  }
}

function acquisitionError(cause, context = {}) {
  const error = cause instanceof Error ? cause : new TypeError(String(cause || "Could not acquire a task worktree"));
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && (key !== "reason" || !isWorktreeReason(error.reason))) {
      try { error[key] = value; } catch { /* an exotic frozen error is wrapped below */ }
    }
  }
  if (context.reason && !isWorktreeReason(error.reason)) {
    try { error.reason = context.reason; } catch { /* handled below */ }
  }
  if (context.effectiveBranch && error.effectiveBranch !== context.effectiveBranch) {
    const wrapped = new TypeError(error.message, { cause: error });
    Object.assign(wrapped, context);
    return wrapped;
  }
  return error;
}
