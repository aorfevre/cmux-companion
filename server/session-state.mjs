// Shared session badges for the terminal and worktree views.
export function sessionState(workspace) {
  if (workspace.has_unread || workspace.status?.signals?.any_agent_needs_input) return { label: "Needs you", tone: "attention" };
  if (workspace.status?.effective === "working" || workspace.status?.signals?.any_agent_running) return { label: "Working", tone: "working" };
  if (workspace.status?.effective === "done") return { label: "Done", tone: "done" };
  return { label: "Ready", tone: "ready" };
}
