import { fileURLToPath } from "node:url";

// Review workers have no Companion approval capability and no writable tools.
// Unknown hooks/tools fail closed, including tools supplied by an MCP server.
export function reviewHook(event) {
  if (event.hook_event_name !== "PreToolUse" || !["Read", "Grep", "Glob"].includes(event.tool_name)) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Independent reviewers are repository-read-only; only Read, Grep and Glob are available." } };
  }
  return {};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 256 * 1024) process.exit(2); }
  try { process.stdout.write(JSON.stringify(reviewHook(JSON.parse(input)))); }
  catch { process.exitCode = 2; }
}
