import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalSettings, defaultSettings } from '../server/local-settings.mjs';
import { createSettingsRuntime } from '../server/settings-runtime.mjs';
import { buildApp } from '../server/app.mjs';
import { contract } from './helpers/orchestration/domain-fixture.mjs';
import { planTarget } from '../server/orchestration/domain/transitions.mjs';
import { FakeAgents } from './helpers/orchestration/fake-agents.mjs';
const token = 'x'.repeat(48), headers = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}` };
async function fixture(t, overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'settings-runtime-')));
  const settings = new LocalSettings({ path: join(directory, 'settings.sqlite') });
  const path = join(directory, 'repo'); mkdirSync(path);
  execFileSync('git', ['init', '-q', '--initial-branch=main', path]);
  execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Initial']);
  const acquired = [], launched = [];
  const options = { settings, directory, token, probeGit: async () => {},
    own: async repositories => { acquired.push([...repositories.keys()]); return { assertOwned() {}, close() {} }; },
    probeProvider: async () => ({ ready: true }),
    createAgents: ({ config }) => { const agent = new FakeAgents(); launched.push(config); return Object.assign(agent, { close: async () => {} }); },
  };
  Object.assign(options, overrides);
  const runtime = await createSettingsRuntime(options), extraRuntimes = [];
  await runtime.app.register(app => buildApp({ app, token, localSettings: settings, probeProvider: async () => ({ ready: true }), onSettingsChange: runtime.settingsChanged }));
  t.after(async () => { for (const extra of extraRuntimes) await extra.close(); await runtime.close(); settings.close(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, settings, path, acquired, launched, options, extraRuntimes };
}
test('fresh paired runtime exposes setup without native probes or configured repositories', async t => {
  const { runtime, acquired, launched } = await fixture(t);
  assert.equal((await runtime.app.inject({ url: '/api/settings/local' })).statusCode, 401);
  const response = await runtime.app.inject({ url: '/api/settings/local', headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().settings.onboarding.completed, false);
  assert.deepEqual((await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories, []);
  assert.deepEqual(acquired, []); assert.deepEqual(launched, []);
});
test('saving a project immediately populates goals and admission snapshots configuration', async t => {
  const { runtime, settings, path, acquired } = await fixture(t);
  const value = defaultSettings(); value.projects.push({ id: 'project', name: 'My project', path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [{ id: 'test', executable: 'npm', args: ['test'] }] });
  const update = await runtime.app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { expectedRevision: 0, settings: value } });
  assert.equal(update.statusCode, 200);
  const configuration = (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json();
  assert.equal(configuration.repositories[0].name, 'My project');
  const project = configuration.repositories[0];
  const command = { id: 'create-one', goalId: 'goal-one', expectedVersion: 0, type: 'create_goal', payload: { title: 'A goal', repositoryId: 'project', baseSha: project.baseSha, baseBranch: 'main' } };
  const created = await runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: command });
  assert.equal(created.statusCode, 200, created.body); assert.deepEqual(acquired, [['project']]);
  assert.equal(settings.goalConfiguration('goal-one').provider, 'claude');
  value.projects[0].enabled = false; value.provider = 'codex';
  await settings.update(1, value); await runtime.settingsChanged();
  const disabled = (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories;
  assert.equal(disabled[0].name, 'My project'); assert.equal(disabled[0].enabled, false); assert.match(disabled[0].error, /disabled/);
  assert.equal((await runtime.app.inject({ url: '/api/orchestration/goals/goal-one', headers })).statusCode, 200);
  assert.equal(settings.goalConfiguration('goal-one').provider, 'claude');
  const denied = await runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { ...command, id: 'create-two', goalId: 'goal-two' } });
  assert.equal(denied.statusCode, 409); assert.equal(settings.goalConfiguration('goal-two'), null);
});

test('scheduler recovery uses the original provider after settings edits and project disabling', async t => {
  const { runtime, settings, path, launched, options, extraRuntimes } = await fixture(t);
  const { setTimeout: delay } = await import('node:timers/promises');
  const value = defaultSettings();
  value.projects.push({ id: 'project', name: 'Project', path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [{ id: 'test', executable: 'npm', args: ['test'] }] });
  await settings.update(0, value); await runtime.settingsChanged();
  const project = (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  const response = await runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { id: 'create', goalId: 'recover', expectedVersion: 0, type: 'create_goal', payload: { title: 'Recover', repositoryId: 'project', baseBranch: 'main', baseSha: project.baseSha } } });
  assert.equal(response.statusCode, 200, response.body);
  await runtime.listen({ port: 0 });
  const deadline = Date.now() + 5000;
  while (!launched.length && Date.now() < deadline) await delay(20);
  assert.equal(launched[0].provider, 'claude');
  value.provider = 'codex'; value.projects[0].enabled = false; value.execution.global = 7;
  await settings.update(1, value); await runtime.settingsChanged();
  await runtime.close();
  const reopened = await createSettingsRuntime(options); extraRuntimes.push(reopened);
  await reopened.listen({ port: 0 });
  const recoveryDeadline = Date.now() + 5000;
  while (launched.length < 2 && Date.now() < recoveryDeadline) await delay(20);
  assert.equal(launched[1].provider, 'claude');
  assert.equal(launched[1].execution.global, 4);
  assert.equal(reopened.store.get('recover').repositoryId, 'project');
  assert.equal(settings.read().settings.provider, 'codex');
  assert.equal(settings.read().settings.projects[0].enabled, false);
});

test('a missing recorded project keeps history accessible without starting effects', async t => {
  const { runtime, settings, path, options, extraRuntimes, launched } = await fixture(t);
  const value = defaultSettings();
  value.projects.push({ id: 'project', name: 'Unavailable project', path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [{ id: 'test', executable: 'npm', args: ['test'] }] });
  await settings.update(0, value); await runtime.settingsChanged();
  const project = (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  const command = { id: 'create', goalId: 'history', expectedVersion: 0, type: 'create_goal', payload: { title: 'Keep history', repositoryId: 'project', baseBranch: 'main', baseSha: project.baseSha } };
  assert.equal((await runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: command })).statusCode, 200);
  await runtime.close(); rmSync(path, { recursive: true });
  const reopened = await createSettingsRuntime({ ...options, own: async () => { realpathSync(path); throw new Error('Expected missing directory'); } });
  extraRuntimes.push(reopened); await reopened.listen({ port: 0 });
  const configuration = (await reopened.app.inject({ url: '/api/orchestration/configuration', headers })).json();
  assert.equal(configuration.readOnly, true); assert.match(configuration.suspensionReason, /Restore the saved project directory/);
  assert.equal((await reopened.app.inject({ url: '/api/orchestration/goals/history', headers })).statusCode, 200);
  assert.equal((await reopened.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { ...command, id: 'another', goalId: 'another' } })).statusCode, 403);
  assert.equal(reopened.scheduler.stopped, true); assert.deepEqual(launched, []);
});

test('repository readiness asks only for missing setup and preserves admission checks', async t => {
  const { runtime, settings, path } = await fixture(t);
  const value = defaultSettings(); value.projects = [{ id: 'project', name: 'Example', path, enabled: true, github: 'example/repo', remote: 'git@github.com:example/repo.git', checks: [] }];
  await settings.update(0, value); await runtime.settingsChanged();
  const config = async () => (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  const project = await config(); assert.equal(project.setupLabel, 'Repository ready'); assert.equal(project.error, null);
  const created = await runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { id: 'missing-check', goalId: 'missing-check', expectedVersion: 0, type: 'create_goal', payload: { title: 'Needs checks', repositoryId: 'project', baseSha: project.baseSha, baseBranch: 'main' } } });
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(settings.goalConfiguration('missing-check').project.checks, []);
  value.projects[0].checks = [{ id: 'test', executable: 'npm', args: ['test'] }];
  await settings.update(1, value); assert.equal((await config()).setupLabel, 'Repository ready'); assert.equal((await config()).error, null);
  value.projects[0].github = null; await settings.update(2, value);
  assert.equal((await config()).setupLabel, 'Check GitHub remote');
});

test('checks discovered after creation resolve from the approved journal after runtime restart', async t => {
  const { runtime, settings, path, options, extraRuntimes } = await fixture(t);
  const value = defaultSettings(); value.projects = [{ id: 'project', name: 'Project', path, enabled: true, github: 'example/repo', remote: 'git@github.com:example/repo.git', checks: [] }];
  await settings.update(0, value); await runtime.settingsChanged();
  const project = (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  const response = await runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { id: 'create', goalId: 'discovered', expectedVersion: 0, type: 'create_goal', payload: { title: 'Discover validation', repositoryId: 'project', baseSha: project.baseSha, baseBranch: 'main' } } });
  assert.equal(response.statusCode, 200, response.body);
  let n = 0;
  const apply = (type, payload, kind = 'system') => runtime.store.apply({ id: `proof-${++n}`, goalId: 'discovered', expectedVersion: runtime.store.get('discovered').version, type, payload }, { kind });
  const plan = contract(); plan.schemaVersion = 2; plan.tasks = plan.tasks.map(task => ({ ...task, resources: [] })); plan.waves = [{ id: 'modules', title: 'Modules', taskIds: ['A', 'B'], checkIds: ['unit'] }, { id: 'composition', title: 'Composition', taskIds: ['C'], checkIds: ['unit'] }];
  apply('publish_contract', { contract: plan }, 'user');
  const resolver = runtime.scheduler.verifications.verifier.resolveCheck;
  assert.throws(() => resolver('project', plan.verification[0], 'discovered'), { code: 'NOT_READY' });
  apply('request_attempt', { attemptId: 'review', operationId: 'review-op', role: 'reviewer', taskId: null, conversationId: 'review-conversation' });
  apply('record_dispatch', { attemptId: 'review', identity: 'review-process', worktree: path, branch: 'goal/review' });
  apply('record_review', { attemptId: 'review', reviewId: 'review-result', review: { schemaVersion: 1, target: planTarget(runtime.store.get('discovered')), disposition: 'accept', findings: [] } });
  apply('record_stopped', { attemptId: 'review' });
  apply('approve', { revision: 1 }, 'user');
  assert.deepEqual(resolver('project', plan.verification[0], 'discovered').argv, ['--test']);
  await runtime.close();
  const reopened = await createSettingsRuntime(options); extraRuntimes.push(reopened);
  const restored = reopened.scheduler.verifications.verifier.resolveCheck;
  assert.deepEqual(restored('project', plan.verification[0], 'discovered').argv, ['--test']);
  assert.throws(() => restored('project', { id: 'unit', argv: ['node', '--version'] }, 'discovered'), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.deepEqual(settings.goalConfiguration('discovered').project.checks, []);
});

test('new goal persists once before provider checks and exposes a retryable startup failure', async t => {
  const f = await fixture(t), value = defaultSettings();
  value.projects.push({ id: 'project', name: 'My project', path: f.path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [] });
  await f.settings.update(0, value); await f.runtime.settingsChanged();
  const command = { id: 'new-create', goalId: 'new-goal', expectedVersion: 0, type: 'create_goal', payload: { title: 'Do the work', description: 'Do the work', repositoryId: 'project' } };
  const post = () => f.runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: command });
  assert.equal((await post()).statusCode, 200);
  assert.equal((await post()).statusCode, 200);
  assert.equal(f.runtime.store.list().length, 1);
  assert.equal(f.runtime.store.get('new-goal').startup.status, 'pending');
  assert.equal(f.runtime.store.get('new-goal').baseBranch, 'main');
  assert.deepEqual(f.acquired, []); assert.deepEqual(f.launched, []);
  await f.runtime.close();
  const reopened = await createSettingsRuntime({ ...f.options, probeProvider: async () => ({ ready: false, reason: 'Sign into the planning provider, then retry startup' }) });
  f.extraRuntimes.push(reopened);
  await reopened.listen({ port: 0 });
  assert.equal(reopened.store.get('new-goal').startup.status, 'failed');
  assert.match(reopened.store.get('new-goal').startup.error, /Sign into/);
  assert.deepEqual(f.launched, []);
});

test('terminal provider resolution is frozen before goal creation and reused after alias changes and restart', async t => {
  const f = await fixture(t), value = defaultSettings();
  value.projects.push({ id: 'project', name: 'Project', path: f.path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [] });
  value.provider = 'codex'; value.providers.codex = { executable: 'xcodex', args: [], model: 'default' };
  await f.settings.update(0, value); await f.runtime.close();
  const resolution = { version: 1, provider: 'codex', kind: 'ccsxp', executable: '/pinned/ccsxp-runtime.js', args: [], model: 'default' };
  let resolutions = 0;
  const configured = await createSettingsRuntime({ ...f.options, resolveProviderCommand: async () => { resolutions++; return resolution; } });
  f.extraRuntimes.push(configured);
  const command = { id: 'alias-create', goalId: 'alias-goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'project', title: 'A saved goal', description: 'A saved goal' } };
  for (let retry = 0; retry < 2; retry++) assert.equal((await configured.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: command })).statusCode, 200);
  assert.equal(resolutions, 2, 'both eligible provider profiles are frozen once; retry does not resolve again'); assert.deepEqual(f.settings.goalConfiguration('alias-goal').providerResolution, resolution);
  await configured.close();
  const seen = [];
  const restarted = await createSettingsRuntime({ ...f.options, resolveProviderCommand: async () => { throw new Error('Saved alias must not be looked up again'); },
    probeProvider: async (provider, command, tools, frozen) => { seen.push(frozen); return { ready: false, reason: 'Fixture stops before external Git' }; },
  });
  f.extraRuntimes.push(restarted);
  await restarted.listen({ port: 0 }); await Promise.all(restarted.scheduler.startupJobs.values());
  assert.deepEqual(seen, [resolution]); assert.equal(restarted.store.get('alias-goal').startup.status, 'failed');
});

for (const stage of ['preparation', 'launch']) test(`provider ${stage} failure retains correct worker evidence across restart`, async t => {
  let constructions = 0, launches = 0;
  const f = await fixture(t, { createAgents: () => {
    constructions++;
    if (stage === 'preparation') throw new Error('private installation detail');
    const agent = new FakeAgents();
    return Object.assign(agent, { close: async () => {}, observe: async () => ({ status: 'unknown', identity: null }), launch: async () => { launches++; throw new Error('response lost after delegation'); } });
  } });
  const value = defaultSettings();
  value.projects = [{ id: 'project', name: 'Project', path: f.path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [] }];
  await f.settings.update(0, value); await f.runtime.settingsChanged();
  const project = (await f.runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  const created = await f.runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { id: 'create', goalId: 'failure', expectedVersion: 0, type: 'create_goal', payload: { title: 'Failure', repositoryId: 'project', baseBranch: 'main', baseSha: project.baseSha } } });
  assert.equal(created.statusCode, 200, created.body);
  await f.runtime.listen({ port: 0 }); await f.runtime.scheduler.tick();
  const attempt = f.runtime.store.get('failure').attempts[0];
  assert.equal(attempt.workerState, stage === 'preparation' ? 'stopped' : 'unknown');
  assert.equal(attempt.status, stage === 'preparation' ? 'failed' : 'uncertain');
  assert.equal(launches, stage === 'preparation' ? 0 : 1);
  if (stage === 'preparation') {
    assert.match(attempt.error, /saved provider could not be prepared/);
    assert.doesNotMatch(attempt.error, /private installation detail/);
    assert.equal(f.runtime.store.operations().some(operation => operation.id === attempt.operationId), false, 'completed intent is no longer pending');
  }
  await f.runtime.close();
  const beforeRestart = constructions;
  const restarted = await createSettingsRuntime(f.options); f.extraRuntimes.push(restarted);
  await restarted.listen({ port: 0 }); await restarted.scheduler.tick();
  assert.equal(restarted.store.get('failure').attempts[0].workerState, attempt.workerState);
  if (stage === 'preparation') assert.equal(constructions, beforeRestart, 'durable stopped evidence does not require a provider reprobe');
  assert.equal(launches, stage === 'preparation' ? 0 : 1, 'restart never repeats delegated work');
});

test('saved-settings runtime passively observes only waiting PRs through their original destination', async t => {
  const calls = [];
  const { runtime, settings, path } = await fixture(t, { publisherFactory: ({ config, goalId }) => ({
    publish: async () => { throw new Error('Passive observation must never publish'); },
    observe: async () => { throw new Error('No pending publication'); },
    observeMerge: async (input, pr) => { calls.push({ goalId, destination: config.project.github, input, pr }); return { ...pr, state: 'merged' }; },
  }) });
  const value = defaultSettings(); value.projects = [{ id: 'project', name: 'Project', path, enabled: true, github: 'example/original', remote: 'git@github.com:example/original.git', checks: [] }];
  await settings.update(0, value); await runtime.settingsChanged();
  const project = (await runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  for (const id of ['waiting', 'already-merged']) {
    settings.snapshotGoal(id, 'project');
    runtime.store.apply({ id: `create-${id}`, goalId: id, expectedVersion: 0, type: 'create_goal', payload: { title: id, repositoryId: 'project', baseSha: project.baseSha } }, { kind: 'user' });
    const goal = runtime.store.get(id);
    runtime.store.apply({ id: `seed-${id}`, goalId: id, expectedVersion: goal.version, type: 'seed', payload: {} }, { kind: 'system' }, () => ({
      goal: { ...goal, version: goal.version + 1, status: id === 'waiting' ? 'delivered' : 'merged', pr: { number: 7, url: 'https://github.com/example/original/pull/7', headSha: project.baseSha }, publication: { plan: { goalId: id, repositoryId: 'project' } } }, events: [], intents: [],
    }));
  }
  value.projects[0].github = 'example/new-destination'; await settings.update(1, value);
  await runtime.listen({ port: 0 });
  await Promise.all(runtime.scheduler.merges.active.values());
  assert.equal(runtime.store.get('waiting').status, 'merged');
  assert.equal(calls.length, 1); assert.equal(calls[0].goalId, 'waiting'); assert.equal(calls[0].destination, 'example/original');
  await runtime.scheduler.tick(); assert.equal(calls.length, 1, 'completed cards leave the polling set');
});

test('task profile overrides route real scheduler launches and remain frozen after settings changes and restart', async t => {
  const f = await fixture(t), value = defaultSettings();
  value.projects = [{ id: 'project', name: 'Project', path: f.path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [] }];
  await f.settings.update(0, value); await f.runtime.settingsChanged();
  const project = (await f.runtime.app.inject({ url: '/api/orchestration/configuration', headers })).json().repositories[0];
  const created = await f.runtime.app.inject({ method: 'POST', url: '/api/orchestration/commands', headers, payload: { id: 'create', goalId: 'routed', expectedVersion: 0, type: 'create_goal', payload: { title: 'Route tasks', repositoryId: 'project', baseSha: project.baseSha } } });
  assert.equal(created.statusCode, 200, created.body);
  let id = 0;
  const command = (type, payload, kind = 'system') => f.runtime.service.execute({ id: `route-${++id}`, goalId: 'routed', expectedVersion: f.runtime.store.get('routed').version, type, payload }, { kind });
  const plan = contract(); plan.schemaVersion = 2; plan.tasks = plan.tasks.map(task => ({ ...task, resources: [] }));
  plan.waves = [{ id: 'modules', title: 'Modules', taskIds: ['A', 'B'], checkIds: ['unit'] }, { id: 'compose', title: 'Compose', taskIds: ['C'], checkIds: ['unit'] }];
  command('publish_contract', { contract: plan }, 'user');
  command('override_assignment', { key: 'implementer:A', profileId: 'codex' }, 'user');
  command('request_attempt', { attemptId: 'review', operationId: 'review-op', role: 'reviewer', conversationId: 'review-conversation' });
  command('record_dispatch', { attemptId: 'review', identity: 'review-process', worktree: '/tmp/review', branch: 'review' });
  command('record_review', { attemptId: 'review', reviewId: 'review-result', review: { schemaVersion: 1, target: planTarget(f.runtime.store.get('routed')), disposition: 'accept', findings: [] } });
  command('record_stopped', { attemptId: 'review' }); command('approve', { revision: 1 }, 'user');
  await f.runtime.listen({ port: 0 }); await f.runtime.scheduler.tick();
  const assignments = f.runtime.store.get('routed').attempts.filter(attempt => attempt.role === 'implementer').map(attempt => ({ taskId: attempt.taskId, assignment: attempt.assignment }));
  assert.equal(assignments.find(entry => entry.taskId === 'A').assignment.provider, 'codex');
  assert.equal(assignments.find(entry => entry.taskId === 'B').assignment.provider, 'claude');
  assert.deepEqual(f.launched.map(config => config.provider).sort(), ['claude', 'codex']);
  assert.ok(f.launched.every(config => config.command.model === 'default'));
  value.provider = 'codex'; value.providers.codex.model = 'gpt-5.4'; value.providers.claude.model = 'sonnet';
  await f.settings.update(1, value); await f.runtime.close();
  const reopened = await createSettingsRuntime(f.options); f.extraRuntimes.push(reopened);
  await reopened.listen({ port: 0 }); await reopened.scheduler.tick();
  assert.deepEqual(reopened.store.get('routed').attempts.filter(attempt => attempt.role === 'implementer').map(attempt => ({ taskId: attempt.taskId, assignment: attempt.assignment })), assignments);
  assert.deepEqual(f.launched.slice(2).map(config => config.provider).sort(), ['claude', 'codex']);
  assert.ok(f.launched.slice(2).every(config => config.command.model === 'default'));
});
test('verification prepare is read from the live project setting so a held goal recovers after Setup changes', async t => {
  const resolved = [];
  const { runtime, settings, path } = await fixture(t, { resolvePrepare: project => { resolved.push(project.prepare); return null; } });
  const value = defaultSettings(); value.projects.push({ id: 'project', name: 'Project', path, enabled: true, github: 'example/project', remote: 'git@github.com:example/project.git', checks: [], prepare: { source: 'disabled' } });
  assert.equal((await runtime.app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { expectedRevision: 0, settings: value } })).statusCode, 200);
  settings.snapshotGoal('goal-x', 'project');
  runtime.resolvePrepareForTest('project', 'goal-x');
  const next = settings.read(); next.settings.projects[0].prepare = { source: 'custom', executable: 'npm', args: ['ci'] };
  assert.equal((await runtime.app.inject({ method: 'PUT', url: '/api/settings/local', headers, payload: { expectedRevision: next.revision, settings: next.settings } })).statusCode, 200);
  runtime.resolvePrepareForTest('project', 'goal-x');
  assert.throws(() => runtime.resolvePrepareForTest('other', 'goal-x'), { code: 'FORBIDDEN' });
  assert.deepEqual(resolved, [{ source: 'disabled' }, { source: 'custom', executable: 'npm', args: ['ci'] }]);
});

test('the saved-settings publisher forwards every publication port method to the goal adapter', async t => {
  const calls = [];
  const record = name => (input, second) => { calls.push({ name, goalId: input.goalId, second }); return Promise.resolve(null); };
  const { runtime, settings, path } = await fixture(t, { publisherFactory: ({ goalId }) => ({
    publish: record('publish'), observe: record('observe'), observeMerge: record('observeMerge'),
    reviewThreads: (input, pr) => { calls.push({ name: 'reviewThreads', goalId, second: pr }); return Promise.resolve([]); },
    pushFix: (input, fix) => { calls.push({ name: 'pushFix', goalId, second: fix }); return Promise.resolve('pushed'); },
    replyAndResolve: (input, fix) => { calls.push({ name: 'replyAndResolve', goalId, second: fix }); return Promise.resolve({ posted: [], unconfirmed: [], resolved: [] }); },
  }) });
  const value = defaultSettings(); value.projects = [{ id: 'project', name: 'Project', path, enabled: true, github: 'example/original', remote: 'git@github.com:example/original.git', checks: [] }];
  await settings.update(0, value); await runtime.settingsChanged();
  settings.snapshotGoal('goal', 'project');
  const publisher = runtime.scheduler.reviewFixes.publisher;
  // A dropped method reads to the coordinator as a missing capability and the
  // round then fails as if GitHub were unreachable.
  for (const name of ['publish', 'observe', 'observeMerge', 'reviewThreads', 'pushFix', 'replyAndResolve']) {
    assert.equal(typeof publisher[name], 'function', `${name} must be forwarded`);
  }
  const plan = { goalId: 'goal', repositoryId: 'project' };
  await publisher.reviewThreads(plan, { number: 7 });
  await publisher.pushFix(plan, { roundId: 'r1' });
  await publisher.replyAndResolve(plan, { roundId: 'r1', replies: [] });
  assert.deepEqual(calls.map(entry => entry.name), ['reviewThreads', 'pushFix', 'replyAndResolve']);
  assert.ok(calls.every(entry => entry.goalId === 'goal'), 'each call addresses the adapter bound to that goal');
});
