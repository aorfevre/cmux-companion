import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveGoalCheck } from '../goal-verification.mjs';
import { createRuntime } from './create-runtime.mjs';
import { assertCutover, acquireRepositoryOwnership } from './cutover.mjs';
import { probeNativeCapabilities } from './adapters/native-capabilities.mjs';
import { probeGitCapabilities } from './adapters/git-capabilities.mjs';
import { createNativeAgents } from './adapters/native-agents.mjs';
import { GitHubCli } from './adapters/github-cli.mjs';
import { GitRemote } from './adapters/git-remote.mjs';
import { GitHubPublication } from './adapters/github.mjs';
import { ReviewMerge } from './adapters/review-merge.mjs';
import { backgroundPolicy } from './adapters/agent-runtime.mjs';
import { identifier, requireValue, object } from './domain/contracts.mjs';

/** @typedef {{schemaVersion:1; storage:{database:string;artifacts:string;resources:string}; native:{directory:string;ccsBin:string;claudeBin:string;engine:import('./adapters/ccs.mjs').Engine;env:NodeJS.ProcessEnv;cmux:{bin:string;env:NodeJS.ProcessEnv}}; repositories:{id:string;path:string;github:string;remote:{url:string;protocol:'ssh'|'https';env:NodeJS.ProcessEnv};checks:{id:string;argv:string[];bin:string;env:NodeJS.ProcessEnv;environmentId:string}[]}[]; policy:import('./types.d.ts').BackgroundPolicy; limits?:{global?:number;perGoal?:number;planners?:number};cutover:import('./cutover.mjs').Cutover;readOnly?:boolean}} ProductionConfig */
/** Loading configuration never starts the installed service or imports old goals.
 * @param {string|undefined} path @returns {ProductionConfig} */
export function loadProductionConfig(path) {
  requireValue(path && isAbsolute(path), 'Set an explicit private orchestration configuration after the cutover rehearsal', 'CUTOVER_REQUIRED');
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'Orchestration configuration must be a private regular file', 'CUTOVER_REQUIRED');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  requireValue(config.schemaVersion === 1 && config.storage && config.native && Array.isArray(config.repositories) && config.repositories.length > 0, 'Invalid production configuration', 'CUTOVER_REQUIRED');
  for (const value of [...Object.values(config.storage), config.native.directory, config.native.ccsBin, config.native.claudeBin, config.native.cmux?.bin]) requireValue(typeof value === 'string' && isAbsolute(value), 'Explicit absolute production paths are required');
  const ids = new Set();
  for (const repository of config.repositories) {
    identifier(repository.id); requireValue(!ids.has(repository.id) && isAbsolute(repository.path), 'Repository identity is invalid or duplicated'); ids.add(repository.id);
    requireValue(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository.github) && repository.remote && ['ssh', 'https'].includes(repository.remote.protocol), 'Explicit GitHub destination required');
    requireValue(Array.isArray(repository.checks), 'Verification defaults must be a list');
    for (const check of repository.checks) requireValue(typeof check.id === 'string' && Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(/** @param {unknown} arg */ arg => typeof arg === 'string') && isAbsolute(check.bin) && typeof check.environmentId === 'string' && check.environmentId.length > 0, 'Invalid configured verification command');
  }
  config.policy = backgroundPolicy(config.policy);
  return config;
}
/** Explicit production composition; metadata probes precede all worker launch.
 * The monitor callback is encapsulated so its auth/error hooks cannot replace core authority.
 * @param {{config:ProductionConfig;token:string;sessions:()=>Promise<string[]>;monitor?:(app:import('fastify').FastifyInstance)=>Promise<void>; probe?:typeof probeNativeCapabilities; probeGit?:typeof probeGitCapabilities; agents?:typeof createNativeAgents; publisher?:Parameters<typeof createRuntime>[0]['createPublisher']}} options */
export async function createProductionRuntime({ config, token, sessions, monitor, probe = probeNativeCapabilities, probeGit = probeGitCapabilities, agents = createNativeAgents, publisher }) {
  await assertCutover(config.cutover, { sessions });
  const replacement = existsSync(config.storage.database) ? realpathSync(config.storage.database) : resolve(config.storage.database);
  requireValue(!config.cutover.legacyDatabases.some(path => realpathSync(path) === replacement || resolve(path) === replacement), 'Replacement storage must be separate from legacy databases', 'CUTOVER_REQUIRED');
  await probeGit();
  const repositories = new Map(config.repositories.map(repo => [repo.id, realpathSync(repo.path)]));
  const ownership = await acquireRepositoryOwnership(repositories, config.storage.database);
  /** @type {Awaited<ReturnType<typeof createRuntime>> | undefined} */ let runtime;
  try {
    await assertCutover(config.cutover, { sessions }); ownership.assertOwned();
    const installation = await probe(config.native);
    const configured = new Map(config.repositories.map(repo => [repo.id, repo]));
    runtime = await createRuntime({ storage: config.storage, repositories, token, readOnly: config.readOnly, limits: config.limits,
      beforeCommand: async command => {
        if (command.type !== 'create_goal') return;
        object(command.payload).teamConfiguration = runtime?.store.get(command.goalId)?.teamConfiguration ?? {
          capturedAt: new Date().toISOString(), defaults: { planner: 'configured', implementer: 'configured', reviewer: 'configured', integrator: 'configured' },
          profiles: [{ id: 'configured', label: config.native.engine.provider, provider: 'claude', model: config.native.engine.model, roles: ['planner', 'implementer', 'reviewer', 'integrator'], ready: true, reason: 'Validated production adapter', capacity: { remainingPercent: null, source: 'Production configuration', checkedAt: null, reason: 'Capacity is unknown for this fixed production profile.' } }],
        };
      },
      createAgents: context => agents({ ...config.native, installation, policy: config.policy }, { ...context, describe: request => {
        requireValue(!request.attempt.assignment || (request.attempt.assignment.model === config.native.engine.model && request.attempt.assignment.label === config.native.engine.provider), 'Restore this goal’s saved production profile and model before launching another attempt', 'NOT_READY');
        const description = context.describe(request);
        const repo = configured.get(request.goalId ? runtime?.store.get(request.goalId)?.repositoryId ?? '' : '');
        return { ...description, prompt: `${description.prompt}\nOptional repository verification defaults (discover and adapt checks for this goal): ${JSON.stringify(repo?.checks.map(({ id, argv }) => ({ id, argv })) ?? [])}` };
      } }),
      prepareGoal: async goal => {
        requireValue(runtime, 'Runtime is not ready', 'NOT_READY');
        ownership.assertOwned();
        const remote = new GitRemote({ repositories: runtime.repositories, directory: join(config.storage.resources, 'goal-base', goal.id), destinations: new Map(config.repositories.map(repo => [repo.id, repo.remote])) });
        return remote.fetchBase(goal.repositoryId, goal.baseBranch);
      },
      // Production JSON configuration has no prepare command; Settings-based installs supply it.
      resolvePrepare: () => null,
      resolveCheck: (repositoryId, check, goalId) => {
        const resolved = resolveGoalCheck({ goal: runtime?.store.get(goalId), repositoryId, check,
          env: config.native.env, environmentId: 'production', policy: config.policy });
        const saved = configured.get(repositoryId)?.checks.find(entry => entry.id === check.id && JSON.stringify(entry.argv) === JSON.stringify(check.argv));
        return saved ? { ...resolved, bin: saved.bin, env: saved.env, environmentId: `${saved.environmentId}-${resolved.environmentId}` } : resolved;
      },
      createPublisher: publisher ?? (({ repositories }) => {
        const remote = new GitRemote({ repositories, directory: join(config.storage.resources, 'remote-stage'), destinations: new Map(config.repositories.map(repo => [repo.id, repo.remote])) });
        const github = new GitHubCli({ repositories: new Map(config.repositories.map(repo => [repo.id, repo.github])), cwd: config.storage.resources, env: config.native.env });
        return new GitHubPublication({ directory: join(config.storage.resources, 'publication'), remote, github });
      }),
      createReviewMerge: ({ repositories }) => new ReviewMerge({ repositories,
        remote: new GitRemote({ repositories, directory: join(config.storage.resources, 'remote-stage'), destinations: new Map(config.repositories.map(repo => [repo.id, repo.remote])) }) }),
    });
    if (monitor) await runtime.app.register(async app => monitor(app));
    const close = runtime.close.bind(runtime);
    runtime.close = async () => { await close(); ownership.close(); };
    return runtime;
  } catch (error) { if (runtime) await runtime.close(); ownership.close(); throw error; }
}
