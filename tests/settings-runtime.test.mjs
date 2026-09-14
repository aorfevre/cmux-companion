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
async function fixture(t) {
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
  const plan = contract();
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
