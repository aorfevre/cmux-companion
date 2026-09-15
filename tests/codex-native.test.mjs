import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeNativeCapabilities } from '../server/orchestration/adapters/native-capabilities.mjs';
import { CodexInputs, codexResult } from '../server/codex-native.mjs';
import { codexToolHook, recordCodexSession } from '../server/codex-role-hook.mjs';
import { scopedFile, fileTools } from '../server/codex-files.mjs';
const caps = { restricted: true, manualPermissions: true, hooks: true, strictMcp: true, streamJson: true, permissionPromptsNone: true, terminal: true };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-')));
  const worktree = join(root, 'worktree'), privatePath = join(root, 'private'); mkdirSync(worktree); mkdirSync(privatePath);
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); rmSync(root, { recursive: true, force: true }); });
  return { root, worktree, privatePath, closers };
}
test('Codex metadata probes only the pinned native executable and supports direct launch', async t => {
  const { root } = fixture(t), bin = join(root, 'codex');
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version') ? 'codex-cli 0.154.0' : '--config --sandbox --ask-for-approval --strict-config --dangerously-bypass-hook-trust');`, { mode: 0o700 });
  const installation = await probeNativeCapabilities({ ccsBin: bin, claudeBin: bin, direct: true, provider: 'codex' });
  assert.equal(installation.identity.provider, 'codex'); assert.equal(installation.env.CCS_CODEX_PATH, bin);
  assert.equal(installation.evidence.codexVersion, '0.154.0');
  writeFileSync(bin, '#!/bin/sh\necho unsupported\n');
  assert.throws(() => installation.assertCurrent(), { code: 'UNSUPPORTED_CAPABILITY' });
  await assert.rejects(probeNativeCapabilities({ ccsBin: bin, claudeBin: bin, direct: true, provider: 'codex' }), { code: 'UNSUPPORTED_CAPABILITY' });
});
test('Codex inputs isolate config, deny shell/hosted tools and generate native argv for both launch modes', async t => {
  const { root, worktree } = fixture(t);
  for (const kind of ['ccs', 'direct', 'ccsxp']) for (const role of ['planner', 'reviewer', 'implementer', 'integrator']) {
    const direct = kind === 'direct', ccsxp = kind === 'ccsxp';
    const directory = join(root, `${role}-${kind}`); mkdirSync(directory);
    const request = { goalId: 'goal', operationId: 'op', attempt: { id: 'attempt', generation: 0, revision: 0, role, mode: role === 'planner' ? 'interactive' : 'background', conversationId: '00000000-0000-4000-8000-000000000001', worktree, target: null } };
    const inputs = new CodexInputs({ direct, ccsxp, capabilities: caps, engine: { provider: 'codex', model: 'default' }, env: { HOME: root }, describe: () => ({ prompt: 'Pinned scope', bridge: { endpoint: 'http://127.0.0.1:1234', credential: 'c'.repeat(48) } }) });
    const result = await inputs.prepare(request, directory);
    assert.equal(result.argv.includes('--target'), !direct && !ccsxp);
    if (ccsxp) { assert.equal(result.env.CCSXP_CODEX_HOME, result.env.CODEX_HOME); assert.equal(result.argv[0], '--strict-config'); }
    assert.equal(result.argv.includes('exec'), role !== 'planner');
    assert.equal(result.argv.includes('--json'), role !== 'planner');
    if (role === 'planner') { assert.match(result.argv.at(-1), /companion.submit_result with \{id,output/); assert.doesNotMatch(result.argv.at(-1), /Return the required JSON role envelope/); }
    else assert.match(result.argv.at(-1), /Return the required JSON role envelope/);
    assert.equal(result.argv.includes('--session-id'), false);
    assert.equal(result.argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.equal(result.env.CODEX_HOME, join(directory, 'codex-home'));
    const config = readFileSync(join(result.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(config, /sandbox_mode = "read-only"/); assert.match(config, /features.shell_tool = false/);
    assert.match(config, /trust_level = "untrusted"/); assert.match(config, /web_search = "disabled"/);
    assert.equal(config.includes('[mcp_servers.companion]'), true);
    assert.equal((config.match(/default_tools_approval_mode = "approve"/g) || []).length, 2);
    assert.equal(config.includes('c'.repeat(48)), false);
    assert.deepEqual(await inputs.prepare(request, directory), result);
  }
});
test('role hook denies all non-scoped tool paths including shell, native patch, agents and extra MCP servers', () => {
  for (const role of ['planner', 'reviewer', 'implementer', 'integrator']) {
    assert.deepEqual(codexToolHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__files__read_file' }, role), {});
    for (const tool_name of ['Bash', 'exec_command', 'apply_patch', 'spawn_agent', 'mcp__other__run', 'view_image']) {
      assert.equal(codexToolHook({ hook_event_name: 'PreToolUse', tool_name }, role).hookSpecificOutput.permissionDecision, 'deny');
    }
    assert.equal(Boolean(codexToolHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__files__write_file' }, role).hookSpecificOutput), ['planner', 'reviewer'].includes(role));
  }
  assert.ok(codexToolHook({}, 'unknown').hookSpecificOutput);
});
test('Codex results and resume bind to the native session recorded by the owned hook', t => {
  const { privatePath } = fixture(t);
  const config = { directory: privatePath, conversationId: 'conversation' }, event = { hook_event_name: 'SessionStart', session_id: 'native-session' };
  recordCodexSession(event, config); recordCodexSession(event, config);
  assert.throws(() => recordCodexSession({ ...event, session_id: 'other' }, config));
  const rows = [{ type: 'thread.started', thread_id: 'native-session' }, { type: 'item.completed', item: { type: 'agent_message', text: '{"result":"reviewed"}' } }, { type: 'turn.completed' }];
  const output = () => rows.map(row => JSON.stringify(row)).join('\n');
  assert.equal(codexResult(output(), 'conversation', privatePath), '{"result":"reviewed"}');
  rows[0].thread_id = 'other'; assert.throws(() => codexResult(output(), 'conversation', privatePath));
  assert.throws(() => codexResult('not-json', 'conversation', privatePath));
});
test('scoped files reject traversal, symlinks, Git metadata and writes by readers, with exact content checks', t => {
  const { worktree, root } = fixture(t), config = { root: worktree, role: 'implementer' };
  writeFileSync(join(root, 'private.txt'), 'private'); symlinkSync(root, join(worktree, 'escape'));
  const written = scopedFile(config, 'write_file', { path: 'src/new.txt', content: 'first', expectedSha256: null });
  assert.equal(scopedFile(config, 'read_file', { path: 'src/new.txt' }).content, 'first');
  assert.throws(() => scopedFile(config, 'write_file', { path: 'src/new.txt', content: 'stale', expectedSha256: null }));
  scopedFile(config, 'write_file', { path: 'src/new.txt', content: 'second', expectedSha256: written.sha256 });
  for (const path of ['../private.txt', 'escape/private.txt', '.git/config', '/etc/passwd']) {
    assert.throws(() => scopedFile(config, 'read_file', { path }));
    assert.throws(() => scopedFile(config, 'write_file', { path, content: 'no', expectedSha256: null }));
  }
  assert.throws(() => scopedFile({ ...config, role: 'reviewer' }, 'write_file', { path: 'no', content: '', expectedSha256: null }));
  assert.deepEqual(scopedFile(config, 'list_files', { path: '.' }).entries.map(entry => entry.name), ['src']);
  assert.equal(fileTools('reviewer').some(tool => tool.name === 'write_file'), false);
  assert.equal(readFileSync(join(root, 'private.txt'), 'utf8'), 'private');
});

test('a supervised Codex process delivers its native stream once and reconciles after restart', async t => {
  const { root, worktree, closers } = fixture(t);
  const { NativeBackground } = await import('../server/orchestration/adapters/native-background.mjs');
  const { setTimeout: delay } = await import('node:timers/promises');
  const bin = join(root, 'codex-fixture'), release = join(root, 'release');
  const hookUrl = new URL('../server/codex-role-hook.mjs', import.meta.url).href;
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
(async () => {
 const {recordCodexSession} = await import(${JSON.stringify(hookUrl)});
 const directory = path.dirname(process.env.CODEX_HOME);
 const config = JSON.parse(fs.readFileSync(path.join(directory,'codex-hook.json'),'utf8'));
 recordCodexSession({hook_event_name:'SessionStart',session_id:'recorded-native-session'},config);
 const timer = setInterval(() => {
   if (!fs.existsSync(${JSON.stringify(release)})) return;
   clearInterval(timer);
   for (const row of [{type:'thread.started',thread_id:'recorded-native-session'}, {type:'item.completed',item:{type:'agent_message',text:'{"review":"accepted"}'}}, {type:'turn.completed'}]) process.stdout.write(JSON.stringify(row)+'\\n');
 },10);
})();`, { mode: 0o700 });
  const inputs = new CodexInputs({ direct: true, capabilities: caps, engine: { provider: 'codex', model: 'default' }, env: { HOME: root, PATH: process.env.PATH }, describe: () => ({ prompt: 'Review the exact pinned work', bridge: { endpoint: 'http://127.0.0.1:1', credential: 'c'.repeat(48) } }) });
  const delivered = [];
  const options = { directory: join(root, 'runtime'), bin, inputs, parseResult: codexResult, policy: { ceilingMs: 10000, idleMs: 5000, maxOutputBytes: 10000, killGraceMs: 200 }, onResult: (_request, raw) => { delivered.push(raw); } };
  const driver = new NativeBackground(options);
  closers.push(() => driver.close());
  const request = { goalId: 'goal', operationId: 'op', attempt: { id: 'attempt', operationId: 'op', generation: 1, revision: 1, role: 'reviewer', mode: 'background', conversationId: '00000000-0000-4000-8000-000000000001', worktree, target: 'a'.repeat(40), baseSha: 'a'.repeat(40), branch: 'companion/goal/review' } };
  const launched = await driver.launch(request);
  assert.equal((await driver.observe('op')).identity, launched.identity);
  writeFileSync(release, 'go');
  const deadline = Date.now() + 5000;
  while (delivered.length === 0 && Date.now() < deadline) await delay(20);
  assert.deepEqual(delivered, ['{"review":"accepted"}']);
  await driver.close();
  const reopened = new NativeBackground(options); closers.push(() => reopened.close());
  assert.equal((await reopened.observe('op')).status, 'stopped');
  await reopened.deliver('op'); assert.equal(delivered.length, 1);
});

test('scoped MCP stdio negotiates tools and refuses out-of-worktree requests', t => {
  const { root, worktree } = fixture(t);
  const config = join(root, 'files.json'); writeFileSync(config, JSON.stringify({ root: worktree, role: 'implementer' }));
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'new.txt', content: 'scoped', expectedSha256: null } } },
    { id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'new.txt' } } },
    { id: 5, method: 'tools/call', params: { name: 'read_file', arguments: { path: '../files.json' } } },
  ];
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../server/codex-files.mjs', import.meta.url)), config], { input: messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.id), [1, 2, 3, 4, 5]);
  assert.equal(rows[0].result.serverInfo.name, 'companion-files');
  assert.ok(rows[1].result.tools.some(tool => tool.name === 'write_file'));
  assert.equal(JSON.parse(rows[3].result.content[0].text).content, 'scoped');
  assert.equal(rows[4].result.isError, true);
});


test('protected metadata aliases stay inaccessible in a real linked worktree', t => {
  const { root, worktree } = fixture(t);
  const repository = join(root, 'repository'); mkdirSync(repository);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repository, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe',
  });
  git(['init']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  git(['worktree', 'add', '--detach', worktree]);
  const metadata = readFileSync(join(worktree, '.git'), 'utf8');
  mkdirSync(join(worktree, '.codex')); writeFileSync(join(worktree, '.codex', 'config.toml'), 'private');
  mkdirSync(join(worktree, '.companion')); writeFileSync(join(worktree, '.companion', 'state'), 'private');
  for (const role of ['planner', 'reviewer', 'implementer', 'integrator']) {
    const config = { root: worktree, role };
    for (const path of ['.git', '.GIT', '.GiT', '.g\u200cit', '.ＣＯＤＥＸ/config.toml', '.CoDeX/config.toml', '.COMPANION/state']) {
      assert.throws(() => scopedFile(config, 'read_file', { path }), /permitted project files/);
      assert.throws(() => scopedFile(config, 'write_file', { path, content: 'corrupted', expectedSha256: null }), /permitted project files/);
      assert.throws(() => scopedFile(config, 'list_files', { path }), /permitted project files/);
    }
    assert.deepEqual(scopedFile(config, 'list_files', { path: '.' }).entries, []);
  }
  assert.equal(readFileSync(join(worktree, '.git'), 'utf8'), metadata);
  const config = { root: worktree, role: 'implementer' };
  scopedFile(config, 'write_file', { path: 'normal.txt', content: 'allowed', expectedSha256: null });
  assert.equal(scopedFile(config, 'read_file', { path: 'normal.txt' }).content, 'allowed');
  assert.equal(git(['-C', worktree, 'rev-parse', '--is-inside-work-tree']).toString().trim(), 'true');
});
