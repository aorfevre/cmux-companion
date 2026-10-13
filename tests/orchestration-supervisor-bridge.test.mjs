import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFixture, HEADERS } from './helpers/orchestration/api-fixture.mjs';
import { contract } from './helpers/orchestration/domain-fixture.mjs';
import { createBridge } from '../server/orchestration/bridge.mjs';
import { agentMcpRequest } from '../server/orchestration/agent-mcp.mjs';
import { rolePrompt } from '../server/orchestration/adapters/role-prompts.mjs';

test('supervisor MCP carries exact receipts through questions, proposals and approval on the real API', async t => {
  const { app, planner, store, service } = await apiFixture(t, { resultIntake: true });
  const credential = planner(2), endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const bridge = createBridge({ endpoint, credential });
  const attempt = store.get('goal').attempts[0];
  const binding = { ...attempt, goalId: 'goal', attemptId: attempt.id, supervisor: true };
  const context = { bridge, binding };
  const invoke = (name, args) => agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, context);
  const send = (id, action, payload) => ({ id, action, payload, expectedVersion: store.get('goal').version });
  const question = send('question', 'question', { message: 'Which module?', replyTo: 1 });
  assert.equal((await invoke('conversation', question)).result.isError, undefined);
  const answer = { id: 'answer', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'send_goal_message', payload: { message: 'The first module.' } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/commands', headers: HEADERS, payload: answer })).statusCode, 200);
  await invoke('conversation', send('ack', 'ack', { through: 3 }));
  await invoke('conversation', send('reply', 'reply', { message: 'Understood.', replyTo: 3 }));
  const count = store.get('goal').conversation.messages.length;
  assert.equal((await invoke('conversation', question)).result.isError, undefined, 'lost response replays its original envelope');
  assert.equal(store.get('goal').conversation.messages.length, count);
  assert.equal((await invoke('conversation', { ...question, expectedVersion: store.get('goal').version })).result.isError, true, 'changed envelope cannot reuse a receipt');
  service.execute({ id: 'policy', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'set_plan_review_policy', payload: { enabled: false } }, { kind: 'system' });
  const { tasks, ...proposal } = contract();
  const simple = { ...proposal, schemaVersion: 2, implementation: { title: 'Implement the outcome', prompt: 'Build the approved modules.', ownedAreas: tasks.flatMap(task => task.ownedAreas) } };
  const listed = await agentMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context);
  const forms = listed.result.tools.find(tool => tool.name === 'conversation').inputSchema.properties.payload.properties.contract.oneOf;
  assert.ok(forms[0].required.includes('implementation'));
  assert.ok(!forms[0].required.includes('waves'));
  assert.equal((await invoke('conversation', send('proposal', 'propose', { contract: simple }))).result.isError, undefined);
  const goal = store.get('goal');
  assert.equal(goal.revision, 1);
  assert.equal(goal.tasks.length, 1);
  assert.equal(goal.tasks[0].id, 'implementation');
  assert.match(rolePrompt(goal, goal.attempts[0]), /Omit tasks and waves/);
  assert.equal(goal.attempts[0].workerState, 'running');
  assert.match(rolePrompt(goal, goal.attempts[0]), /persistent goal supervisor/);
  assert.equal((await invoke('submit_result', { id: 'legacy', output: { question: 'Replace me?' } })).result.isError, true);
  await assert.rejects(bridge.submitResult({ id: 'legacy-route', raw: '{}' }), { code: 'FORBIDDEN' });
  await assert.rejects(bridge.submit({ id: 'approve', goalId: 'goal', expectedVersion: goal.version, type: 'approve', payload: { revision: 1 } }), { code: 'FORBIDDEN' });
  assert.equal(store.get('goal').approvedRevision, null);
  assert.equal(store.get('goal').conversation.messages[2].delivery, 'answered');
  assert.equal(store.operations().filter(op => op.kind === 'terminate').length, 0);
  assert.ok(!JSON.stringify(await bridge.status()).includes(credential));
  const cursor = store.get('goal').conversation.wake;
  await invoke('conversation', send('idle', 'wait', { throughWake: cursor }));
  assert.equal(store.executionCapacity('goal').total, 0);
  service.execute({ id: 'wake', goalId: 'goal', expectedVersion: store.get('goal').version, type: 'send_goal_message', payload: { message: 'Continue within the proposed scope.' } }, { kind: 'user' });
  const resumed = await bridge.waitForInput(cursor);
  assert.equal(resumed.conversation.capacityReleased, false);
  assert.equal(store.executionCapacity('goal').total, 1);
});

test('supervisor tools stay unavailable to legacy planners and cannot bypass pairing or origin checks', async t => {
  const { app, planner, store } = await apiFixture(t);
  const credential = planner();
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const bridge = createBridge({ endpoint, credential });
  const command = { id: 'spoof', goalId: 'goal', expectedVersion: 3, type: 'supervisor_question', payload: { message: 'Spoof' } };
  await assert.rejects(bridge.submit(command), { code: 'FORBIDDEN' });
  const context = { bridge, binding: { role: 'planner' } };
  const list = await agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, context);
  assert.ok(!list.result.tools.some(tool => tool.name === 'conversation'));
  const result = await app.inject({ method: 'POST', url: '/api/orchestration/agent/commands', headers: { authorization: `Bearer ${credential}`, origin: 'https://evil.example' }, payload: command });
  assert.equal(result.statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/agent/commands', payload: command })).statusCode, 401);
  assert.equal(store.get('goal').version, 3);
});

test('waiting stays inside one tool call across idle and paused observations', async () => {
  const bridge = createBridge({ endpoint: 'http://127.0.0.1', credential: 'unused' });
  let reads = 0;
  bridge.status = async () => ({ experienceVersion: 2, conversation: { wake: reads++ < 1 ? 1 : 2, paused: reads === 2 } });
  const result = await bridge.waitForInput(1);
  assert.equal(reads, 3);
  assert.equal(result.conversation.wake, 2);
  await assert.rejects(bridge.waitForInput(-1), /Invalid conversation cursor/);
  await assert.rejects(bridge.waitForInput(3), /ahead/);
  bridge.status = async () => ({ experienceVersion: 1 });
  await assert.rejects(bridge.waitForInput(1), /unavailable/);
});

test('idle MCP wait permits ping and status, bounds duplicate waits and cancels without another model turn', { timeout: 5000 }, async () => {
  const { PassThrough, Writable } = await import('node:stream');
  const { serveAgentMcp } = await import('../server/orchestration/agent-mcp.mjs');
  const input = new PassThrough(), replies = [];
  const output = new Writable({ write(chunk, encoding, done) { replies.push(JSON.parse(chunk.toString())); done(); } });
  const bridge = createBridge({ endpoint: 'http://127.0.0.1', credential: 'unused' });
  let reads = 0, waits = 0;
  bridge.status = async () => { reads++; return { experienceVersion: 2, conversation: { wake: 1, paused: false } }; };
  const wait = bridge.waitForInput.bind(bridge);
  bridge.waitForInput = (...args) => { waits++; return wait(...args); };
  const running = serveAgentMcp(input, output, { binding: { role: 'planner', supervisor: true }, bridge });
  const send = value => input.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const flush = () => new Promise(resolve => setImmediate(resolve));
  send({ id: 'wait', method: 'tools/call', params: { name: 'wait_for_input', arguments: { throughWake: 1 } } });
  await flush();
  send({ id: 'ping', method: 'ping' });
  send({ id: 'status', method: 'tools/call', params: { name: 'get_status' } });
  send({ id: 'duplicate', method: 'tools/call', params: { name: 'wait_for_input', arguments: { throughWake: 1 } } });
  await flush();
  assert.deepEqual(replies.map(reply => reply.id), ['ping', 'status', 'duplicate']);
  assert.match(replies[2].error.message, /already active/);
  assert.equal(waits, 1); assert.equal(reads, 2);
  send({ method: 'notifications/cancelled', params: { requestId: 'unrelated' } });
  await flush(); assert.equal(waits, 1);
  send({ method: 'notifications/cancelled', params: { requestId: 'wait' } });
  await flush();
  bridge.status = async () => ({ experienceVersion: 2, conversation: { wake: 2, paused: false } });
  send({ id: 'next', method: 'tools/call', params: { name: 'wait_for_input', arguments: { throughWake: 1 } } });
  await flush();
  assert.equal(replies.at(-1).id, 'next');
  assert.equal(JSON.parse(replies.at(-1).result.content[0].text).conversation.wake, 2);
  assert.ok(!replies.some(reply => reply.id === 'wait'));
  input.end(); await running;
});

test('closing MCP input cancels an idle wait and its polling', { timeout: 5000 }, async () => {
  const { PassThrough, Writable } = await import('node:stream');
  const { serveAgentMcp } = await import('../server/orchestration/agent-mcp.mjs');
  const input = new PassThrough(), replies = [];
  const output = new Writable({ write(chunk, encoding, done) { replies.push(chunk); done(); } });
  const bridge = createBridge({ endpoint: 'http://127.0.0.1', credential: 'unused' });
  let reads = 0;
  bridge.status = async () => { reads++; return { experienceVersion: 2, conversation: { wake: 1, paused: true } }; };
  const running = serveAgentMcp(input, output, { binding: { role: 'planner', supervisor: true }, bridge });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_input', arguments: { throughWake: 1 } } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  input.end(); await running;
  assert.equal(reads, 1); assert.deepEqual(replies, []);
});

test('idle cancellation aborts an in-flight authenticated status request', { timeout: 5000 }, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const server = createServer();
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bridge = createBridge({ endpoint: `http://127.0.0.1:${server.address().port}`, credential: 'fixture-only', timeoutMs: 15000 });
  const controller = new AbortController(), requested = once(server, 'request');
  const pending = bridge.waitForInput(0, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const [request] = await requested;
  assert.equal(request.url, '/api/orchestration/agent/status');
  assert.equal(request.headers.authorization, 'Bearer fixture-only');
  controller.abort(); await rejected;
});

test('one idle tool waits through capacity contention without another model turn and preserves uncertain activation receipts', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = createBridge({ endpoint: 'http://127.0.0.1', credential: 'unused' });
  let occupied = true, released = true, uncertain = true, finished = false;
  const submissions = [];
  bridge.status = async () => ({ id: 'goal', version: 9, experienceVersion: 2, conversation: { wake: 2, seenWake: 1, paused: false, capacityReleased: released } });
  bridge.submit = async command => {
    submissions.push(structuredClone(command));
    if (occupied) throw Object.assign(new Error('Occupied'), { code: 'CAPACITY_FULL' });
    if (uncertain) { uncertain = false; throw new Error('Response unavailable'); }
    released = false;
  };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = bridge.waitForInput(1, controller.signal).then(result => { finished = true; return result; });
  pending.catch(() => {});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  for (let second = 0; second < 5; second++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(finished, false); assert.equal(submissions.length, 6);
  occupied = false;
  t.mock.timers.tick(1000); await flush();
  const uncertainCommand = submissions.at(-1);
  assert.equal(finished, false);
  t.mock.timers.tick(1000); await flush();
  const result = await pending;
  assert.deepEqual(submissions.at(-1), uncertainCommand, 'uncertain activation retries its exact durable envelope');
  assert.equal(result.conversation.capacityReleased, false);
  assert.ok(submissions.every(command => command.type === 'supervisor_activate'));
});

test('idle status timeouts preserve the supervisor and wait for the next saved wake', { timeout: 5000 }, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  let requests = 0;
  const server = createServer((req, res) => {
    if (++requests === 1) return; // A real fetch timeout carries numeric DOMException.code=23.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ experienceVersion: 2, conversation: { wake: 2, paused: false } }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bridge = createBridge({ endpoint: `http://127.0.0.1:${server.address().port}`, credential: 'fixture-only', timeoutMs: 100 });
  const state = await bridge.waitForInput(1);
  assert.equal(state.conversation.wake, 2);
  assert.equal(requests, 2, 'transport retry does not submit another model turn');
});
