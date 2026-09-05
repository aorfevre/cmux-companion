import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { plainPath, withWorkspaceLaunch } from "./worktree-operations.mjs";
import { parseCompletionReport, validateCompletionReport } from "./delivery-contract.mjs";

const execute = promisify(execFile);
const git = async (cwd, args) => (await execute("git", ["-C", cwd, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();

// Recovery only: no checkout creation, branch changes, agent prompts or delivery
// state shortcuts. The normal integrator still validates readiness afterward.
export async function inspectTaskAssociation({ store, cmux, planId, taskId, workspaceId }) {
  const plan = store.get(planId);
  const task = plan?.tasks.find((item) => item.id === taskId);
  if (!plan || plan.status !== "launched" || plan.boardStatus || plan.finalPrUrl ||
      !task || task.launchStatus !== "failed" || task.workspaceId || task.worktreePath) {
    throw new Error("Expected an unassociated failed task in an unfinished goal");
  }
  const workspaces = (await cmux.workspaceList()).workspaces;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace?.current_directory) throw new Error("Workspace is missing or has no checkout");
  const path = workspace.current_directory;
  if (workspaces.filter((item) => item.current_directory === path).length !== 1) {
    throw new Error("Multiple live workspaces use this checkout");
  }
  await plainPath(path);
  const root = await realpath(plan.cwd);
  if (await git(path, ["rev-parse", "--show-toplevel"]) !== path ||
      await realpath(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
      await realpath(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) {
    throw new Error("Checkout belongs to a different repository");
  }
  const status = await cmux.workspaceStatus(workspaceId);
  if (status?.signals?.any_agent_running !== false || status?.signals?.any_agent_needs_input !== false ||
      status.effective === "working") throw new Error("Agent is active or its activity is unknown");
  if (await git(path, ["branch", "--show-current"]) !== task.branch) throw new Error("Checkout branch does not match the task");
  if (await git(path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Checkout has uncommitted work");
  const headSha = await git(path, ["rev-parse", "HEAD"]);
  const message = await git(path, ["log", "-1", "--format=%B"]);
  if (!message.split("\n").some((line) => line.trim() === `Cmux-Goal-Ready: ${planId}/${taskId}`)) {
    throw new Error("HEAD lacks the exact goal/task delivery identity");
  }
  const base = task.startSha || plan.baseSha;
  if (!base || Number(await git(path, ["rev-list", "--count", `${base}..${headSha}`])) < 1) throw new Error("Task has no commits beyond its launch base");
  if ((await git(path, ["ls-remote", "origin", `refs/heads/${task.branch}`])).split(/\s+/)[0] !== headSha) {
    throw new Error("Task HEAD is not pushed to its remote branch");
  }
  if ((plan.contractVersion || 1) >= 2) {
    const parsed = parseCompletionReport(message);
    const valid = validateCompletionReport(task, parsed.report);
    if (parsed.error || !valid.ready) throw new Error(parsed.error || valid.errors.join("; "));
  }
  return { planId, taskId, workspaceId, path, branch: task.branch, headSha };
}

export async function applyTaskAssociation(options, expected) {
  return withWorkspaceLaunch(expected.path, async () => {
    const verified = await inspectTaskAssociation(options);
    if (JSON.stringify(verified) !== JSON.stringify(expected)) throw new Error("Candidate changed since review");
    return options.store.recordTaskAssociation(verified.planId, verified.taskId, verified);
  });
}
