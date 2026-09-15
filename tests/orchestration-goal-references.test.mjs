import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalReferences } from '../server/orchestration/goal-references.mjs';
import { apiFixture, HEADERS, create } from './helpers/orchestration/api-fixture.mjs';
import { createBridge } from '../server/orchestration/bridge.mjs';
import { agentMcpRequest } from '../server/orchestration/agent-mcp.mjs';
const encode = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });
const png = { name: 'design.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' };
function referenceStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-references-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new GoalReferences({ directory });
}
const upload = files => ({ ...create, payload: { ...create.payload, title: 'Short title', description: 'Full brief with https://example.com', attachments: files } });

test('saved references survive store reopen, use immutable metadata and authenticate safe downloads', async t => {
  const references = referenceStore(t), { app, store } = await apiFixture(t, { references });
  const command = upload([encode('prototype.html', '<script>alert(1)</script>'), png]);
  const send = headers => app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: command });
  assert.equal((await send()).statusCode, 401);
  assert.equal((await send({ ...HEADERS, origin: 'https://attacker.test' })).statusCode, 403);
  const response = await send(HEADERS); assert.equal(response.statusCode, 200, response.body);
  const goal = store.get('goal'); assert.equal(goal.title, 'Short title'); assert.equal(goal.description, command.payload.description);
  assert.equal(goal.references.length, 2); assert.equal(goal.attachments, undefined); assert.ok(!JSON.stringify(goal).includes(png.data));
  assert.equal((await send(HEADERS)).statusCode, 200, 'identical retry reconciles its receipt');
  const reopened = new GoalReferences({ directory: references.artifacts.directory });
  assert.equal(reopened.read(goal, goal.references[0].id).bytes.toString(), '<script>alert(1)</script>');
  const path = `/api/orchestration/goals/goal/references/${goal.references[0].id}`;
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const download = await app.inject({ url: path, headers: HEADERS });
  assert.equal(download.statusCode, 200); assert.match(download.headers['content-type'], /^text\/plain/);
  assert.match(download.headers['content-disposition'], /^attachment;/); assert.equal(download.headers['x-content-type-options'], 'nosniff'); assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ url: path.replace('/goal/', '/other/'), headers: HEADERS })).statusCode, 404);
  assert.equal((await app.inject({ url: path.replace(goal.references[0].id, '0'.repeat(64)), headers: HEADERS })).statusCode, 404);
  const image = await app.inject({ url: path.replace(goal.references[0].id, goal.references[1].id), headers: HEADERS });
  assert.equal(image.headers['content-type'], 'image/png'); assert.equal(image.rawPayload.toString('base64'), png.data);
  writeFileSync(references.artifacts.path(goal.references[0].id), 'tampered');
  assert.throws(() => reopened.read(goal, goal.references[0].id), /integrity/);
});

test('agent reference transport is goal-bound, chunked, revocable and read-only for reviewers', async t => {
  const references = referenceStore(t), { app, store, service, bridgeAuth } = await apiFixture(t, { references });
  service.execute(references.prepare(upload([encode('brief.txt', 'a'.repeat(17000)), png])), { kind: 'user' });
  const command = (type, payload) => service.execute({ id: type, goalId: 'goal', expectedVersion: store.get('goal').version, type, payload }, { kind: 'system' });
  command('request_attempt', { attemptId: 'planner', operationId: 'operation', role: 'planner', conversationId: 'conversation' });
  command('record_dispatch', { attemptId: 'planner', identity: 'process', worktree: '/tmp/owned', branch: 'owned' });
  const credential = bridgeAuth.issue('goal', 'planner'), endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const bridge = createBridge({ endpoint, credential }), goal = store.get('goal');
  const first = await bridge.reference(goal.references[0].id); assert.equal(first.text.length, 16000); assert.equal(first.nextOffset, 16000);
  const second = await bridge.reference(goal.references[0].id, first.nextOffset); assert.equal(second.text.length, 1000); assert.equal(second.nextOffset, null);
  await assert.rejects(bridge.reference(goal.references[0].id, 17001));
  await assert.rejects(bridge.reference(goal.references[1].id, 1));
  await assert.rejects(bridge.reference('../other')); await assert.rejects(bridge.reference('0'.repeat(64)), { code: 'NOT_FOUND' });
  const context = { binding: { role: 'reviewer' }, bridge };
  const invoke = (name, args = {}) => agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, context);
  assert.deepEqual((await invoke('read_reference', { id: goal.references[1].id })).result.content, [{ type: 'image', mimeType: 'image/png', data: png.data }]);
  assert.equal(JSON.parse((await invoke('read_reference', { id: goal.references[0].id })).result.content[0].text).nextOffset, 16000);
  for (const name of ['commit_candidate', 'submit_result']) assert.equal((await invoke(name)).result.isError, true);
  assert.equal((await invoke('read_reference', { id: goal.references[0].id, path: '/etc/passwd' })).result.isError, true);
  service.repositoryIds.clear(); await assert.rejects(bridge.reference(goal.references[0].id), { code: 'FORBIDDEN' }); service.repositoryIds.add('repo');
  bridgeAuth.revoke('goal', 'planner'); await assert.rejects(bridge.reference(goal.references[0].id), { code: 'UNAUTHORIZED' });
});

test('uploads reject unsafe names, unsupported data, forged identities and limits before saving', async t => {
  const references = referenceStore(t);
  const invalid = [encode('../escape.txt', 'hi'), encode('bad\nname.txt', 'hi'), encode('binary.pdf', 'hi'), encode('bad.png', 'hi'), encode('bad.jpg', 'hi'), encode('bad.webp', 'hi'), encode('control.txt', '\0'), { name: 'utf8.txt', data: '/w==' }, { name: 'bad.txt', data: 'not base64' }, encode('empty.txt', ''), encode('big.txt', 'a'.repeat(1024 * 1024 + 1))];
  for (const file of invalid) assert.throws(() => references.prepare(upload([file])), undefined, file.name);
  assert.throws(() => references.prepare(upload([png, png])), /twice/);
  assert.throws(() => references.prepare(upload(Array.from({ length: 9 }, (_, i) => encode(`${i}.txt`, String(i))))));
  assert.throws(() => references.prepare({ ...create, payload: { ...create.payload, references: [] } }), /bytes/);
  const { app } = await apiFixture(t, { references, readOnly: true });
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestration/commands', headers: HEADERS, payload: upload([png]) })).statusCode, 403);
  const unsupported = await apiFixture(t);
  assert.equal((await unsupported.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers: HEADERS, payload: upload([png]) })).statusCode, 400);
});

test('restarting the journal and reference store retains the original goal inputs', async t => {
  const { OrchestrationStore } = await import('../server/orchestration/storage/store.mjs');
  const { OrchestrationService } = await import('../server/orchestration/service.mjs');
  const references = referenceStore(t), path = join(references.artifacts.directory, 'state.sqlite');
  let store = new OrchestrationStore({ path });
  const service = new OrchestrationService({ store, repositoryIds: new Set(['repo']), agents: { capabilities: [] } });
  service.execute(references.prepare(upload([png])), { kind: 'user' }); store.close();
  store = new OrchestrationStore({ path }); t.after(() => store.close());
  const goal = store.get('goal'), reopened = new GoalReferences({ directory: references.artifacts.directory });
  assert.equal(goal.title, 'Short title'); assert.equal(goal.description, 'Full brief with https://example.com');
  assert.equal(reopened.read(goal, goal.references[0].id).bytes.toString('base64'), png.data);
});
