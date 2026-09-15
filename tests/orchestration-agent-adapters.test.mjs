import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ccsCommand, nativeResult, requireNativeCapabilities, NATIVE_TOOLS, BRIDGE_TOOLS } from '../server/orchestration/adapters/ccs.mjs';
import { parseRoleResult } from '../server/orchestration/domain/role-result.mjs';
import { roleToolHook } from '../server/orchestration/adapters/agent-tool-hook.mjs';
const conversationId = 'e7be1651-cb20-41e0-b658-c2d42c1d2c9f';
const capabilities = { restricted: true, manualPermissions: true, hooks: true, strictMcp: true, streamJson: true, permissionPromptsNone: true, terminal: true };
const command = (role, changes = {}) => ({ request: { operationId: 'operation', goalId: 'goal', attempt: { role, mode: role === 'planner' ? 'interactive' : 'background', worktree: '/tmp/owned', conversationId } }, engine: { provider: 'default', model: 'configured-model', effort: 'high' }, capabilities, env: {}, contextPath: '/tmp/private/context.json', settingsPath: '/tmp/private/settings.json', mcpPath: '/tmp/private/mcp.json', ...changes });

test('native role argv preserves interactive permissions and bounds background capabilities', () => {
  for (const role of Object.keys(NATIVE_TOOLS)) {
    const argv = ccsCommand(command(role));
    assert.equal(argv[argv.indexOf('--target') + 1], 'claude');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'manual');
    assert.ok(argv.includes('--restricted')); assert.ok(argv.includes('--strict-mcp-config'));
    assert.ok(argv.includes('--settings=/tmp/private/settings.json'));
    assert.equal(argv.includes('--print'), role !== 'planner');
    assert.equal(argv.includes('--permission-prompts'), role !== 'planner');
    assert.ok(!argv.includes('--dangerously-skip-permissions'));
    for (const tool of ['Bash', 'Task', 'Agent', 'WebFetch', 'mcp__companion__approve']) assert.ok(!argv[argv.indexOf('--allowed-tools') + 1].split(',').includes(tool));
    assert.deepEqual(argv[argv.indexOf('--tools') + 1].split(','), NATIVE_TOOLS[role]);
  }
  const options = command('planner'); options.request.attempt.identity = 'owned-terminal'; options.resume = true;
  const resume = ccsCommand(options); assert.ok(resume.includes('--resume')); assert.ok(!resume.includes('--session-id'));
  assert.throws(() => ccsCommand(command('reviewer', { resume: true })), { code: 'NOT_READY' });
});

test('unsupported native modes and permission-disabling environment fail before launch', () => {
  for (const capability of ['restricted', 'manualPermissions', 'hooks', 'strictMcp', 'streamJson', 'permissionPromptsNone']) assert.throws(() => requireNativeCapabilities({ ...capabilities, [capability]: false }, 'reviewer', 'background'), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => requireNativeCapabilities({ ...capabilities, terminal: false }, 'planner', 'interactive'), { code: 'UNSUPPORTED_CAPABILITY' });
  for (const name of ['CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_BARE', 'CLAUDE_CODE_DISABLE_HOOKS', 'CLAUDE_CODE_SKIP_PERMISSIONS']) {
    assert.throws(() => ccsCommand(command('implementer', { env: { [name]: 'private-secret' } })), (error) => error.code === 'UNSUPPORTED_CAPABILITY' && !error.message.includes('private-secret'));
  }
  assert.throws(() => ccsCommand(command('planner', { engine: { provider: '--unsafe', model: 'model' } })));
});

test('native hook denies role mutation, delegation and unscoped tools without granting permission', () => {
  for (const role of Object.keys(NATIVE_TOOLS)) {
    for (const tool of [...NATIVE_TOOLS[role], ...BRIDGE_TOOLS[role]]) assert.deepEqual(roleToolHook({ hook_event_name: 'PreToolUse', tool_name: tool }, role), {});
    for (const tool of ['Bash', 'Agent', 'Task', 'mcp__other__execute', 'mcp__companion__approve']) assert.equal(roleToolHook({ hook_event_name: 'PreToolUse', tool_name: tool }, role).hookSpecificOutput.permissionDecision, 'deny');
  }
  for (const role of ['reviewer', 'planner']) for (const tool of ['Edit', 'Write', 'mcp__companion__commit_candidate']) assert.equal(roleToolHook({ hook_event_name: 'PreToolUse', tool_name: tool }, role).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(roleToolHook({ hook_event_name: 'Stop', tool_name: 'Read' }, 'reviewer').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(roleToolHook({}, 'unknown').hookSpecificOutput.permissionDecision, 'deny');
});

test('native hook subprocess fails closed on malformed or oversized input and omits private config', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orchestration-native-hook-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify({ role: 'reviewer', secret: 'private-secret' }), { mode: 0o600 });
  const invoke = (input) => new Promise((resolve) => {
    const child = execFile(process.execPath, ['server/orchestration/adapters/agent-tool-hook.mjs', path], { timeout: 5000, maxBuffer: 4096 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  const denied = await invoke(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write' }));
  assert.equal(denied.code, 0); assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!JSON.stringify(denied).includes('private-secret'));
  for (const input of ['invalid', 'x'.repeat(300000)]) { const failed = await invoke(input); assert.equal(failed.code, 2); assert.equal(failed.stdout, ''); }
});

test('native output requires one successful structured result for the exact conversation', () => {
  const record = { type: 'result', subtype: 'success', is_error: false, session_id: conversationId, result: JSON.stringify({ schemaVersion: 1, output: {} }) };
  assert.equal(nativeResult(`${JSON.stringify({ type: 'system' })}\n${JSON.stringify(record)}\n`, conversationId), record.result);
  for (const changed of [{ ...record, session_id: 'other' }, { ...record, is_error: true }, { ...record, subtype: 'error' }, { ...record, result: 'prose' }, { ...record, result: '[]' }]) assert.throws(() => nativeResult(JSON.stringify(changed), conversationId));
  assert.throws(() => nativeResult(`${JSON.stringify(record)}\n${JSON.stringify(record)}`, conversationId));
  assert.throws(() => nativeResult('x'.repeat(2 * 1024 * 1024 + 1), conversationId), { code: 'INVALID_RESULT' });
});

test('CCS startup banner and one fenced reviewer result retain the exact review and identity', () => {
  const attempt = { id: 'attempt', operationId: 'operation', role: 'reviewer', generation: 2, revision: 1, target: 'contract:2:1' };
  const output = { schemaVersion: 1, target: attempt.target, disposition: 'request_changes', findings: [{ id: 'duplicate-image', severity: 'high', blocking: true, title: 'Duplicate image intake', evidence: 'Both clipboard collections contain the same image.', suggestion: 'Use one collection.' }] };
  const envelope = { schemaVersion: 1, goalId: 'goal', attemptId: attempt.id, operationId: attempt.operationId, generation: 2, revision: 1, role: 'reviewer', target: attempt.target, output };
  const raw = JSON.stringify(envelope);
  const record = { type: 'result', subtype: 'success', is_error: false, session_id: conversationId, result: ['Review complete.', '', '```json', raw, '```'].join('\n') };
  const stream = '[i] Joined existing CLIProxy on port 8317 (http)\n' + JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + JSON.stringify(record);
  const result = nativeResult(stream, conversationId);
  assert.equal(nativeResult(stream.replaceAll('\n', '\r\n'), conversationId), result);
  assert.equal(nativeResult(JSON.stringify({ ...record, result: ['```json', raw, '```', 'Review complete.'].join('\n') }), conversationId), result);
  assert.deepEqual(parseRoleResult(JSON.parse(result), { goalId: 'goal', attempt }).output, output);
  assert.throws(() => parseRoleResult(JSON.parse(result), { goalId: 'goal', attempt: { ...attempt, id: 'other' } }), { code: 'FORBIDDEN' });
  assert.throws(() => parseRoleResult(JSON.parse(result), { goalId: 'goal', attempt: { ...attempt, revision: 2 } }), { code: 'STALE_TARGET' });
  assert.throws(() => parseRoleResult({ ...envelope, output: { ...output, disposition: 'accept' } }, { goalId: 'goal', attempt }));
  assert.throws(() => parseRoleResult({ ...envelope, output: { ...output, findings: [{ ...output.findings[0], severity: 'info' }] } }, { goalId: 'goal', attempt }));
});

test('CCS normalization rejects ambiguous, malformed and unsuccessful output', () => {
  const raw = '{"schemaVersion":1,"output":{}}';
  const fence = ['```json', raw, '```'].join('\n');
  const record = { type: 'result', subtype: 'success', is_error: false, session_id: conversationId, result: fence };
  for (const result of [fence + '\n' + fence, raw + '\n' + fence, fence + '\n{}', 'Earlier {}\n' + fence, 'Inline ' + fence, '```json\n{broken}\n```', '```json\n[]\n```', '```json\nnull\n```', '```text\n' + raw + '\n```', '```json\n' + raw, 'PASS']) {
    assert.throws(() => nativeResult(JSON.stringify({ ...record, result }), conversationId));
  }
  for (const prefix of ['unexpected diagnostic\n', '[i] anything else\n', '{malformed}\n', '[i] Joined existing CLIProxy on port 8317 (http)\n'.repeat(2)]) {
    assert.throws(() => nativeResult(prefix + JSON.stringify(record), conversationId));
  }
  assert.throws(() => nativeResult(JSON.stringify({ type: 'system' }) + '\n[i] Joined existing CLIProxy on port 8317 (http)\n' + JSON.stringify(record), conversationId));
  assert.throws(() => nativeResult(JSON.stringify({ type: 'assistant', result: raw }), conversationId));
  for (const change of [{ session_id: 'other' }, { is_error: true }, { subtype: 'error' }]) assert.throws(() => nativeResult(JSON.stringify({ ...record, ...change }), conversationId));
  assert.throws(() => nativeResult(JSON.stringify(record) + '\n' + JSON.stringify(record), conversationId));
});
