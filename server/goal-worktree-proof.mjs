import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { git } from "./worktree-inventory.mjs";

const queryPr = async (cwd, number) => JSON.parse((await promisify(execFile)("gh", ["pr", "view", String(number), "--json", "number,url,state,headRefOid,headRefName,baseRefName,mergeCommit"], { cwd, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
// A merged goal PR is the worktree cleanup boundary. The durable
// plan identifies the paths; Git and GitHub must independently confirm the
// exact commits. Titles, path prefixes and a clean status are never proof.
export async function goalWorktreeProof(repo, row, plans, { readPr = queryPr } = {}) {
  for (const plan of plans) {
    const number = plan.finalPrNumber || plan.boardPrNumber;
    if (!number || plan.status !== "launched" || plan.boardStatus === "aborted") continue;
    const task = plan.tasks?.find((item) => item.worktreePath === row.path && item.launchStatus === "launched");
    const integration = plan.integrationWorktreePath === row.path;
    if (!task && !integration) continue;
    try {
      const common = (await git(plan.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      if (await realpath(common) !== repo.common) continue;
      const pr = await readPr(repo.path, number);
      const expectedBranch = plan.deliveryMode === "combined" ? plan.integrationBranch : task?.branch;
      if (pr.state !== "MERGED" || !pr.headRefOid || !pr.mergeCommit?.oid || pr.headRefName !== expectedBranch) continue;
      if (pr.baseRefName !== String(plan.baseRef || "origin/main").replace(/^origin\//, "")) continue;
      const url = plan.finalPrUrl || plan.boardPrUrl;
      if (url && pr.url !== url) continue;
      if (integration || plan.deliveryMode !== "combined") {
        if (row.head !== pr.headRefOid || row.branch !== pr.headRefName) continue;
      } else {
        if (task.headSha !== row.head || task.deliveryStatus !== "integrated" || task.branch !== row.branch) continue;
        // Combined delivery squash-merges task commits. Its verified trailer
        // is the pipeline's durable identity for the exact integrated task.
        const log = await git(repo.path, ["log", "--format=%B", "--fixed-strings", `--grep=Cmux-Goal-Task: ${plan.planId}/${task.id}/${row.head}`, pr.headRefOid]);
        if (!log.split("\n").includes(`Cmux-Goal-Task: ${plan.planId}/${task.id}/${row.head}`)) continue;
      }
      return { proven: true, immediate: true, reason: `Goal PR #${number} is merged; this exact work is delivered${task && plan.deliveryMode === "combined" ? " and integrated" : ""}`, url: pr.url, planId: plan.planId, prHead: pr.headRefOid };
    } catch { /* Unavailable or changed evidence preserves the worktree. */ }
  }
  return null;
}
