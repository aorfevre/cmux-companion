import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DomainError, identifier, requireValue, sha } from '../domain/contracts.mjs';
import { backgroundPolicy } from './agent-runtime.mjs';
import { runSupervisedProcess, observeSupervisedProcess } from './supervised-process.mjs';
import { bootIdentity } from './process-evidence.mjs';
import { pathExists } from './git.mjs';

/** @typedef {{ bin: string; argv: string[]; env: NodeJS.ProcessEnv; environmentId: string; policy: import('../types.d.ts').BackgroundPolicy }} ResolvedCheck */
/** Verification executes approved argv through an explicit repository policy.
 * A durable request precedes any process launch. An incomplete recorded run is
 * uncertain on reopen; absence of a completion receipt never authorizes rerun.
 */
export class VerificationRunner {
  /** @param {{ repositories: import('./git.mjs').GitRepository; resolveCheck: (repositoryId: string, check: import('../types.d.ts').Check, goalId: string) => ResolvedCheck; failpoint?: (point: string) => void; boot?: ()=>string|null }} options */
  constructor({ repositories, resolveCheck, failpoint = () => {}, boot = bootIdentity }) {
    this.boot = boot; this.repositories = repositories; this.resolveCheck = resolveCheck; this.failpoint = failpoint;
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
      const recordedRequest = this.read(requestPath); delete recordedRequest.bootId; delete recordedRequest.supervised;
      requireValue(JSON.stringify(recordedRequest) === JSON.stringify(request), 'Verification operation was reused', 'IDEMPOTENCY_CONFLICT');
      const receipt = this.receipt(operationId);
      requireValue(receipt, 'Verification was interrupted; reconcile its recorded worker before retrying', 'OWNERSHIP_UNCERTAIN');
      return receipt;
    }
    requireValue(!pathExists(directory), 'Verification directory exists without a request', 'OWNERSHIP_UNCERTAIN');
    mkdirSync(directory, { mode: 0o700 }); this.save(requestPath, { ...request, bootId: this.boot(), supervised: true });
    this.failpoint('requested');
    const resource = await this.repositories.provision({ operationId, repositoryId, branch: `companion/${goalId}/${operationId}`, baseSha: headSha });
    const recorded = this.repositories.resource(operationId); requireValue(recorded, 'Verification checkout was not recorded');
    const home = join(directory, 'home'), temp = join(directory, 'tmp');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(temp, { mode: 0o700 }); mkdirSync(join(directory, 'workers'), { mode: 0o700 });
    /** @type {import('../types.d.ts').Verification['checks']} */ const outcomes = [];
    /** @type {'stopped' | 'unknown'} */ let workerState = 'stopped';
    for (const check of checks) {
      let resolved, outcome = null, code = '', environment = null;
      if (workerState === 'unknown') code = 'PRIOR_WORKER_UNCERTAIN';
      else if (signal?.aborted) code = 'ABORTED';
      else {
        try {
          resolved = this.resolveCheck(repositoryId, structuredClone(check), goalId);
          requireValue(isAbsolute(resolved.bin) && resolved.environmentId.length > 0 && JSON.stringify(resolved.argv) === JSON.stringify(check.argv.slice(1)), 'Repository policy did not resolve the approved argv', 'UNSUPPORTED_CAPABILITY');
          backgroundPolicy(resolved.policy);
          requireValue(resolved.policy.maxOutputBytes <= 2 * 1024 * 1024, 'Verification output budget exceeds supervisor transport limit', 'UNSUPPORTED_CAPABILITY');
          const env = { ...resolved.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(home, 'cache'), TMPDIR: temp, CI: 'true' };
          environment = { id: resolved.environmentId, bin: resolved.bin, argv: resolved.argv, platform: process.platform, architecture: process.arch, nodeVersion: process.version, environmentHash: createHash('sha256').update(JSON.stringify(env)).digest('hex') };
          requireValue(await this.repositories.checkCheckout(recorded) === headSha, 'Verification target changed', 'STALE_TARGET');
          this.save(join(directory, `${check.id}.launch.json`), { checkId: check.id, headSha, environment });
          this.failpoint('before_launch');
          outcome = await runSupervisedProcess({ bin: resolved.bin, argv: resolved.argv, cwd: resource.worktree, env }, {
            directory: join(directory, 'workers', check.id), policy: resolved.policy, signal, boot: this.boot,
            onIdentity: () => { this.failpoint('identity_recorded'); },
          });
          workerState = outcome.workerState;
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
      this.save(join(directory, `${check.id}.result.json`), { ...outcomes.at(-1), workerState }); this.failpoint('check_recorded');
    }
    const verification = { headSha, checks: outcomes };
    const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, goalId, repositoryId, verification, workerState }));
    const result = { verification, workerState, artifactId: artifact.id };
    this.save(join(directory, 'result.json'), result); this.failpoint('completed');
    return result;
  }
  /** @param {string} operationId */
  async observe(operationId) {
    const directory = this.runDirectory(operationId), requestPath = join(directory, 'request.json');
    if (!pathExists(requestPath)) return null;
    const request = this.read(requestPath), currentBoot = this.boot();
    const priorBoot = Boolean(request.bootId && currentBoot && request.bootId !== currentBoot);
    const receipt = this.receipt(operationId);
    if (receipt) {
      if (receipt.workerState === 'stopped') return receipt;
      if (!priorBoot) {
        if (!request.supervised) return receipt;
        for (const check of request.checks) {
          if (!pathExists(join(directory, `${check.id}.launch.json`))) continue;
          const observed = await observeSupervisedProcess(join(directory, 'workers', check.id), this.boot);
          if (observed?.workerState !== 'stopped') return receipt;
        }
      }
      // Keep completed check evidence immutable; only strengthen worker proof.
      const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, goalId: request.goalId, repositoryId: request.repositoryId, verification: receipt.verification, workerState: 'stopped', recovery: priorBoot ? 'previous_boot' : 'supervisor_stopped' }));
      const result = { ...receipt, workerState: /** @type {const} */ ('stopped'), artifactId: artifact.id };
      this.save(join(directory, 'result.json'), result); return result;
    }
    /** @type {import('../types.d.ts').Verification['checks']} */ const outcomes = [];
    /** @type {'stopped'|'unknown'} */ let workerState = 'stopped';
    for (const check of /** @type {import('../types.d.ts').Check[]} */ (request.checks)) {
      const resultPath = join(directory, `${check.id}.result.json`);
      if (pathExists(resultPath)) {
        const completed = this.read(resultPath), evidence = JSON.parse(this.repositories.artifacts.get(completed.artifactId).toString('utf8'));
        const recordedState = completed.workerState ?? evidence.outcome?.workerState ?? (pathExists(join(directory, `${check.id}.launch.json`)) ? 'unknown' : 'stopped');
        if (!priorBoot && recordedState !== 'stopped') workerState = 'unknown';
        outcomes.push({ id: completed.id, passed: completed.passed, artifactId: completed.artifactId }); continue;
      }
      const launchPath = join(directory, `${check.id}.launch.json`);
      let outcome = null, environment = null, code = 'NOT_STARTED';
      if (pathExists(launchPath)) {
        const launch = this.read(launchPath);
        requireValue(launch.checkId === check.id && launch.headSha === request.headSha, 'Verification launch identity changed', 'OWNERSHIP_UNCERTAIN');
        environment = launch.environment;
        if (!request.supervised && !priorBoot) return null; // Legacy in-process runs lack durable supervisor proof.
        outcome = priorBoot && (!request.supervised || !pathExists(join(directory, 'workers', check.id)))
          ? { status: 'failed', workerState: 'stopped', cause: { code: 'OWNERSHIP_UNCERTAIN', exitCode: null, signal: null }, stdout: '', stderr: '' }
          : await observeSupervisedProcess(join(directory, 'workers', check.id), this.boot);
        if (!outcome) return null;
        if (outcome.workerState !== 'stopped') workerState = 'unknown';
        code = outcome.cause?.code ?? '';
        if (workerState !== 'stopped') code ||= 'OWNERSHIP_UNCERTAIN';
        const resource = this.repositories.resource(operationId);
        try {
          requireValue(resource && await this.repositories.checkCheckout(resource) === request.headSha, 'Verification checkout changed', 'STALE_TARGET');
        } catch (error) { if (!(error instanceof DomainError)) throw error; code = error.code; }
      }
      const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, checkId: check.id, headSha: request.headSha, argv: check.argv, environment, code, outcome }));
      outcomes.push({ id: check.id, passed: !code && outcome?.status === 'succeeded' && workerState === 'stopped', artifactId: artifact.id });
    }
    const verification = { headSha: request.headSha, checks: outcomes };
    const artifact = this.repositories.artifacts.put(JSON.stringify({ schemaVersion: 1, operationId, goalId: request.goalId, repositoryId: request.repositoryId, verification, workerState }));
    const result = { verification, workerState, artifactId: artifact.id };
    this.save(join(directory, 'result.json'), result);
    return this.receipt(operationId);
  }
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
