// Shared pure board and API health accounting.
export function isStuck(health) {
  return health === "dead" || health === "idle" || health === "failed";
}

export function summarize(goals) {
  const summary = emptySummary();
  for (const goal of goals) {
    summary.goals += 1;
    if (isStuck(goal.health)) summary.stuck += 1;
    if (goal.health === "needs_you") summary.needsYou += 1;
    if (goal.health === "working") summary.working += 1;
    for (const task of goal.tasks) {
      summary.tasks += 1;
      if (task.health === "dead") summary.deadTasks += 1;
      if (task.health === "idle") summary.idleTasks += 1;
      if (task.health === "failed") summary.failedTasks += 1;
    }
  }
  return summary;
}

export function emptySummary() {
  return { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 };
}

export function firstReason(goal) {
  const parts = [...(goal?.tasks || []), ...(goal?.merge ? [goal.merge] : [])];
  return parts.find((part) => part.health === goal?.health)?.reason || null;
}
