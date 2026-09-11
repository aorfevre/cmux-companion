import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startOrchestrationDemo } from '../scripts/run-orchestration-dev.mjs';
import { fixtureGit } from './helpers/orchestration/fixture.mjs';

test('disposable development composition delivers through paired HTTP and real Git checks', { timeout: 60000 }, async (t) => {
  const demo = await startOrchestrationDemo(); t.after(() => demo.close());
  const { runtime, manifest } = demo;
  const token = await readFile(manifest.tokenFile, 'utf8');
  assert.equal((await stat(manifest.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(manifest.directory)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(demo.manifestFile, 'utf8')).includes(token));
  const headers = { authorization: `Bearer ${token}`, origin: manifest.address, 'content-type': 'application/json' };
  const command = async (body) => {
    const response = await fetch(`${manifest.address}/api/orchestration/commands`, { method: 'POST', headers, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  await command({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: manifest.repositoryId, title: 'Disposable browser fixture', baseSha: manifest.baseSha } });
  const agents = runtime.service.agents;
  for (let i = 0; i < 10 && !runtime.store.get('g').reviews.length; i++) { await runtime.scheduler.tick(); await agents.drain(); }
  let goal = runtime.store.get('g'); assert.equal(goal.reviews[0].disposition, 'accept');
  await command({ id: 'approve', goalId: 'g', expectedVersion: goal.version, type: 'approve', payload: { revision: goal.revision } });
  for (let i = 0; i < 35 && runtime.store.get('g').status !== 'delivered'; i++) {
    await runtime.scheduler.tick(); await agents.drain();
    await Promise.all([...runtime.scheduler.verifications.active.values()].map((run) => run.job));
    await Promise.all([...runtime.scheduler.publications.active.values()].map((run) => run.job));
  }
  goal = runtime.store.get('g'); assert.deepEqual(agents.errors, []);
  assert.equal(goal.status, 'delivered', JSON.stringify(goal));
  assert.equal(goal.tasks.find((task) => task.id === 'C').repairCount, 1);
  assert.equal(goal.finalRepairCount, 1);
  assert.ok(goal.verificationRuns.some((run) => run.result?.verification.checks.some((check) => !check.passed)));
  assert.ok(goal.verification.checks.every((check) => check.passed));
  assert.equal(goal.pr.headSha, goal.integrationHead);
  assert.equal(await fixtureGit(manifest.remote, ['rev-parse', `refs/heads/${goal.publication.plan.branch}`]), goal.pr.headSha);
  assert.equal(runtime.scheduler.publications.publisher.github.creates.length, 1);
  await demo.close(); await assert.rejects(access(manifest.directory), { code: 'ENOENT' });
});

test('CLI prints private file paths without token and cleans only its disposable resources on SIGTERM', { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ['scripts/run-orchestration-dev.mjs', '--port', '0', '--read-only'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CMUX_COMPANION_TOKEN: 'must-never-appear-or-be-used', CMUX_COMPANION_PORT: '1', CMUX_COMPANION_API: 'https://invalid.example', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let output = '', errors = ''; child.stderr.on('data', (data) => { errors += data; });
  const info = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error(`Early exit: ${errors}`)));
    child.stdout.on('data', (data) => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
  });
  const token = await readFile(info.tokenFile, 'utf8'); assert.ok(!output.includes(token)); assert.ok(!output.includes('must-never'));
  const snapshot = await (await fetch(`${info.address}/api/orchestration/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(snapshot.readOnly, true);
  const exited = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0, errors);
  await assert.rejects(access(info.manifestFile), { code: 'ENOENT' });
});
