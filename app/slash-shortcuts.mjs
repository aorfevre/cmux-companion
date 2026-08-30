const SHORTCUTS = [
  { command: "/status", description: "Show session, model, and context status", agents: ["Codex", "Claude"] },
  { command: "/review", description: "Review the current code changes", agents: ["Codex", "Claude"] },
  { command: "/compact", description: "Summarize context and keep working", agents: ["Codex", "Claude"] },
  { command: "/plan", description: "Switch into planning mode", agents: ["Codex", "Claude"] },
  { command: "/model", description: "Choose the model for this session", agents: ["Codex", "Claude"] },
  { command: "/permissions", description: "Inspect or change tool permissions", agents: ["Codex", "Claude"] },
  { command: "/diff", description: "Show the working Git diff", agents: ["Codex"] },
  { command: "/new", description: "Start a fresh conversation", agents: ["Codex"] },
  { command: "/resume", description: "Resume a saved session", agents: ["Codex"] },
  { command: "/clear", description: "Clear conversation history", agents: ["Claude"] },
  { command: "/cost", description: "Show token usage and cost", agents: ["Claude"] },
  { command: "/memory", description: "Open project memory instructions", agents: ["Claude"] },
  { command: "/help", description: "Ask the active agent for its complete command list", agents: ["Codex", "Claude"] },
];

export function slashShortcuts(draft = "") {
  const trimmed = String(draft).trimStart();
  const query = trimmed.startsWith("/") ? trimmed.slice(1).toLowerCase() : "";
  return SHORTCUTS.filter((shortcut) => (
    !query
    || shortcut.command.slice(1).includes(query)
    || shortcut.description.toLowerCase().includes(query)
  ));
}

export { SHORTCUTS };
