import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRuntime, backgroundPolicy, startBackgroundProcess } from '../server/orchestration/adapters/agent-runtime.mjs';
import { FakeClock } from './helpers/orchestration/fake-clock.mjs';
import { FakeAgents, barrier } from './helpers/orchestration/fake-agents.mjs';

const policy = { ceilingMs: 10000, idleMs: 1000, maxOutputBytes: 1024, killGraceMs: 100 };
const command = (script) => ({ bin: process.execPath, argv: ['-e', script], cwd: process.cwd(), env: { PATH: process.env.PATH } });
async function start(t, script, options = {}) {
  const handle = await startBackgroundProcess(command(script), { policy, onIdentity: () => {}, ...options });
  t.after(async () => { handle.terminate(); await handle.result; });
  return handle;
}

test('background limits reject missing, zero and overflowing values before spawn', () => {
  for (const key of Object.keys(policy)) for (const value of [undefined, 0, -1, 0.5, Infinity, 2147483648]) assert.throws(() => backgroundPolicy({ ...policy, [key]: value }));
  assert.ok(Object.isFrozen(backgroundPolicy(policy)));
});

test('abort before spawn creates no process or identity callback', async () => {
  const controller = new AbortController(); controller.abort(); let recorded = false;
  await assert.rejects(startBackgroundProcess(command('process.exit(0)'), { policy, signal: controller.signal, onIdentity: () => { recorded = true; } }), { code: 'ABORTED' });
  assert.equal(recorded, false);
});

test('spawn failures retain a structured code without exposing command errors', async () => {
  const clock = new FakeClock();
  await assert.rejects(startBackgroundProcess({ ...command(''), bin: '/nonexistent/private-agent-token' }, { policy, clock, onIdentity: () => assert.fail('must not persist absent process') }), (error) => error.code === 'SPAWN_FAILED' && !error.message.includes('private-agent-token'));
  assert.equal(clock.pending.size, 0);
});

test('recorded operation identity precedes launch acknowledgement and bounded result output', async (t) => {
  let recorded;
  const handle = await start(t, "process.stdout.write('result'); process.stderr.write('progress');", { onIdentity: (value) => { recorded = value; } });
  assert.deepEqual(recorded, { identity: handle.identity, pid: handle.pid });
  assert.ok(handle.identity.length >= 16);
  assert.deepEqual(await handle.result, { status: 'succeeded', workerState: 'stopped', cause: null, stdout: 'result', stderr: 'progress' });
});

test('identity persistence failure terminates the owned process before rejecting launch', async () => {
  let pid;
  await assert.rejects(startBackgroundProcess(command('setInterval(() => {}, 1000)'), { policy, onIdentity: (value) => { pid = value.pid; throw new Error('secret database path'); } }), { code: 'IDENTITY_FAILED' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('unsettled identity persistence cannot strand launch after the process deadline', async () => {
  const clock = new FakeClock(), entered = barrier(); let pid;
  const launched = startBackgroundProcess(command('setInterval(() => {}, 1000)'), { policy, clock, onIdentity: (value) => {
    pid = value.pid; entered.release(); return new Promise(() => {});
  } });
  const rejected = assert.rejects(launched, { code: 'IDENTITY_FAILED' });
  await entered.promise; clock.advance(policy.idleMs); await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(clock.pending.size, 0);
});

test('silent background process fails on idle and disposes every timer', async (t) => {
  const clock = new FakeClock();
  const handle = await start(t, 'setInterval(() => {}, 1000)', { clock });
  clock.advance(policy.idleMs);
  const result = await handle.result;
  assert.equal(result.cause.code, 'IDLE_LIMIT'); assert.equal(clock.pending.size, 0);
});

test('stderr activity resets idle while the independent ceiling still bounds execution', async (t) => {
  const clock = new FakeClock();
  const handle = await start(t, "process.stderr.write('waiting'); setInterval(() => {}, 1000);", { clock });
  clock.advance(500); await clock.scheduled(3);
  clock.advance(500); assert.equal(clock.pending.size, 2);
  // Deliberately choose a shorter absolute ceiling for the next process.
  handle.terminate(); await handle.result;
  const otherClock = new FakeClock();
  const other = await start(t, "process.stdout.write('working'); setInterval(() => {}, 1000);", { clock: otherClock, policy: { ...policy, ceilingMs: 500 } });
  await otherClock.scheduled(3); otherClock.advance(500);
  assert.equal((await other.result).cause.code, 'CEILING_LIMIT');
});

test('combined stdout/stderr overflow including an unterminated line is bounded', async (t) => {
  const handle = await start(t, "process.stdout.write('a'.repeat(800)); process.stderr.write('b'.repeat(800)); setInterval(() => {}, 1000);");
  const result = await handle.result;
  assert.equal(result.cause.code, 'OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= policy.maxOutputBytes);
});

test('truncated multibyte and malformed UTF-8 cannot expand returned output past its byte budget', async (t) => {
  for (const script of ["process.stdout.write('é');", 'process.stdout.write(Buffer.from([255,255]));']) {
    const handle = await start(t, script, { policy: { ...policy, maxOutputBytes: 1 } });
    const result = await handle.result;
    assert.equal(result.cause.code, 'OUTPUT_LIMIT');
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1);
  }
});

test('abort kills the owned process group and reports a structured cause', async (t) => {
  const controller = new AbortController();
  const handle = await start(t, 'setInterval(() => {}, 1000)', { signal: controller.signal });
  controller.abort();
  assert.equal((await handle.result).cause.code, 'ABORTED');
  assert.throws(() => process.kill(-handle.pid, 0), { code: 'ESRCH' });
});

test('parent close cannot cancel escalation for a SIGTERM-resistant same-group descendant', async (t) => {
  const ready = barrier(); let scheduled = 0;
  const clock = { schedule(callback, delay) { if (++scheduled === 3) ready.release(); return setTimeout(callback, delay); }, cancel: clearTimeout };
  const descendant = "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
  const script = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore','ignore','ignore','ipc'] }); child.on('message', () => { child.disconnect(); child.unref(); process.stdout.write('ready'); }); setInterval(() => {}, 1000);`;
  const handle = await start(t, script, { clock });
  t.after(() => { try { process.kill(-handle.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await ready.promise; handle.terminate();
  const result = await handle.result;
  assert.equal(result.cause.code, 'ABORTED');
  assert.equal(result.workerState, 'stopped');
  assert.throws(() => process.kill(-handle.pid, 0), { code: 'ESRCH' });
});

test('escaped descendant holding output pipes cannot outlive the bounded drain deadline', async (t) => {
  const clock = new FakeClock();
  const descendant = "process.send('ready'); setInterval(() => {}, 1000);";
  const script = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: ['ignore',1,2,'ipc'] }); child.on('message', () => { process.stdout.write(String(child.pid)); child.disconnect(); child.unref(); });`;
  const handle = await start(t, script, { clock });
  await clock.scheduled(3);
  clock.advance(policy.ceilingMs + 2 * policy.killGraceMs);
  const result = await handle.result;
  // This descendant deliberately escaped the runtime's process group. Only the
  // test that created it can clean it; the runtime must preserve uncertainty.
  const escapedPid = Number(result.stdout);
  assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1);
  try {
    assert.equal(result.status, 'failed'); assert.equal(result.workerState, 'unknown');
    assert.equal(clock.pending.size, 0);
    assert.doesNotThrow(() => process.kill(escapedPid, 0));
  } finally { process.kill(-escapedPid, 'SIGKILL'); }
});

test('nonzero exit is failure and raw stderr remains separate private evidence', async (t) => {
  const handle = await start(t, "process.stderr.write('private details'); process.exitCode = 7;");
  const result = await handle.result;
  assert.deepEqual(result.cause, { code: 'EXIT_FAILED', exitCode: 7, signal: null });
  assert.equal(result.stderr, 'private details');
});

test('interactive planning keeps native driver lifecycle, conversation identity and resume', async () => {
  const interactive = new FakeAgents(), background = new FakeAgents(); let resumed;
  interactive.resume = async (request) => { resumed = request; return { identity: request.attempt.identity }; };
  const runtime = new AgentRuntime({ interactive, background, locate: ({ operationId, identity }) => operationId === 'op' || identity === 'worker_op' ? 'interactive' : null });
  const request = { operationId: 'op', goalId: 'g', attempt: { role: 'planner', mode: 'interactive', conversationId: 'conversation', identity: null } };
  const launched = await runtime.launch(request);
  assert.equal(background.launches.length, 0);
  // There is no silence timer in the interactive path; only its driver decides
  // whether a native permission/user wait has ended.
  assert.deepEqual(await runtime.observe('op'), { status: 'running', identity: launched.identity });
  request.attempt.identity = launched.identity;
  assert.deepEqual(await runtime.resume(request), launched); assert.equal(resumed.attempt.conversationId, 'conversation');
  assert.deepEqual(await runtime.observe('missing'), { status: 'unknown', identity: null });
  await assert.rejects(runtime.terminate('unrecorded'), { code: 'OWNERSHIP_UNCERTAIN' });
  await runtime.terminate(launched.identity);
  assert.equal((await runtime.observe('op')).status, 'stopped');
  await assert.rejects(runtime.launch({ ...request, attempt: { ...request.attempt, role: 'implementer' } }), { code: 'UNSUPPORTED_CAPABILITY' });
});
