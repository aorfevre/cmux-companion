import { DomainError, object } from '../server/orchestration/domain/contracts.mjs';
import { existsSync, renameSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDevelopmentServer } from '../server/orchestration/dev-server.mjs';
import { GitRemote } from '../server/orchestration/adapters/git-remote.mjs';
import { GitHubPublication } from '../server/orchestration/adapters/github.mjs';
import { ReviewMerge } from '../server/orchestration/adapters/review-merge.mjs';
import { createRepositoryFixture, fixtureGit } from '../tests/helpers/orchestration/fixture.mjs';
import { ScriptedAgents, barrier } from '../tests/helpers/orchestration/fake-agents.mjs';
import { FakeGitHub } from '../tests/helpers/orchestration/fake-github.mjs';

/** Account-free demo. All external adapters are fixed here, never selected by env. */
export async function startOrchestrationDemo({ port = 0, readOnly = false, browserHarness = false } = {}) {
  let fixtureAgents, fixtureGithub, fixtureRemote; const overlaps = new Set();
  const demo = await createDevelopmentServer({ port, configure: async (directory) => {
    const repo = await createRepositoryFixture();
    repo.contract.verification.push({ id: 'injected_dependencies', argv: ['node', '--input-type=module', '-e', "import { composition } from './src/composition.mjs'; if (composition(() => 7, () => 11) !== 18) process.exit(1);"] });
    repo.contract.schemaVersion = 2;
    repo.contract.tasks = repo.contract.tasks.map(task => ({ ...task, resources: [] }));
    repo.contract.verification.unshift({ id: 'modules', argv: ['node', '--input-type=module', '-e', "import { a } from './src/a.mjs'; import { b } from './src/b.mjs'; if (a() !== 2 || b() !== 3) process.exit(1);"] });
    repo.contract.waves = [{ id: 'modules', title: 'Independent modules', taskIds: ['A', 'B'], checkIds: ['modules'] }, { id: 'composition', title: 'Compose verified outputs', taskIds: ['C'], checkIds: repo.contract.verification.map(check => check.id) }];
    const siblings = new Map(), shared = new Map();
    return {
      dispose: () => repo.close(),
      metadata: { repositoryId: 'repo', baseSha: repo.baseSha, repository: repo.repository, remote: repo.remote, browserHarness },
      options: {
        repositories: new Map([['repo', repo.repository]]), readOnly, limits: { global: 2, perGoal: 2 },
        beforeCommand: async command => {
          if (command.type !== 'create_goal') return;
          object(command.payload).teamConfiguration = {
            capturedAt: '2026-09-15T10:00:00.000Z', defaults: { planner: 'claude', implementer: 'claude', reviewer: 'claude', integrator: 'claude' },
            profiles: ['claude', 'codex'].map(provider => ({ id: provider, label: `${provider} fixture`, provider, model: 'fixture', roles: ['planner', 'implementer', 'reviewer', 'integrator'], ready: true, reason: 'Disposable fake adapter', capacity: { remainingPercent: null, source: 'Fixture', checkedAt: null, reason: 'No live quota lookup in the disposable fixture.' } })),
          };
        },
        prepareGoal: goal => fixtureRemote.fetchBase(goal.repositoryId, goal.baseBranch),
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
              if (attempt.role === 'review_fixer') {
                const current = demo.runtime.store.get(goalId), pinned = current?.reviewRound?.threads ?? [];
                await writeFile(join(attempt.worktree, 'src/a.mjs'), 'export function a() { return 2; } // addressed review\n');
                await fixtureGit(attempt.worktree, ['add', 'src']); await fixtureGit(attempt.worktree, ['commit', '-m', 'Address review comments']);
                return { headSha: await fixtureGit(attempt.worktree, ['rev-parse', 'HEAD']), summary: 'Addressed the fixture review threads',
                  replies: pinned.map((thread, index) => ({ threadId: thread.id, action: index === 0 ? 'fixed' : 'declined', body: index === 0 ? 'Fixed in the latest commit.' : 'Out of scope for this goal.' })) };
              }
              if (browserHarness && attempt.target.startsWith('contract:') && existsSync(join(directory, 'release-reject-plan'))
                && agents.launches.filter(entry => entry.goalId === goalId && entry.attempt.role === 'reviewer' && entry.attempt.target.startsWith('contract:')).length === 1) {
                return { schemaVersion: 1, target: attempt.target, disposition: 'request_changes', findings: [{ id: 'plan_scope', severity: 'high', blocking: true, title: 'Clarify the fixture plan', evidence: 'First plan needs a review round', suggestion: 'Republish the bounded fixture contract' }] };
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
        resolvePrepare: (repositoryId) => {
          if (repositoryId !== 'repo') throw new Error('Unknown fixture repository');
          return { bin: process.execPath, argv: ['-e', "require('node:fs').mkdirSync('node_modules', { recursive: true }); console.log('fixture prepare')"], env: { PATH: process.env.PATH }, environmentId: 'disposable-fixture-prepare', policy: { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 } };
        },
        resolveCheck: (repositoryId, check) => {
          if (repositoryId !== 'repo' || !repo.contract.verification.some((approved) => JSON.stringify(approved) === JSON.stringify(check))) throw new Error('Unknown fixture verification command');
          // Keep fast fixture checks alive until the watchdog records their PID.
          return {
            bin: process.execPath, argv: check.argv.slice(1),
            env: { PATH: process.env.PATH, NODE_OPTIONS: `--import=${new URL('../tests/helpers/orchestration/await-verification-identity.mjs', import.meta.url).href}`, CMUX_COMPANION_FIXTURE_CHECK: check.id },
            environmentId: 'disposable-fixture-node', policy: { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 },
          };
        },
        createPublisher: ({ repositories }) => {
          const remote = new GitRemote({ repositories, directory: join(directory, 'remote-stage'), destinations: new Map([['repo', { url: realpathSync(repo.remote), protocol: 'file', env: { PATH: process.env.PATH } }]]) });
          fixtureRemote = remote;
          fixtureGithub = new FakeGitHub({ remote });
          const listThreads = fixtureGithub.listReviewThreads.bind(fixtureGithub);
          // Seed at read time; a released fixture must not depend on a polling timer.
          fixtureGithub.listReviewThreads = async (repositoryId, number) => {
            // Two distinct faults, so the browser can tell a configuration
            // fault from an unreachable GitHub.
            if (existsSync(join(directory, 'release-threads-offline'))) throw new DomainError('GITHUB_OPERATION_UNCERTAIN', 'GitHub request did not return confirmed success');
            if (existsSync(join(directory, 'release-threads-uncapable'))) throw new DomainError('UNSUPPORTED_CAPABILITY', 'Publication capability reviewThreads is unavailable in this configuration');
            if (existsSync(join(directory, 'release-seed-threads')) && !fixtureGithub.threads.has(number)) fixtureGithub.threads.set(number, [
              { id: `PRRT_${number}_1`, path: 'src/a.mjs', line: 1, author: 'coderabbitai', body: 'Document why module A returns two.', isBot: true },
              { id: `PRRT_${number}_2`, path: null, line: null, author: 'alex', body: 'Consider a rename later.', isBot: false },
            ]);
            return listThreads(repositoryId, number);
          };
          const readPull = fixtureGithub.readPull.bind(fixtureGithub);
          // Seed at read time, same as the threads override above. A real
          // conflict needs real Git: move the target branch on the disposable
          // remote so ReviewMerge finds a genuine, non-empty conflictPaths.
          fixtureGithub.readPull = async (repositoryId, number) => {
            if (existsSync(join(directory, 'release-conflict')) && fixtureGithub.pulls.find((pr) => pr.number === number)?.mergeable !== 'conflicting') {
              fixtureGithub.setMergeable(number, 'conflicting');
              // The remote's main may already sit ahead of the fixture's
              // original base (an earlier round can have moved it); fetch
              // and branch from its current tip so this push is a
              // fast-forward and the commit exists locally to check out.
              await fixtureGit(repo.repository, ['fetch', 'origin', 'main']);
              const currentMain = await fixtureGit(repo.repository, ['rev-parse', 'FETCH_HEAD']);
              const target = await repo.checkout(`conflict-${number}`, currentMain);
              await writeFile(join(target.worktree, 'src/a.mjs'), 'export function a() { return 99; } // moved by the target branch\n');
              await fixtureGit(target.worktree, ['add', 'src']); await fixtureGit(target.worktree, ['commit', '-m', 'Move main to conflict with the pull request branch']);
              const targetHead = await fixtureGit(target.worktree, ['rev-parse', 'HEAD']);
              await fixtureGit(target.worktree, ['push', 'origin', `${targetHead}:refs/heads/main`]);
            }
            return readPull(repositoryId, number);
          };
          return new GitHubPublication({ directory: join(directory, 'publications'), remote, github: fixtureGithub });
        },
        createReviewMerge: ({ repositories }) => new ReviewMerge({ repositories, remote: fixtureRemote }),
      },
    };
  } });
  if (browserHarness) {
    let writing = Promise.resolve();
    let recordingError;
    const record = () => {
      writing = writing.catch(error => { recordingError = error; }).then(async () => {
        const goals = demo.runtime.store.list();
        const evidence = { goals, overlaps: [...overlaps], launches: fixtureAgents?.launches ?? [], prCreates: fixtureGithub?.creates ?? [], pulls: fixtureGithub?.pulls ?? [],
          replies: fixtureGithub?.replies ?? [], resolutions: fixtureGithub?.resolutions ?? [] };
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
