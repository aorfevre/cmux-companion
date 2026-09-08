import { mergeSessionTitle, sessionTitle, projectCode, taskCode, partCode } from "./session-name.mjs";

// Restoring cmux can leave a workspace with a new UUID. Recover only a unique
// goal/task match corroborated by both its exact checkout path and Companion
// title. Never infer completion from the title, age, or a clean checkout.
export function restoredGoalSessions(plans, workspaces) {
  const recorded = new Set(plans.flatMap((p) => [
    p.goalSessionWorkspaceId, p.mergeWorkspaceId, p.reviewWorkspaceId, ...(p.tasks || []).map((t) => t.workspaceId),
    ...(p.supersededMergeWorkspaces || []).map((w) => w.workspaceId),
    ...(p.followups || []).map((w) => w.workspaceId),
  ]).filter(Boolean).map((id) => id.toLowerCase()));
  return workspaces.filter((w) => !recorded.has(w.id.toLowerCase())).map((workspace) => {
    const activeOwner = plans.find((plan) => plan.workflow === "goal_session" && !["merged", "aborted"].includes(plan.boardStatus) && (plan.goalType === "analysis" || String(plan.boardPrState).toUpperCase() !== "MERGED") && plan.goalSessionWorktreePath === workspace.current_directory);
    if (activeOwner) return { workspaceId: workspace.id, title: workspace.title, kind: "restored", taskId: null,
      planId: activeOwner.planId, path: workspace.current_directory, eligible: false,
      reason: "The goal conversation stays open for review and corrections" };
    const matches = [];
    for (const plan of plans) {
      const path = workspace.current_directory;
      if (typeof workspace.title !== "string" || !path || !path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) continue;
      const code = projectCode(plan.repositoryName);
      if (path === plan.integrationWorktreePath && (
        workspace.title === mergeSessionTitle(plan) || workspace.title.startsWith(code + "-MERGE · ")
      )) matches.push({ plan, task: null });
      (plan.tasks || []).forEach((task, index) => {
        const legacy = code + "-" + taskCode(task.id, index) + "-" + partCode(task.type) + " · ";
        if (path === task.worktreePath && (workspace.title === sessionTitle(plan, task) || workspace.title.startsWith(legacy))) {
          matches.push({ plan, task });
        }
      });
    }
    const match = matches.length === 1 ? matches[0] : null;
    const plan = match?.plan;
    const delivered = plan && (plan.boardStatus === "merged" || plan.boardPrState === "MERGED" ||
      plan.boardPrState === "OPEN" || plan.deliveryStatus === "pr_open" || plan.finalPrUrl ||
      match.task?.deliveryStatus === "integrated");
    return {
      workspaceId: workspace.id, title: workspace.title, kind: "restored", taskId: null,
      planId: plan?.planId || null, path: workspace.current_directory,
      eligible: Boolean(delivered),
      reason: !match ? "No unique stored goal matches this workspace's path and Companion title"
        : !delivered ? "The matching goal or task has no recorded delivery evidence"
          : "Restored workspace matches a delivered goal by checkout path and Companion title",
    };
  });
}

export function restoredSessionProtection(workspace) {
  const signals = workspace?.status?.signals;
  if (!signals || signals.any_agent_running !== false || signals.any_agent_needs_input !== false) {
    return "Agent activity is running, awaiting input, or unknown";
  }
  if (workspace.status.effective === "working" || signals.is_git_dirty !== false) {
    return "Workspace is working or its checkout is dirty or unknown";
  }
  return null;
}
