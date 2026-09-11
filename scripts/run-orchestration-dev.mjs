import { existsSync, renameSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDevelopmentServer } from '../server/orchestration/dev-server.mjs';
import { GitRemote } from '../server/orchestration/adapters/git-remote.mjs';
import { GitHubPublication } from '../server/orchestration/adapters/github.mjs';
import { createRepositoryFixture, fixtureGit } from '../tests/helpers/orchestration/fixture.mjs';
import { ScriptedAgents, barrier } from '../tests/helpers/orchestration/fake-agents.mjs';
import { FakeGitHub } from '../tests/helpers/orchestration/fake-github.mjs';

/** Account-free demo. All external adapters are fixed here, never selected by env. */
export async function startOrchestrationDemo({ port = 0, readOnly = false, browserHarness = false } = {}) {
  let fixtureAgents, fixtureGithub; const overlaps = new Set();
  const demo = await createDevelopmentServer({ port, configure: async (directory) => {
    const repo = await createRepositoryFixture();
    repo.contract.verification.push({ id: 'injected_dependencies', argv: ['node', '--input-type=module', '-e', "import { composition } from './src/composition.mjs'; if (composition(() => 7, () => 11) !== 18) process.exit(1);"] });
    const siblings = new Map(), shared = new Map();
    return {
      dispose: () => repo.close(),
      metadata: { repositoryId: 'repo', baseSha: repo.baseSha, repository: repo.repository, remote: repo.remote, browserHarness },
      options: {
        repositories: new Map([['repo', repo.repository]]), readOnly, limits: { global: 2, perGoal: 2 },
        createAgents: ({ onResult }) => {
          const agents = new ScriptedAgents({
            script: async ({ goalId, attempt }, { signal }) => {
              if (attempt.role === 'planner') return { contract: repo.contract };
              if (attempt.role === 'implementer') {
                if (['A', 'B'].includes(attempt.taskId)) {
                  if (!shared.has(goalId)) shared.set(goalId, barrier());
                  if (!siblings.has(goalId)) siblings.set(goalId, new Set());
                  siblings.get(goalId).add(attempt.taskId);
                  if (siblings.get(goalId).size === 2) { overlaps.add(goalId); shared.get(goalId).release(); }
                  await waitForBarrier(shared.get(goalId).promise, signal);
                  if (browserHarness) await waitForRelease(join(directory, 'release-siblings'), signal);
                }
                const prior = agents.launches.filter((entry) => entry.goalId === goalId && entry.attempt.taskId === 'C' && entry.attempt.role === 'implementer');
                const headSha = await repo.implement(attempt.worktree, attempt.taskId, { failing: attempt.taskId === 'C' && prior.length === 1 });
                return { headSha, summary: 'Implemented disposable fixture module', evidence: [] };
              }
              if (attempt.role === 'integrator') {
                if (browserHarness) await waitForRelease(join(directory, 'release-final'), signal);
                await writeFile(join(attempt.worktree, 'src/composition.mjs'), "import { a } from './a.mjs';\nimport { b } from './b.mjs';\nexport function composition(aSource = a, bSource = b) { return aSource() + bSource(); }\n");
                await fixtureGit(attempt.worktree, ['add', 'src']); await fixtureGit(attempt.worktree, ['commit', '-m', 'Repair injectable composition']);
                return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), operationId: null, summary: 'Repair final check failure', evidence: [] };
              }
              const failing = attempt.taskId === 'C' && !(await repo.verify(attempt.worktree)).passed;
              return { schemaVersion: 1, target: attempt.target, disposition: failing ? 'request_changes' : 'accept', findings: failing ? [{ id: 'composition_defect', severity: 'high', blocking: true, title: 'Composition does not add its inputs', evidence: 'Fixture acceptance test fails on review checkout', suggestion: 'Add the module results' }] : [] };
            },
            onResult: (request, output) => {
              const { goalId, operationId, attempt } = request;
              onResult(request, JSON.stringify({ schemaVersion: 1, goalId, operationId, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision, target: attempt.target, output }));
            },
          });
          fixtureAgents = agents;
          agents.close = async () => { for (const controller of agents.controllers.values()) controller.abort(); await agents.drain(); };
          return agents;
        },
        resolveCheck: (repositoryId, check) => {
          if (repositoryId !== 'repo' || !repo.contract.verification.some((approved) => JSON.stringify(approved) === JSON.stringify(check))) throw new Error('Unknown fixture verification command');
          return { bin: process.execPath, argv: check.argv.slice(1), env: { PATH: process.env.PATH }, environmentId: 'disposable-fixture-node', policy: { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 } };
        },
        createPublisher: ({ repositories }) => {
          const remote = new GitRemote({ repositories, directory: join(directory, 'remote-stage'), destinations: new Map([['repo', { url: realpathSync(repo.remote), protocol: 'file', env: { PATH: process.env.PATH } }]]) });
          fixtureGithub = new FakeGitHub({ remote });
          return new GitHubPublication({ directory: join(directory, 'publications'), remote, github: fixtureGithub });
        },
      },
    };
  } });
  if (browserHarness) {
    let writing = Promise.resolve();
    let recordingError;
    const record = () => {
      writing = writing.catch(error => { recordingError = error; }).then(async () => {
        const goals = demo.runtime.store.list();
        const evidence = { goals, overlaps: [...overlaps], launches: fixtureAgents?.launches ?? [], prCreates: fixtureGithub?.creates ?? [], pulls: fixtureGithub?.pulls ?? [] };
        const path = join(demo.manifest.directory, 'browser-evidence.json'), temporary = `${path}.tmp`;
        await writeFile(temporary, JSON.stringify(evidence), { mode: 0o600 }); renameSync(temporary, path);
      });
      void writing.catch(() => {});
    };
    const timer = setInterval(record, 100); record();
    const close = demo.close.bind(demo);
    demo.close = async () => { clearInterval(timer); try { await writing; if (recordingError) throw recordingError; } finally { await close(); } };
  }
  return demo;
}
async function waitForRelease(path, signal) {
  while (!existsSync(path)) { signal.throwIfAborted(); await delay(25, undefined, { signal }); }
}

async function waitForBarrier(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try { await Promise.race([promise, new Promise((resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2); let port = 0, readOnly = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--port' && /^[0-9]+$/.test(args[i + 1] ?? '')) port = Number(args[++i]);
      else if (args[i] === '--read-only') readOnly = true;
      else throw new Error('Usage: npm run orchestration:dev -- [--port 3211] [--read-only]');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port');
    const demo = await startOrchestrationDemo({ port, readOnly });
    process.stdout.write(`${JSON.stringify({ address: demo.manifest.address, manifestFile: demo.manifestFile, tokenFile: demo.manifest.tokenFile })}\n`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; try { await demo.close(); } catch { process.stderr.write('Fixture shutdown failed; retained resources require inspection.\n'); process.exitCode = 1; } };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { process.stderr.write(`Disposable orchestration startup failed (${error.code ?? 'configuration'}).\n`); process.exitCode = 1; }
}
