import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readSupervisorTurn, supervisorTurnCommand } from '../server/orchestration/adapters/supervisor-turn.mjs';
import { agentMcpRequest } from '../server/orchestration/agent-mcp.mjs';

const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'native-session' };
const frames = values => values.map(value => JSON.stringify(value) + '\n').join('');

test('native turn framing preserves Unicode, excludes private tool frames and requires one matching final result', async () => {
  const output = [], data = Buffer.from(frames([
    { type: 'system', private: 'fixture-private-token' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Résumé\u001b[31m' }, { type: 'tool_use', input: 'fixture-private-token' }] } }, result,
  ]));
  await readSupervisorTurn(Readable.from(Array.from(data, byte => Buffer.from([byte]))), 'native-session', text => output.push(text));
  assert.equal(output.join(''), 'Résumé[31m\n');
  assert.ok(!output.join('').includes('fixture-private-token'));
  for (const values of [[{ ...result, session_id: 'another-session' }], [{ ...result, subtype: 'error' }], [result, result], [{ type: 'assistant' }]]) {
    await assert.rejects(readSupervisorTurn(Readable.from([Buffer.from(frames(values))]), 'native-session', () => {}), { code: 'SUPERVISOR_PROTOCOL_FAILED' });
  }
  await assert.rejects(readSupervisorTurn(Readable.from([Buffer.alloc(2 * 1024 * 1024 + 1, 120)]), 'native-session', () => {}), { code: 'SUPERVISOR_PROTOCOL_FAILED' });
});

test('native turn accepts only the initial known CCS proxy preamble', async () => {
  const preamble = '[i] Joined existing CLIProxy on port 8317 (http)\r\n';
  const read = data => readSupervisorTurn(Readable.from([Buffer.from(data)]), 'native-session', () => {});
  await read('\n' + preamble + frames([result]));
  await read(preamble.replace('(http)', '(https)') + frames([result]));
  await assert.rejects(read('Unexpected diagnostic\n' + frames([result])));
  await assert.rejects(read(frames([{ type: 'system' }]) + preamble + frames([result])));
  await assert.rejects(read(preamble + preamble + frames([result])));
});

test('managed native supervisor cannot reopen an indefinitely waiting MCP call', async () => {
  const context = { binding: { role: 'planner', supervisor: true, supervisorTurns: true }, bridge: {} };
  const tools = await agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, context);
  assert.ok(!tools.result.tools.some(tool => tool.name === 'wait_for_input'));
  const refused = await agentMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for_input', arguments: { throughWake: 1 } } }, context);
  assert.equal(refused.result.isError, true);
  assert.equal(JSON.parse(refused.result.content[0].text).code, 'FORBIDDEN');
});

test('Codex turns bind stream identity to the saved hook receipt and reject incomplete or failed streams', async () => {
  const start = { type: 'thread.started', thread_id: 'saved-native-session' }, end = { type: 'turn.completed' };
  const output = [];
  const read = values => readSupervisorTurn(Readable.from([Buffer.from(frames(values))]), 'logical-session', text => output.push(text), { provider: 'codex', sessionId: () => 'saved-native-session' });
  await read([start, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'mcp_tool_call', result: 'private-tool-output' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'Waiting for your approval.' } }, end]);
  assert.deepEqual(output, ['Waiting for your approval.\n']);
  for (const values of [[end], [start], [start, start, end], [{ ...start, thread_id: 'wrong-session' }, end], [start, { type: 'turn.failed' }], [start, { type: 'error' }, end], [start, end, end]]) {
    await assert.rejects(read(values), { code: 'SUPERVISOR_PROTOCOL_FAILED' });
  }
  let receiptReady = false;
  async function* delayedHook() {
    yield Buffer.from(frames([start]));
    receiptReady = true;
    yield Buffer.from(frames([end]));
  }
  await readSupervisorTurn(delayedHook(), 'logical-session', () => {}, { provider: 'codex', sessionId: () => {
    assert.ok(receiptReady, 'SessionStart receipt is required at completion, not at thread creation');
    return 'saved-native-session';
  } });
});

test('native turn controller defers paused capacity and replays uncertain start receipts without extra input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); t.after(() => controller.abort());
  const state = { id: 'goal', version: 1, conversation: { paused: true, wake: 1, capacityReleased: false } };
  const commands = []; let uncertain = true;
  const bridge = {
    status: async () => structuredClone(state),
    submit: async command => {
      commands.push(structuredClone(command));
      if (command.type === 'supervisor_turn_defer') { state.conversation.capacityReleased = true; state.version++; }
      else if (uncertain) { uncertain = false; throw new Error('Lost response'); }
    },
  };
  const pending = supervisorTurnCommand(bridge, 'supervisor_turn_start', controller.signal); pending.catch(() => {});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  for (let second = 0; second < 3; second++) { t.mock.timers.tick(1000); await flush(); }
  assert.deepEqual(commands.map(command => command.type), ['supervisor_turn_defer']);
  state.conversation.paused = false; state.conversation.wake++;
  t.mock.timers.tick(1000); await flush();
  const first = commands.at(-1);
  t.mock.timers.tick(1000); await flush(); await pending;
  assert.deepEqual(commands.at(-1), first);
});

test('turn command retries a numeric transport timeout with its original receipt', { timeout: 5000 }, async () => {
  const commands = [];
  const bridge = {
    status: async () => ({ id: 'goal', version: 1, conversation: { paused: false, wake: 1 } }),
    submit: async command => { commands.push(command); if (commands.length === 1) throw new DOMException('Private response', 'TimeoutError'); },
  };
  await supervisorTurnCommand(bridge, 'supervisor_turn_idle', new AbortController().signal);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
});
