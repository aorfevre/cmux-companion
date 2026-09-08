import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireTaskWorktree,
  effectiveTaskBranch,
  launchReason,
  selectTaskBranchCandidate,
  taskBranchCandidates,
} from "../server/task-branch.mjs";
import { WORKTREE_REASONS } from "../server/worktree-errors.mjs";

const REPO = "repo-1";
const PATH = "/repo/sample";

function refusal(reason, message = `refused: ${reason}`) {
  return Object.assign(new Error(message), { reason });
}

function fakeGit({ local = "", invalid = [] } = {}) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "for-each-ref") return local;
    if (args[0] === "check-ref-format" && invalid.includes(args[2])) throw new Error("invalid ref");
    return "";
  };
  return { git, calls };
}

// `worktrees.create` runs a scripted sequence; each entry is either a value
// to return or an Error to throw.
function fakeWorktrees(script, { snapshot } = {}) {
  const calls = [];
  const worktrees = {
    create: async (repositoryId, options) => {
      calls.push({ repositoryId, options });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  if (snapshot) worktrees.snapshot = snapshot;
  return { worktrees, calls };
}

test("branch candidates reject names git would refuse and ignore out-of-range suffixes", () => {
  for (const branch of ["", "  ", "-leading", "a..b", "with space", "x".repeat(82)]) {
    assert.throws(() => taskBranchCandidates(branch), /valid Git branch name/);
  }
  // A suffix past the bound is not a fallback to continue: the whole name is the stem.
  assert.equal(taskBranchCandidates("feature/payments-21")[0], "feature/payments-21-2");
  assert.equal(taskBranchCandidates("feature/payments-1")[0], "feature/payments-1-2");
  // Continuing a fallback stops at the bound, so the list shrinks accordingly.
  assert.deepEqual(taskBranchCandidates("feature/payments-19"), ["feature/payments-20"]);
  assert.deepEqual(taskBranchCandidates("feature/payments-20"), []);
  // A truncated stem never ends with a slash or dot before the suffix.
  const slashy = `${"a".repeat(78)}/b`;
  assert.equal(taskBranchCandidates(slashy)[0], `${"a".repeat(78)}-2`);
});

test("branch selection requires a Git runner, tolerates a failed ref listing and skips refs git rejects", async () => {
  await assert.rejects(() => selectTaskBranchCandidate({ branch: "feature/x", cwd: PATH }), /Git runner is required/);
  const { git, calls } = fakeGit({ invalid: ["feature/x-2"] });
  const failing = async (cwd, args) => {
    if (args[0] === "for-each-ref") throw new Error("not a repository");
    return git(cwd, args);
  };
  const selected = await selectTaskBranchCandidate({ branch: "feature/x", cwd: PATH, git: failing, registeredBranches: [null, "", "feature/x-3"] });
  assert.equal(selected, "feature/x-4");
  assert.deepEqual(calls.map((call) => call.args[2]), ["feature/x-2", "feature/x-4"]);
  assert.ok(calls.every((call) => call.cwd === PATH));
});

test("acquisition returns the persisted branch when its worktree is created first time", async () => {
  const { worktrees, calls } = fakeWorktrees([{ path: "/repo/sample-billing" }]);
  const { git, calls: gitCalls } = fakeGit();
  const result = await acquireTaskWorktree({
    worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/billing", base: "main", git,
    inventory: { available: true, workspaces: [{ id: "ws-1" }] },
  });
  assert.deepEqual(result, { path: "/repo/sample-billing", branch: "feature/billing" });
  assert.deepEqual(calls[0].options, {
    branch: "feature/billing", base: "main", reuseIfAtBase: true, requireFreshAtBase: true,
    workspaces: [{ id: "ws-1" }], workspacesAvailable: true,
  });
  assert.equal(gitCalls.length, 0, "a successful first attempt never consults Git");
});

test("acquisition retries once on a fresh branch after an ownership refusal and logs the rebranch", async () => {
  const warnings = [];
  const log = { warn: (fields, message) => warnings.push({ fields, message }) };
  const { worktrees, calls } = fakeWorktrees([
    refusal(WORKTREE_REASONS.RUNNING_SESSION),
    { path: "/repo/sample-billing-3" },
  ], {
    snapshot: async ({ refresh }) => {
      assert.equal(refresh, true);
      return { repositories: [{ id: REPO, worktrees: [{ branch: "feature/billing-2" }], releases: [{ branch: null }] }, { id: "other", worktrees: [{ branch: "feature/billing-3" }] }] };
    },
  });
  const { git } = fakeGit();
  const result = await acquireTaskWorktree({
    worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/billing", base: "main", git, log, planId: "plan-1", taskId: "T1",
  });
  assert.equal(result.branch, "feature/billing-3");
  assert.deepEqual(calls.map((call) => call.options.branch), ["feature/billing", "feature/billing-3"]);
  assert.deepEqual(calls[1].options.workspaces, []);
  assert.equal(calls[1].options.workspacesAvailable, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "retrying task acquisition on a fresh branch");
  assert.deepEqual(warnings[0].fields, { originalBranch: "feature/billing", selectedBranch: "feature/billing-3", reason: WORKTREE_REASONS.RUNNING_SESSION, planId: "plan-1", taskId: "T1" });
});

test("acquisition surfaces an in-place failure with the original branch and no retry", async () => {
  const cause = refusal(WORKTREE_REASONS.PATH_OCCUPIED, "path taken");
  const { worktrees, calls } = fakeWorktrees([cause]);
  const { git, calls: gitCalls } = fakeGit();
  const error = await acquireTaskWorktree({ worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/billing", base: "main", git }).catch((value) => value);
  assert.equal(error, cause, "the refusal itself is rethrown, not wrapped");
  assert.equal(error.effectiveBranch, "feature/billing");
  assert.equal(error.reason, WORKTREE_REASONS.PATH_OCCUPIED);
  assert.equal(calls.length, 1);
  assert.equal(gitCalls.length, 0);
});

test("acquisition reports the original branch when no fresh candidate can be selected", async () => {
  const occupied = Array.from({ length: 19 }, (_, index) => `feature/billing-${index + 2}`).join("\n");
  const { worktrees } = fakeWorktrees([refusal(WORKTREE_REASONS.BRANCH_EXISTS)], { snapshot: async () => { throw new Error("dashboard offline"); } });
  const { git } = fakeGit({ local: occupied });
  const error = await acquireTaskWorktree({ worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/billing", base: "main", git }).catch((value) => value);
  assert.match(error.message, /exhausted through -20/);
  assert.equal(error.effectiveBranch, "feature/billing");
  assert.equal(error.fallbackReason, WORKTREE_REASONS.BRANCH_EXISTS);
  assert.equal(error.reason, WORKTREE_REASONS.BRANCH_EXISTS, "the selection failure inherits the refusal's reason");
});

test("acquisition keeps the refusal reason and the selected branch when the retry fails too", async () => {
  const retryCause = refusal(WORKTREE_REASONS.ADD_FAILURE, "git worktree add failed");
  const { worktrees, calls } = fakeWorktrees([refusal(WORKTREE_REASONS.LOCKED), retryCause], { snapshot: async () => ({ repositories: [] }) });
  const { git } = fakeGit();
  const error = await acquireTaskWorktree({ worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/billing", base: "main", git, log: {} }).catch((value) => value);
  assert.equal(calls.length, 2);
  assert.equal(error, retryCause);
  assert.equal(error.effectiveBranch, "feature/billing-2");
  assert.equal(error.fallbackReason, WORKTREE_REASONS.LOCKED);
  assert.equal(error.reason, WORKTREE_REASONS.ADD_FAILURE, "a genuine worktree reason on the retry is not overwritten");
});

test("forced fresh acquisition skips the persisted branch and wraps a failed create", async () => {
  const warnings = [];
  const cause = new Error("disk full");
  const { worktrees, calls } = fakeWorktrees([{ path: "/x" }, cause]);
  const { git } = fakeGit({ local: "feature/billing-2\n" });
  const options = {
    worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/billing", base: "main", git,
    forceFresh: true, fallbackReason: WORKTREE_REASONS.FOREIGN_COMMITS, log: { warn: (fields, message) => warnings.push({ fields, message }) },
  };
  const created = await acquireTaskWorktree(options);
  assert.deepEqual(created, { path: "/x", branch: "feature/billing-3" });
  assert.deepEqual(calls.map((call) => call.options.branch), ["feature/billing-3"]);
  assert.equal(warnings[0].message, "rebranching task acquisition onto a fresh branch");
  assert.equal(warnings[0].fields.reason, WORKTREE_REASONS.FOREIGN_COMMITS);

  const error = await acquireTaskWorktree(options).catch((value) => value);
  assert.equal(error, cause);
  assert.equal(error.effectiveBranch, "feature/billing-3");
  assert.equal(error.fallbackReason, WORKTREE_REASONS.FOREIGN_COMMITS);
  assert.equal(error.reason, undefined, "a plain error is not given an invented worktree reason");
});

test("acquisition wraps non-Error refusals and frozen errors without losing the branch context", async () => {
  const { worktrees } = fakeWorktrees([Object.freeze(new Error("frozen"))]);
  const { git } = fakeGit();
  const error = await acquireTaskWorktree({ worktrees, repositoryId: REPO, repositoryPath: PATH, branch: "feature/x", base: "main", git }).catch((value) => value);
  assert.equal(error instanceof TypeError, true, "a frozen cause is wrapped so context can be attached");
  assert.equal(error.message, "frozen");
  assert.equal(error.cause.message, "frozen");
  assert.equal(error.effectiveBranch, "feature/x");

  const throwingString = { create: async () => { throw "not an error"; } };
  const wrapped = await acquireTaskWorktree({ worktrees: throwingString, repositoryId: REPO, repositoryPath: PATH, branch: "feature/x", base: "main", git }).catch((value) => value);
  assert.equal(wrapped instanceof TypeError, true);
  assert.equal(wrapped.message, "not an error");
  assert.equal(wrapped.effectiveBranch, "feature/x");
});

test("launch reason and effective branch helpers only trust well-formed causes", () => {
  assert.equal(launchReason({ reason: WORKTREE_REASONS.LOCKED }), WORKTREE_REASONS.LOCKED);
  assert.equal(launchReason({ reason: "made-up" }), null);
  assert.equal(launchReason(null), null);
  assert.equal(effectiveTaskBranch({ effectiveBranch: "feature/x-2" }, "feature/x"), "feature/x-2");
  assert.equal(effectiveTaskBranch({ effectiveBranch: "" }, "feature/x"), "feature/x");
  assert.equal(effectiveTaskBranch(undefined, "feature/x"), "feature/x");
});
