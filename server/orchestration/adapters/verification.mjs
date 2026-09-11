import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DomainError, identifier, requireValue, sha } from '../domain/contracts.mjs';
import { backgroundPolicy, startBackgroundProcess } from './agent-runtime.mjs';
import { pathExists } from './git.mjs';

/** @typedef {{ bin: string; argv: string[]; env: NodeJS.ProcessEnv; environmentId: string; policy: import('../types.d.ts').BackgroundPolicy }} ResolvedCheck */
/** Verification executes approved argv through an explicit repository policy.
 * A durable request precedes any process launch. An incomplete recorded run is
 * uncertain on reopen; absence of a completion receipt never authorizes rerun.
 */
export class VerificationRunner {
  /** @param {{ repositories: import('./git.mjs').GitRepository; resolveCheck: (repositoryId: string, check: import('../types.d.ts').Check) => ResolvedCheck; failpoint?: (point: string) => void }} options */
  constructor({ repositories, resolveCheck, failpoint = () => {} }) {
    this.repositories = repositories; this.resolveCheck = resolveCheck; this.failpoint = failpoint;
    this.directory = join(repositories.directory, 'verification');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    requireValue(!lstatSync(this.directory).isSymbolicLink(), 'Verification directory is a symlink', 'OWNERSHIP_UNCERTAIN');
  }
  /** @param {string} path @param {unknown} value */
  save(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temp, path);
  }
  /** @param {string} operationId */
  runDirectory(operationId) {
    identifier(operationId);
    requireValue(realpathSync(this.directory) === this.directory, 'Verification directory identity changed', 'OWNERSHIP_UNCERTAIN');
    const directory = join(this.directory, operationId);
    if (pathExists(directory)) requireValue(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Verification run path changed', 'OWNERSHIP_UNCERTAIN');
    return directory;
  }
  /** @param {string} path */
  read(path) {
    requireValue(pathExists(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Verification evidence is unavailable', 'OWNERSHIP_UNCERTAIN');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  /** @param {Parameters<import('../types.d.ts').VerificationPort['run']>[0]} input */
  async run(input) {
    const { operationId, goalId, repositoryId, headSha, checks, signal } = input;
    identifier(operationId); identifier(goalId); identifier(repositoryId); sha(headSha);
    requireValue(checks.length > 0 && checks.length <= 30 && new Set(checks.map((check) => check.id)).size === checks.length, 'Verification needs distinct required checks');
    for (const check of checks) {
      identifier(check.id);
      requireValue(check.argv.length > 0 && check.argv.length <= 100 && check.argv.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= 4000 && !arg.includes('\0')), 'Invalid verification argv');
    }
    const directory = this.runDirectory(operationId), requestPath = join(directory, 'request.json');
    const request = { schemaVersion: 1, operationId, goalId, repositoryId, headSha, checks };
    if (pathExists(requestPath)) {
      requireValue(JSON.stringify(this.read(requestPath)) === JSON.stringify(request), 'Verification operation was reused', 'IDEMPOTENCY_CONFLICT');
      const receipt = this.receipt(operationId);
      requireValue(receipt, 'Verification was interrupted; reconcile its recorded worker before retrying', 'OWNERSHIP_UNCERTAIN');
      return receipt;
    }
    requireValue(!pathExists(directory), 'Verification directory exists without a request', 'OWNERSHIP_UNCERTAIN');
    mkdirSync(directory, { mode: 0o700 }); this.save(requestPath, request);
    this.failpoint('requested');
    const resource = await this.repositories.provision({ operationId, repositoryId, branch: `companion/${goalId}/${operationId}`, baseSha: headSha });
    const recorded = this.repositories.resource(operationId); requireValue(recorded, 'Verification checkout was not recorded');
    const home = join(directory, 'home'), temp = join(directory, 'tmp');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(temp, { mode: 0o700 });
    /** @type {import('../types.d.ts').Verification['checks']} */ const outcomes = [];
    /** @type {'stopped' | 'unknown'} */ let workerState = 'stopped';
    for (const check of checks) {
      let resolved, outcome = null, code = '', environment = null;
      if (workerState === 'unknown') code = 'PRIOR_WORKER_UNCERTAIN';
      else if (signal?.aborted) code = 'ABORTED';
      else {
        try {
          resolved = this.resolveCheck(repositoryId, structuredClone(check));
          requireValue(isAbsolute(resolved.bin) && resolved.environmentId.length > 0 && JSON.stringify(resolved.argv) === JSON.stringify(check.argv.slice(1)), 'Repository policy did not resolve the approved argv', 'UNSUPPORTED_CAPABILITY');
          backgroundPolicy(resolved.policy);
          const env = { ...resolved.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(home, 'cache'), TMPDIR: temp, CI: 'true' };
          environment = { id: resolved.environmentId, bin: resolved.bin, argv: resolved.argv, platform: process.platform, architecture: process.arch, nodeVersion: process.version, environmentHash: createHash('sha256').update(JSON.stringify(env)).digest('hex') };
          requireValue(await this.repositories.checkCheckout(recorded) === headSha, 'Verification target changed', 'STALE_TARGET');
          this.save(join(directory, `${check.id}.launch.json`), { checkId: check.id, headSha, environment });
          this.failpoint('before_launch');
          const processHandle = await startBackgroundProcess({ bin: resolved.bin, argv: resolved.argv, cwd: resource.worktree, env }, {
            policy: resolved.policy, signal,
            onIdentity: (identity) => { this.save(join(directory, `${check.id}.identity.json`), { ...identity, headSha, checkId: check.id }); this.failpoint('identity_recorded'); },
          });
          outcome = await processHandle.result; workerState = outcome.workerState;
          code = outcome.cause?.code ?? '';
          if (workerState !== 'stopped') code ||= 'OWNERSHIP_UNCERTAIN';
          requireValue(await this.repositories.checkCheckout(recorded) === headSha, 'Verification changed its recorded checkout', 'STALE_TARGET');
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          code = error.code;
          // A launch without a recorded completion is not stopped proof.
          if (!outcome && pathExists(join(directory, `${check.id}.launch.json`))) workerState = 'unknown';
        }
      }
      const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, checkId: check.id, headSha, argv: check.argv, environment, code, outcome }));
      outcomes.push({ id: check.id, passed: !code && outcome?.status === 'succeeded' && workerState === 'stopped', artifactId: artifact.id });
      this.save(join(directory, `${check.id}.result.json`), outcomes.at(-1)); this.failpoint('check_recorded');
    }
    const verification = { headSha, checks: outcomes };
    const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, goalId, repositoryId, verification, workerState }));
    const result = { verification, workerState, artifactId: artifact.id };
    this.save(join(directory, 'result.json'), result); this.failpoint('completed');
    return result;
  }
  /** @param {string} operationId */
  async observe(operationId) { return this.receipt(operationId); }
  /** @param {string} operationId @returns {import('../types.d.ts').VerificationRunResult | null} */
  receipt(operationId) {
    const directory = this.runDirectory(operationId), path = join(directory, 'result.json');
    if (!pathExists(path)) return null;
    const request = /** @type {Parameters<import('../types.d.ts').VerificationPort['run']>[0]} */ (this.read(join(directory, 'request.json')));
    const result = /** @type {import('../types.d.ts').VerificationRunResult} */ (this.read(path)), artifact = JSON.parse(this.repositories.artifacts.get(result.artifactId).toString('utf8'));
    requireValue(request.operationId === operationId && artifact.goalId === request.goalId && artifact.repositoryId === request.repositoryId && artifact.verification.headSha === request.headSha && artifact.verification.checks.length === request.checks.length && request.checks.every((check) => artifact.verification.checks.some((/** @type {import('../types.d.ts').Check} */ entry) => entry.id === check.id)), 'Verification request and receipt disagree', 'OWNERSHIP_UNCERTAIN');
    requireValue(artifact.operationId === operationId && JSON.stringify(artifact.verification) === JSON.stringify(result.verification) && artifact.workerState === result.workerState, 'Verification receipt changed', 'OWNERSHIP_UNCERTAIN');
    for (const check of result.verification.checks) {
      const evidence = JSON.parse(this.repositories.artifacts.get(check.artifactId).toString('utf8'));
      requireValue(evidence.operationId === operationId && evidence.checkId === check.id && evidence.headSha === request.headSha && JSON.stringify(evidence.argv) === JSON.stringify(request.checks.find((entry) => entry.id === check.id)?.argv), 'Verification check evidence changed', 'OWNERSHIP_UNCERTAIN');
    }
    return result;
  }
}
