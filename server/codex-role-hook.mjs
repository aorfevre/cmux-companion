import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const readers = ['mcp__files__list_files', 'mcp__files__read_file'];
const bridge = {
  planner: ['mcp__companion__get_status', 'mcp__companion__submit_result', 'request_user_input'],
  reviewer: [],
  implementer: ['mcp__companion__get_status', 'mcp__companion__commit_candidate', 'mcp__files__write_file'],
  integrator: ['mcp__companion__get_status', 'mcp__companion__commit_candidate', 'mcp__files__write_file'],
};
export function codexToolHook(event, role) {
  const allowed = Object.hasOwn(bridge, role) ? [...readers, ...bridge[role]] : [];
  if (event?.hook_event_name === 'PreToolUse' && allowed.includes(event.tool_name)) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Use only the scoped tools for this orchestration role.' } };
}
export function recordCodexSession(event, config) {
  if (event.hook_event_name !== 'SessionStart' || !/^[A-Za-z0-9_-]{1,160}$/.test(event.session_id)) throw new Error('Invalid native session');
  const value = { conversationId: config.conversationId, sessionId: event.session_id };
  const path = join(config.directory, 'codex-session.json');
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== JSON.stringify(value)) throw new Error('Native session identity changed');
  } else writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  return {};
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 262144) throw new Error('Oversized hook'); }
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8')), event = JSON.parse(input);
    process.stdout.write(JSON.stringify(event.hook_event_name === 'SessionStart' ? recordCodexSession(event, config) : codexToolHook(event, config.role)));
  } catch { process.exitCode = 2; }
}
