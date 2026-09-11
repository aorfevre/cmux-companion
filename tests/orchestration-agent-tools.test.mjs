import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { GitIntegration } from '../server/orchestration/adapters/git-integration.mjs';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../server/orchestration/service.mjs';
import { AgentTools } from '../server/orchestration/agent-tools.mjs';
import { AgentCommits } from '../server/orchestration/adapters/agent-commits.mjs';
import { GitRepository, git } from '../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { createRepositoryFixture } from './helpers/orchestration/fixture.mjs';
import { SchedulerOwnership } from '../server/orchestration/storage/ownership.mjs';
import { BridgeAuthority } from '../server/orchestration/bridge-auth.mjs';
import { registerOrchestrationRoutes } from '../server/orchestration/routes.mjs';
import Fastify from 'fastify';
import { createBridge } from '../server/orchestration/bridge.mjs';
import { agentMcpRequest, writeMcpResponse } from '../server/orchestration/agent-mcp.mjs';

async function commitFixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const resources = await repositories.provision({ repositoryId: 'repo', operationId: 'operation', branch: 'companion/goal/attempt', baseSha: repo.baseSha });
  const attempt = { id: 'attempt', operationId: 'operation', role: 'implementer', baseSha: repo.baseSha, ...resources };
  const input = { repositoryId: 'repo', attempt, ownedAreas: ['src/a.mjs'], id: 'commit', expectedHead: repo.baseSha, message: 'Implement A', assertAuthorized: () => {} };
  await writeFile(join(resources.worktree, 'src/a.mjs'), 'export function a() { return 2; }\n');
  return { repo, repositories, input };
}

for (const boundary of ['proposed', 'advanced']) test(`scoped commit recovers ${boundary} without duplicating its branch commit`, async (t) => {
  const { repositories, input } = await commitFixture(t);
  const first = new AgentCommits({ repositories, failpoint: (point) => { if (point === boundary) throw new Error('lost response'); } });
  await assert.rejects(first.commit(input), /lost response/);
  const recovered = new AgentCommits({ repositories }); const result = await recovered.commit(input);
  assert.equal((await git(input.attempt.worktree, ['rev-list', '--count', `${input.expectedHead}..HEAD`])).trim(), '1');
  assert.equal(await repositories.checkCheckout(repositories.resource('operation')), result.headSha);
  assert.deepEqual(await recovered.commit(input), result);
  await assert.rejects(recovered.commit({ ...input, message: 'Different input' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('scoped commit refuses reviewed roles, wrong ownership, scope escape and revoked authority', async (t) => {
  const { repositories, input } = await commitFixture(t); const commits = new AgentCommits({ repositories });
  await assert.rejects(commits.commit({ ...input, attempt: { ...input.attempt, role: 'reviewer' } }), { code: 'FORBIDDEN' });
  await assert.rejects(commits.commit({ ...input, attempt: { ...input.attempt, branch: 'main' } }), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(commits.commit({ ...input, ownedAreas: ['src/b.mjs'] }), { code: 'SCOPE_VIOLATION' });
  let calls = 0;
  await assert.rejects(commits.commit({ ...input, assertAuthorized: () => { if (++calls > 1) throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' }); } }), { code: 'FORBIDDEN' });
  assert.equal((await git(input.attempt.worktree, ['rev-parse', 'HEAD'])).trim(), input.expectedHead);
});

test('MCP tools bind output identity and cannot expose approval or other roles tools', async () => {
  const submitted = [], context = { binding: { goalId: 'g', operationId: 'op', attemptId: 'a', generation: 1, revision: 1, role: 'planner', target: 'contract:1:1' }, bridge: {
    status: async () => ({ version: 1 }), submitResult: async (result) => { submitted.push(result); return { status: 'pending' }; }, commit: async () => { throw new Error('must not commit'); },
  } };
  const call = (name, args = {}) => agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, context);
  assert.equal((await call('approve')).result.isError, true);
  assert.equal((await call('commit_candidate')).result.isError, true);
  assert.equal((await call('submit_result', { id: 'result', output: { contract: {} }, goalId: 'other' })).result.isError, true);
  await call('submit_result', { id: 'result', output: { contract: {} } });
  assert.deepEqual(JSON.parse(submitted[0].raw), { schemaVersion: 1, ...context.binding, output: { contract: {} } });
  const reviewer = await agentMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...context, binding: { ...context.binding, role: 'reviewer' } });
  assert.deepEqual(reviewer.result.tools, []);
});

test('real agent HTTP commit binds to approved attempt and refuses reviewer, abort and owner loss', async (t) => {
  const { repo, repositories, input } = await commitFixture(t);
  const store = new OrchestrationStore({ path: join(repo.directory, 'state.sqlite') });
  const service = new OrchestrationService({ store, repositoryIds: new Set(['repo']), agents: { capabilities: [{ role: 'reviewer', mode: 'background' }, { role: 'implementer', mode: 'background' }] } });
  const ownership = new SchedulerOwnership({ store }); ownership.acquire(); service.ownership = ownership;
  const auth = new BridgeAuthority(store); let sequence = 0;
  const command = (type, payload, kind = 'system') => service.execute({ id: `c${++sequence}`, goalId: 'goal', expectedVersion: store.get('goal')?.version ?? 0, type, payload }, { kind });
  command('create_goal', { repositoryId: 'repo', title: 'Commit fixture', baseSha: repo.baseSha }, 'user');
  command('publish_contract', { contract: repo.contract }, 'user');
  command('request_attempt', { attemptId: 'reviewer', operationId: 'review_operation', role: 'reviewer', conversationId: 'review_conversation' });
  command('record_dispatch', { attemptId: 'reviewer', identity: 'review_worker', worktree: '/tmp/review', branch: 'review' });
  const reviewerSecret = auth.issue('goal', 'reviewer');
  command('record_review', { attemptId: 'reviewer', reviewId: 'review', review: { schemaVersion: 1, target: store.get('goal').attempts.find((attempt) => attempt.id === 'reviewer').target, disposition: 'accept', findings: [] } });
  command('record_stopped', { attemptId: 'reviewer' }); command('approve', { revision: 1 }, 'user');
  command('request_attempt', { attemptId: 'attempt', operationId: 'operation', role: 'implementer', taskId: 'A', conversationId: 'implement_conversation' });
  command('record_dispatch', { attemptId: 'attempt', identity: 'implement_worker', ...input.attempt });
  const implementerSecret = auth.issue('goal', 'attempt');
  const app = Fastify({ logger: false });
  registerOrchestrationRoutes(app, { service, token: 'paired-user-token-at-least-32-characters', bridgeAuth: auth, agentTools: new AgentTools({ service, commits: new AgentCommits({ repositories }) }) });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await app.close(); ownership.release(); store.close(); });
  const bridge = createBridge({ endpoint, credential: implementerSecret }), reviewer = createBridge({ endpoint, credential: reviewerSecret });
  const request = { id: 'commit', expectedHead: repo.baseSha, message: 'Implement A through scoped tool' };
  await assert.rejects(reviewer.commit(request), { code: 'FORBIDDEN' });
  const committed = await bridge.commit(request);
  assert.equal((await git(input.attempt.worktree, ['rev-parse', 'HEAD'])).trim(), committed.headSha);
  assert.deepEqual(await bridge.commit(request), committed);
  const configPath = join(repo.directory, 'mcp-config.json');
  const attempt = store.get('goal').attempts.find((entry) => entry.id === 'attempt');
  const binding = { goalId: 'goal', operationId: attempt.operationId, attemptId: attempt.id, generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target };
  const invokeMcp = async (credential) => {
    await writeFile(configPath, JSON.stringify({ endpoint, credential, binding }), { mode: 0o600 });
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['server/orchestration/agent-mcp.mjs', configPath], { timeout: 10000, maxBuffer: 8192 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'commit_candidate', arguments: request } }) + '\n');
    });
  };
  const actualMcp = await invokeMcp(implementerSecret);
  assert.deepEqual(JSON.parse(JSON.parse(actualMcp.stdout).result.content[0].text), committed);
  assert.ok(!JSON.stringify(actualMcp).includes(implementerSecret));
  const spoofedRole = await invokeMcp(reviewerSecret);
  assert.equal(JSON.parse(spoofedRole.stdout).result.isError, true);
  await assert.rejects(bridge.commit({ ...request, worktree: repo.repository }), { code: 'INVALID_COMMAND' });
  ownership.release(); await assert.rejects(bridge.commit(request), { code: 'OWNERSHIP_UNCERTAIN' }); ownership.acquire();
  command('abort', {}, 'user'); await assert.rejects(bridge.commit(request), { code: 'FORBIDDEN' });
});

test('agent commits require durable resource ownership before staging and during atomic advancement', async (t) => {
  const { repositories, input } = await commitFixture(t);
  const owner = 'refs/companion/resources/operation';
  await git(input.attempt.worktree, ['update-ref', '-d', owner]);
  await assert.rejects(new AgentCommits({ repositories }).commit(input), { code: 'OWNERSHIP_UNCERTAIN' });
  await git(input.attempt.worktree, ['update-ref', owner, input.attempt.baseSha]);
  const interrupted = new AgentCommits({ repositories, failpoint: (point) => {
    if (point === 'proposed') execFileSync('git', ['update-ref', '-d', owner], { cwd: input.attempt.worktree });
  } });
  await assert.rejects(interrupted.commit(input), { code: 'GIT_OPERATION_FAILED' });
  assert.equal((await git(input.attempt.worktree, ['rev-parse', 'HEAD'])).trim(), input.expectedHead);
});

test('commit scope is checked against the immutable captured tree despite concurrent index edits', async (t) => {
  const { repositories, input } = await commitFixture(t);
  const commits = new AgentCommits({ repositories, failpoint: (point) => {
    if (point !== 'tree_captured') return;
    writeFileSync(join(input.attempt.worktree, 'src/b.mjs'), 'export const unrelated = 9;\n');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '--', 'src/b.mjs'], { cwd: input.attempt.worktree });
  } });
  const result = await commits.commit(input);
  assert.equal((await git(input.attempt.worktree, ['diff', '--name-only', input.expectedHead, result.headSha])).trim(), 'src/a.mjs');
  assert.ok((await git(input.attempt.worktree, ['diff', '--cached', '--name-only'])).includes('src/b.mjs'));
});

test('scoped integrator commit works in the actual recorded sibling conflict repair checkout', async (t) => {
  const repo = await createRepositoryFixture({ conflict: true }); t.after(() => repo.close());
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  const integrations = new GitIntegration({ repositories });
  const a = await repo.checkout('a'), b = await repo.checkout('b');
  const headA = await repo.implement(a.worktree, 'A'), headB = await repo.implement(b.worktree, 'B');
  const integrated = await integrations.integrate({ goalId: 'goal', repositoryId: 'repo', operationId: 'integration_a', expectedHead: repo.baseSha, baseSha: repo.baseSha, candidateSha: headA });
  const conflict = await integrations.integrate({ goalId: 'goal', repositoryId: 'repo', operationId: 'integration_b', expectedHead: integrated.headSha, baseSha: repo.baseSha, candidateSha: headB });
  assert.equal(conflict.status, 'conflict');
  const attempt = { id: 'repair', operationId: 'repair_op', role: 'integrator', taskId: 'B', target: integrated.headSha, baseSha: integrated.headSha };
  Object.assign(attempt, await integrations.provisionRepair({ goalId: 'goal', repositoryId: 'repo', integrationOperationId: 'integration_b', attempt }));
  await writeFile(join(attempt.worktree, 'src/composition.mjs'), "export function composition() { return 'resolved'; }\n");
  const result = await new AgentCommits({ repositories }).commit({ repositoryId: 'repo', attempt, ownedAreas: repo.contract.tasks.find((task) => task.id === 'B').ownedAreas, id: 'resolve', expectedHead: attempt.baseSha, message: 'Resolve sibling conflict', assertAuthorized: () => {} });
  assert.equal(await repositories.checkCheckout(repositories.resource('repair_op')), result.headSha);
  assert.equal((await git(attempt.worktree, ['show', `${result.headSha}:src/b.mjs`])).trim(), 'export function b() { return 3; }');
});

test('MCP output bounds individual responses and stops on a client that does not read', { timeout: 10000 }, async (t) => {
  const output = new Writable({ write(chunk, encoding, done) { done(); } });
  await assert.rejects(writeMcpResponse({ data: 'x'.repeat(2 * 1024 * 1024) }, output), /response exceeds limit/);
  const directory = await mkdtemp(join(tmpdir(), 'orchestration-mcp-stalled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ endpoint: 'http://127.0.0.1:1', credential: 'unused-private-token', binding: { role: 'planner' }, outputDrainMs: 100 }), { mode: 0o600 });
  const child = spawn(process.execPath, ['server/orchestration/agent-mcp.mjs', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdout.pause(); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const exited = once(child, 'exit');
  child.stdin.end((JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n').repeat(10000));
  assert.equal((await exited)[0], 2); assert.equal(stderr, '');
});
