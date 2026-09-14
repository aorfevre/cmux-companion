import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { NativeInputs } from '../server/orchestration/adapters/native-inputs.mjs';
import { CodexInputs } from '../server/codex-native.mjs';
import { probeNativeCapabilities } from '../server/orchestration/adapters/native-capabilities.mjs';
import { NativeTerminal } from '../server/orchestration/adapters/native-terminal.mjs';

const capabilities = { restricted: true, manualPermissions: true, hooks: true, strictMcp: true, streamJson: true, permissionPromptsNone: true, terminal: true };
const workspaceId = 'c456d73c-9fce-4501-b141-41076b111fea';
const conversationId = 'e7be1651-cb20-41e0-b658-c2d42c1d2c9f';
async function waitFor(read, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { let value; try { value = await read(); } catch { /* Waiting for an atomic fixture receipt. */ } if (predicate(value)) return value; await delay(20); }
  assert.fail('Fixture did not reach its named terminal barrier');
}
async function fixture(t, codex = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchestration-terminal-'))), worktree = join(root, 'worktree'); await mkdir(worktree);
  const calls = join(root, 'native-calls'), bin = join(root, 'native-fixture');
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
if (${codex} && process.argv.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
if (${codex} && process.argv.includes('--help')) { console.log('--config --sandbox --ask-for-approval --strict-config --dangerously-bypass-hook-trust'); process.exit(0); }
if (${codex}) {
 const path = require('node:path'), directory = path.dirname(process.env.CODEX_HOME);
 const config = JSON.parse(fs.readFileSync(path.join(directory, 'codex-hook.json'), 'utf8'));
 fs.writeFileSync(path.join(directory, 'codex-session.json'), JSON.stringify({conversationId:config.conversationId,sessionId:'fixture-native-session'}));
}
const arg = name => process.argv[process.argv.indexOf(name) + 1];
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ fresh: ${codex} ? !process.argv.includes('resume') : process.argv.includes('--session-id'), conversation: ${codex} ? (process.argv.includes('resume') ? arg('resume') : 'fixture-native-session') : arg(process.argv.includes('--resume') ? '--resume' : '--session-id'), tty: [process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY] }) + '\\n');
const readline = require('node:readline').createInterface({ input: process.stdin });
readline.on('line', line => { if (line.trim() === 'exit') { readline.close(); process.exit(0); } });
`, { mode: 0o700 });
  const server = createServer((req, res) => { res.writeHead(204); res.end(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bridge = { endpoint: `http://127.0.0.1:${server.address().port}`, credential: 'fixture-activation-credential-at-least-32-characters' };
  const installation = codex ? await probeNativeCapabilities({ ccsBin: bin, claudeBin: bin, direct: true, provider: 'codex' }) : undefined;
  const Inputs = codex ? CodexInputs : NativeInputs;
  const inputs = new Inputs({ installation, direct: codex, engine: { provider: codex ? 'codex' : 'default', model: 'fixture' }, capabilities, env: { HOME: root, PATH: process.env.PATH, FIXTURE_CALLS: calls }, describe: () => ({ prompt: 'Fixture planner', plannerName: 'DICTEE Planning Onboarding', activation: bridge, bridge }) });
  let child, creates = 0, starts = 0, opens = 0;
  const terminal = {
    async create(cwd, title) { assert.equal(cwd, worktree); assert.equal(title, 'DICTEE Planning Onboarding'); creates++; return { workspaceId }; },
    async start(id, path) {
      assert.equal(id, workspaceId); starts++;
      const runner = fileURLToPath(new URL('../server/orchestration/adapters/native-terminal-worker.mjs', import.meta.url));
      const args = process.platform === 'darwin' ? ['-q', '/dev/null', process.execPath, runner, path] : ['-q', '-c', `${process.execPath} ${runner} ${path}`, '/dev/null'];
      child = spawn('/bin/sh', ['-c', '/bin/cat | exec "$@"', 'fixture-pty', '/usr/bin/script', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TERM: 'xterm' } });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('exit', code => { if (code) process.stderr.write(`Fixture terminal exited ${code}: ${output}\n`); }); await once(child, 'spawn');
    },
    async open(id) { assert.equal(id, workspaceId); opens++; },
  };
  const driver = new NativeTerminal({ directory: join(root, 'native'), bin, inputs, terminal, killGraceMs: 100 });
  const request = { goalId: 'goal', operationId: 'operation', attempt: { id: 'planner', operationId: 'operation', role: 'planner', mode: 'interactive', generation: 1, revision: 0, conversationId, target: 'contract:0', baseSha: 'a'.repeat(40), worktree, branch: 'companion/planner' } };
  t.after(async () => { try { await driver.close(); } finally { if (child) { child.stdin.end(); if (child.exitCode === null) child.kill('SIGTERM'); } await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); } });
  const records = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  const session = async () => JSON.parse(await readFile(join(root, 'native/operation/session.json'), 'utf8'));
  return { root, driver, request, terminal, records, session, server, input: text => child.stdin.write(text), counts: () => ({ creates, starts, opens }) };
}

test('interactive native planner inherits a real PTY, waits for input and resumes the same conversation once', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  assert.deepEqual(await f.driver.launch(f.request), launched);
  const first = await waitFor(f.records, records => records?.length === 1);
  assert.deepEqual(first[0], { fresh: true, conversation: conversationId, tty: [true, true, true] });
  await delay(200); assert.equal((await f.driver.observe('operation')).status, 'running');
  await f.driver.open('operation');
  await assert.rejects(f.driver.resume({ ...f.request, resumeId: 'resume1' }), { code: 'ALREADY_RUNNING' });
  f.input('exit\n'); await waitFor(f.session, session => session?.phase === 'paused');
  await assert.rejects(f.driver.resume({ ...f.request, resumeId: 'initial' }));
  const resumed = { ...f.request, resumeId: 'resume1' };
  await f.driver.resume(resumed); await f.driver.resume(resumed);
  const records = await waitFor(f.records, entries => entries?.length === 2);
  assert.deepEqual(records[1], { fresh: false, conversation: conversationId, tty: [true, true, true] });
  assert.deepEqual(f.counts(), { creates: 1, starts: 1, opens: 1 });
  await f.driver.close(); assert.equal((await f.driver.observe('operation')).status, 'stopped');
});

test('lost cmux creation response remains uncertain and cannot create another terminal', async (t) => {
  const f = await fixture(t); let calls = 0;
  f.terminal.create = async () => { calls++; throw new Error('lost response'); };
  await assert.rejects(f.driver.launch(f.request), /lost response/);
  await assert.rejects(f.driver.launch(f.request), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.equal(calls, 1); assert.equal((await f.driver.observe('operation')).status, 'unknown');
  await assert.rejects(f.driver.close(), { code: 'OWNERSHIP_UNCERTAIN' });
  // The fake create never started a terminal. Only this fixture knows that;
  // production keeps its uncertain create receipt for explicit reconciliation.
  f.driver.managed.clear();
});

test('resume repairs its durable pointer after a response-loss boundary without duplicate provider runs', { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  await waitFor(f.records, records => records?.length === 1); f.input('exit\n'); await waitFor(f.session, session => session?.phase === 'paused');
  const directory = join(f.root, 'native/operation');
  await writeFile(join(directory, 'resume-recovered.json'), JSON.stringify({ identity: launched.identity, id: 'recovered' }), { mode: 0o600 });
  await assert.rejects(access(join(directory, 'resume.json')), { code: 'ENOENT' });
  await f.driver.resume({ ...f.request, resumeId: 'recovered' });
  await waitFor(f.records, records => records?.length === 2);
  await f.driver.resume({ ...f.request, resumeId: 'recovered' });
  assert.equal((await f.records()).length, 2); await f.driver.close();
});


test('close during resume observation fences the later resume pointer write', { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  await waitFor(f.records, records => records?.length === 1); f.input('exit\n'); await waitFor(f.session, session => session?.phase === 'paused');
  const observe = f.driver.observe.bind(f.driver); let entered, release;
  const barrier = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  let first = true;
  f.driver.observe = async id => { const result = await observe(id); if (first) { first = false; entered(); await pending; } return result; };
  const resumed = f.driver.resume({ ...f.request, resumeId: 'late' });
  const rejected = assert.rejects(resumed, { code: 'NOT_READY' });
  await barrier; await f.driver.close(); release(); await rejected;
  await assert.rejects(access(join(f.root, 'native/operation/resume-late.json')), { code: 'ENOENT' });
});

test('cmux transport sends only fixed runner argv and sanitizes native errors', async (t) => {
  const { CmuxTerminal } = await import('../server/orchestration/adapters/cmux.mjs');
  const root = await mkdtemp(join(tmpdir(), 'orchestration-cmux-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'cmux-fixture'), calls = join(root, 'calls');
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FIXTURE_FAIL) { process.stderr.write('private-credential'); process.exit(1); }
process.stdout.write(JSON.stringify({ workspace_id: ${JSON.stringify(workspaceId)}, window_id: ${JSON.stringify(workspaceId)} }));
`, { mode: 0o700 });
  const terminal = new CmuxTerminal({ bin, env: { FIXTURE_CALLS: calls } });
  await terminal.create(root, 'DICTEE Planning Onboarding'); await terminal.start(workspaceId, join(root, "private ' input.json")); await terminal.open(workspaceId);
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.map(args => args.slice(0, 3)), ['workspace.create', 'surface.send_text', 'workspace.select', 'window.focus'].map(method => ['--json', 'rpc', method]));
  assert.equal(JSON.parse(recorded[0][3]).title, 'DICTEE Planning Onboarding');
  const sent = JSON.parse(recorded[1][3]); assert.equal(sent.workspace_id, workspaceId);
  assert.ok(sent.text.startsWith('exec ')); assert.ok(sent.text.includes('native-terminal-worker.mjs'));
  assert.ok(sent.text.includes("'\\''"));
  await assert.rejects(terminal.start('other-target', '/private/config'));
  terminal.env.FIXTURE_FAIL = '1';
  await assert.rejects(terminal.open(workspaceId), error => error.code === 'CMUX_UNAVAILABLE' && !error.message.includes('private-credential'));
});


test('Codex terminal resumes its recorded native session through the real PTY supervisor', { timeout: 15000 }, async t => {
  const f = await fixture(t, true);
  const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  const first = await waitFor(f.records, records => records?.length === 1);
  assert.deepEqual(first[0], { fresh: true, conversation: 'fixture-native-session', tty: [true, true, true] });
  f.input('exit\n'); await waitFor(f.session, session => session?.phase === 'paused');
  await f.driver.resume({ ...f.request, resumeId: 'codex-resume' });
  await f.driver.resume({ ...f.request, resumeId: 'codex-resume' });
  const records = await waitFor(f.records, entries => entries?.length === 2);
  assert.deepEqual(records[1], { fresh: false, conversation: 'fixture-native-session', tty: [true, true, true] });
  await f.driver.close(); assert.equal((await f.driver.observe('operation')).status, 'stopped');
});

test('update handoff preserves a real terminal runner and adopts the same conversation without relaunch', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  await waitFor(f.records, entries => entries?.length === 1);
  const identityPath = join(f.root, 'native/operation/identity.json');
  const before = JSON.parse(await readFile(identityPath, 'utf8'));
  const evidence = await f.driver.prepareHandoff(f.request);
  await f.driver.close({ preserve: [f.request] });
  assert.equal((await f.driver.observe('operation')).status, 'running');
  const replacement = new NativeTerminal({ directory: f.driver.directory, bin: f.driver.bin, inputs: f.driver.inputs, terminal: f.terminal, killGraceMs: 150 });
  assert.deepEqual(await replacement.prepareHandoff(f.request), evidence);
  assert.deepEqual(JSON.parse(await readFile(identityPath, 'utf8')), before);
  assert.deepEqual(f.counts(), { creates: 1, starts: 1, opens: 0 });
  // A failed candidate can detach again; the restored owner adopts identically.
  await replacement.close({ preserve: [f.request] });
  const restored = new NativeTerminal({ directory: f.driver.directory, bin: f.driver.bin, inputs: f.driver.inputs, terminal: f.terminal, killGraceMs: 150 });
  assert.deepEqual(await restored.prepareHandoff(f.request), evidence);
  f.input('exit\n'); await waitFor(f.session, value => value?.phase === 'paused');
  await restored.resume({ ...f.request, resumeId: 'after-update' });
  const calls = await waitFor(f.records, entries => entries?.length === 2);
  assert.equal(calls[1].fresh, false); assert.equal(calls[1].conversation, conversationId);
  await restored.close(); assert.equal((await restored.observe('operation')).status, 'stopped');
});

test('old terminal protocol and altered handoff identity fail closed without signalling a running planner', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  await waitFor(f.records, entries => entries?.length === 1);
  await assert.rejects(f.driver.prepareHandoff({ ...f.request, attempt: { ...f.request.attempt, identity: 'other' } }), { code: 'OWNERSHIP_UNCERTAIN' });
  const path = join(f.root, 'native/operation/worker.json'), config = JSON.parse(await readFile(path, 'utf8'));
  delete config.handoffProtocol; await writeFile(path, JSON.stringify(config));
  await assert.rejects(f.driver.prepareHandoff(f.request), { code: 'HANDOFF_UNSUPPORTED' });
  assert.equal((await f.driver.observe('operation')).status, 'running');
  await f.driver.close();
});


test('stopped supervisor outbox is recovered by the replacement adapter after an update outage', { timeout: 15000 }, async t => {
  const { ResultOutbox } = await import('../server/orchestration/result-outbox.mjs');
  const f = await fixture(t);
  const launched = await f.driver.launch(f.request); f.request.attempt.identity = launched.identity;
  await waitFor(f.records, entries => entries?.length === 1);
  let online = false, deliveries = 0;
  f.server.removeAllListeners('request');
  f.server.on('request', async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    res.writeHead(online ? 202 : 503, { 'content-type': 'application/json' });
    if (online) deliveries++;
    res.end(JSON.stringify(online ? { id: input.id, status: 'accepted' } : { code: 'UPDATE_MAINTENANCE' }));
  });
  const directory = join(f.root, 'native/operation');
  const config = JSON.parse(await readFile(join(directory, 'bridge.json'), 'utf8'));
  const outbox = new ResultOutbox({ directory: join(directory, 'outbox'), binding: config.binding });
  outbox.enqueue({ id: 'during-update', raw: JSON.stringify({ schemaVersion: 1, ...config.binding, output: { question: 'Which audience?' } }) });
  await f.driver.terminate(launched.identity);
  await waitFor(async () => JSON.parse(await readFile(join(directory, 'outcome.json'), 'utf8')), value => value?.workerState === 'stopped');
  await f.driver.close();
  assert.equal(outbox.entries()[0].value.status, 'queued');
  const replacement = new NativeTerminal({ directory: f.driver.directory, bin: f.driver.bin, inputs: f.driver.inputs, terminal: f.terminal, killGraceMs: 150 });
  assert.equal((await replacement.observe('operation')).pendingOutbox, true);
  online = true;
  await replacement.observe('operation');
  await waitFor(() => outbox.entries()[0].value.status, value => value === 'accepted');
  assert.equal(deliveries, 1);
  await replacement.close();
});
