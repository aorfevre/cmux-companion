import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NATIVE_TOOLS, BRIDGE_TOOLS } from './ccs.mjs';

/** Native restricted mode confines file tools to the worktree. This hook denies
 * extra tools even if a repository prompt, MCP registration or resumed session
 * asks for them. It never grants permissions or changes native approval policy.
 * @param {unknown} event @param {unknown} role */
export function roleToolHook(event, role) {
  const input = /** @type {{ hook_event_name?: unknown; tool_name?: unknown }} */ (event ?? {});
  const known = typeof role === 'string' && Object.hasOwn(NATIVE_TOOLS, role);
  const allowed = known ? [...NATIVE_TOOLS[/** @type {keyof typeof NATIVE_TOOLS} */ (role)], ...BRIDGE_TOOLS[/** @type {keyof typeof BRIDGE_TOOLS} */ (role)]] : [];
  if (input.hook_event_name === 'PreToolUse' && typeof input.tool_name === 'string' && allowed.includes(input.tool_name)) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Tool is outside this recorded orchestration role.' } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let input = '', oversized = false;
  for await (const chunk of process.stdin) {
    if (Buffer.byteLength(input) + chunk.length > 256 * 1024) { oversized = true; break; }
    input += chunk.toString('utf8');
  }
  try {
    if (oversized) throw new Error('Hook input exceeds limit');
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(roleToolHook(JSON.parse(input), config.role)));
  } catch { process.exitCode = 2; }
}
