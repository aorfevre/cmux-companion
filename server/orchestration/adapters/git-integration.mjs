import { mkdirSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identifier, requireValue, sha } from '../domain/contracts.mjs';
import { gitScopeStopped, withGitProcessScope } from './git-process-scope.mjs';
import { git, gitBytes, pathExists } from './git.mjs';

/** Durable per-operation evidence surrounds Git's atomic goal-ref advance.
 * The scheduler owns serialization; this adapter independently enforces expected
 * refs and never resets a moved checkout or adopts an unowned existing goal ref.
 */
export class GitIntegration {
  /** @param {{ repositories: import('./git.mjs').GitRepository; failpoint?: (point: string) => void }} options */
  constructor({ repositories, failpoint = () => {} }) {
    this.repositories = repositories; this.failpoint = failpoint;
    this.directory = join(repositories.directory, 'integrations');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    requireValue(!lstatSync(this.directory).isSymbolicLink(), 'Integration directory is a symlink', 'OWNERSHIP_UNCERTAIN');
  }
  /** @param {Parameters<import('../types.d.ts').RepositoryPort['integrate']>[0]} input */
  async integrate(input) {
    identifier(input.operationId);
    return withGitProcessScope(join(this.directory, `${input.operationId}.processes`), () => this.integrateOwned(input));
  }
  /** @param {Parameters<import('../types.d.ts').RepositoryPort['integrate']>[0]} input */
  async integrateOwned(input) {
    const { goalId, repositoryId, operationId, expectedHead, baseSha, candidateSha } = input;
    identifier(goalId); identifier(repositoryId); identifier(operationId);
    sha(expectedHead); sha(baseSha); sha(candidateSha);
    const { repository, common } = await this.repositories.repository(repositoryId);
    requireValue(realpathSync(this.directory) === this.directory, 'Integration directory identity changed', 'OWNERSHIP_UNCERTAIN');
    const path = join(this.directory, `${operationId}.json`);
    const manifest = { schemaVersion: 1, goalId, repositoryId, operationId, expectedHead, baseSha, candidateSha, repository, common };
    if (pathExists(path)) {
      requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Integration manifest identity changed', 'OWNERSHIP_UNCERTAIN');
      requireValue(readFileSync(path, 'utf8') === JSON.stringify(manifest), 'Integration operation was reused', 'IDEMPOTENCY_CONFLICT');
    } else writeFileSync(path, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    const goalRef = `refs/heads/companion-goals/${goalId}`;
    const ownerRef = `refs/companion/goals/${goalId}`;
    const prefix = `refs/companion/integrations/${operationId}`;
    const ref = (/** @type {string} */ name) => this.repositories.ref(repository, name);
    const goalPath = join(this.directory, `goal.${goalId}.json`);
    let initialHead;
    if (pathExists(goalPath)) {
      requireValue(lstatSync(goalPath).isFile() && !lstatSync(goalPath).isSymbolicLink(), 'Goal manifest identity changed', 'OWNERSHIP_UNCERTAIN');
      const saved = JSON.parse(readFileSync(goalPath, 'utf8'));
      requireValue(saved.goalId === goalId && saved.repositoryId === repositoryId && saved.repository === repository && saved.common === common, 'Goal repository identity changed', 'OWNERSHIP_UNCERTAIN');
      initialHead = sha(saved.initialHead);
    } else {
      requireValue(!(await ref(goalRef)) && !(await ref(ownerRef)), 'Goal ref exists without a recorded owner', 'OWNERSHIP_UNCERTAIN');
      initialHead = expectedHead;
      writeFileSync(goalPath, JSON.stringify({ goalId, repositoryId, repository, common, initialHead }), { mode: 0o600, flag: 'wx' });
    }
    const applied = await ref(`${prefix}/applied`), proposed = await ref(`${prefix}/proposed`);
    const proposalPath = join(this.directory, `${operationId}.proposal.json`);
    let proposal = null;
    if (pathExists(proposalPath)) {
      requireValue(lstatSync(proposalPath).isFile() && !lstatSync(proposalPath).isSymbolicLink(), 'Proposal manifest changed', 'OWNERSHIP_UNCERTAIN');
      proposal = JSON.parse(readFileSync(proposalPath, 'utf8')); sha(proposal.headSha); sha(proposal.treeSha);
      requireValue((await git(repository, ['show', '-s', '--format=%P', proposal.headSha])).trim() === expectedHead
        && (await git(repository, ['rev-parse', `${proposal.headSha}^{tree}`])).trim() === proposal.treeSha, 'Proposal commit evidence changed', 'OWNERSHIP_UNCERTAIN');
    }
    requireValue(!proposed || proposal?.headSha === proposed, 'Proposal ref has no matching private evidence', 'OWNERSHIP_UNCERTAIN');

    if (applied) {
      requireValue(applied === proposed && await ref(goalRef) === applied && await ref(ownerRef) === initialHead, 'Applied integration ref changed', 'OWNERSHIP_UNCERTAIN');
      return { status: /** @type {const} */ ('integrated'), headSha: applied };
    }
    const current = await ref(goalRef), owner = await ref(ownerRef);
    if (!current && !owner) {
      await git(repository, ['update-ref', '--stdin'], `start\ncreate ${goalRef} ${expectedHead}\ncreate ${ownerRef} ${expectedHead}\nprepare\ncommit\n`);
    } else requireValue(current === expectedHead && owner === initialHead, 'Goal integration head or ownership changed', 'OWNERSHIP_UNCERTAIN');
    this.failpoint('goal_reserved');
    const existingConflict = await ref(`${prefix}/conflict`);
    if (existingConflict) { this.checkConflict(operationId, existingConflict); return this.conflict(input, existingConflict); }
    await this.repositories.provision({ repositoryId, operationId, branch: `companion/${goalId}/${operationId}`, baseSha: expectedHead });
    let headSha = proposed ?? proposal?.headSha;
    if (!headSha) {
      await git(repository, ['merge-base', '--is-ancestor', baseSha, candidateSha]);
      // An explicit merge base incorporates only this task's delta, including
      // sibling candidates based on an older integration checkpoint.
      const merged = await gitBytes(repository, ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${baseSha}`, expectedHead, candidateSha], undefined, true);
      const newline = merged.indexOf(10), treeSha = merged.subarray(0, newline).toString('ascii'); sha(treeSha);
      if (merged.subarray(newline + 1).length) {
        const artifact = this.repositories.artifacts.put(merged);
        const conflictRef = `${prefix}/conflict`;
        const reportPath = join(this.directory, `${operationId}.conflict.json`);
        const report = JSON.stringify({ treeSha, artifactId: artifact.id });
        if (pathExists(reportPath)) requireValue(lstatSync(reportPath).isFile() && !lstatSync(reportPath).isSymbolicLink() && readFileSync(reportPath, 'utf8') === report, 'Conflict report changed', 'OWNERSHIP_UNCERTAIN');
        else writeFileSync(reportPath, report, { mode: 0o600, flag: 'wx' });
        this.failpoint('conflict_reported');
        const existing = await ref(conflictRef);
        if (!existing) await git(repository, ['update-ref', conflictRef, treeSha, '0'.repeat(40)]);
        else requireValue(existing === treeSha, 'Conflict tree changed', 'OWNERSHIP_UNCERTAIN');
        this.failpoint('conflict_recorded');
        return this.conflict(input, treeSha);
      }
      headSha = (await git(repository, ['-c', 'user.name=Companion', '-c', 'user.email=companion@example.invalid', 'commit-tree', treeSha, '-p', expectedHead], `Integrate ${operationId}\n`)).trim();
      writeFileSync(proposalPath, JSON.stringify({ headSha, treeSha }), { mode: 0o600, flag: 'wx' });
      this.failpoint('proposal_recorded');
    }
    if (!proposed) await git(repository, ['update-ref', `${prefix}/proposed`, headSha, '0'.repeat(40)]);
    this.failpoint('proposed');
    // Git commits both the external side effect and its operation receipt in one
    // ref transaction; a lost database acknowledgement cannot reapply the delta.
    await git(repository, ['update-ref', '--stdin'], `start\nverify ${prefix}/proposed ${headSha}\nupdate ${goalRef} ${headSha} ${expectedHead}\ncreate ${prefix}/applied ${headSha}\nprepare\ncommit\n`);
    this.failpoint('advanced');
    return { status: /** @type {const} */ ('integrated'), headSha };
  }
  /** @param {import('../types.d.ts').RepairInput} input */
  repairIdentity(input) {
    return { goalId: input.goalId, repositoryId: input.repositoryId, integrationOperationId: input.integrationOperationId, baseSha: input.attempt.baseSha, target: input.attempt.target, role: input.attempt.role, taskId: input.attempt.taskId, generation: input.attempt.generation, revision: input.attempt.revision, effectId: input.effectId, attemptId: input.attempt.id, operationId: input.attempt.operationId, candidateSha: input.headSha, proofArtifactId: input.proofArtifactId };
  }
  /** @param {import('../types.d.ts').RepairInput} input */
  async observeRepair(input) {
    identifier(input.integrationOperationId);
    try {
      requireValue(gitScopeStopped(join(this.directory, `${input.integrationOperationId}.processes`)), 'Git command is not stopped');
      requireValue(realpathSync(this.directory) === this.directory, 'Integration directory changed');
      const path = join(this.directory, `${input.integrationOperationId}.proposal.json`);
      if (!pathExists(path)) return { status: /** @type {const} */ ('pending'), headSha: null };
      requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Repair proposal changed');
      const proposal = JSON.parse(readFileSync(path, 'utf8'));
      requireValue(JSON.stringify(proposal.repair) === JSON.stringify(this.repairIdentity(input)), 'Another repair owns the proposal');
      const proof = JSON.parse(this.repositories.artifacts.get(input.proofArtifactId).toString('utf8'));
      requireValue(proof.repositoryId === input.repositoryId && proof.operationId === input.attempt.operationId && proof.baseSha === input.attempt.baseSha && proof.headSha === input.headSha, 'Repair proof changed');
      this.repositories.artifacts.get(proof.deltaArtifactId);
      return this.observeIntegration(input.integrationOperationId);
    } catch { return { status: /** @type {const} */ ('unknown'), headSha: null }; }
  }
  /** Squash the verified repair tree onto the recorded expected integration head.
   * Private proposal identity is written before Git refs; replay cannot substitute
   * a different attempt/result or apply the same conflict repair twice.
   * @param {import('../types.d.ts').RepairInput} input
   */
  async acceptRepair(input) {
    identifier(input.integrationOperationId);
    return withGitProcessScope(join(this.directory, `${input.integrationOperationId}.processes`), () => this.acceptRepairOwned(input));
  }
  /** @param {import('../types.d.ts').RepairInput} input */
  async acceptRepairOwned(input) {
    const { goalId, repositoryId, integrationOperationId, effectId, attempt, headSha, proofArtifactId } = input;
    identifier(goalId); identifier(integrationOperationId); identifier(effectId); sha(headSha);
    const { repository, common } = await this.repositories.repository(repositoryId);
    requireValue(realpathSync(this.directory) === this.directory, 'Integration directory changed', 'OWNERSHIP_UNCERTAIN');
    const manifestPath = join(this.directory, `${integrationOperationId}.json`);
    if (attempt.taskId === null && !pathExists(manifestPath)) {
      requireValue(integrationOperationId === effectId, 'Final repair operation changed', 'STALE_TARGET');
      writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, kind: 'final_repair', goalId, repositoryId, operationId: integrationOperationId, expectedHead: attempt.baseSha, baseSha: attempt.baseSha, candidateSha: headSha, repository, common }), { mode: 0o600, flag: 'wx' });
      this.failpoint('final_repair_requested');
    }
    requireValue(pathExists(manifestPath) && lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink(), 'Integration manifest changed', 'OWNERSHIP_UNCERTAIN');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    requireValue(manifest.goalId === goalId && manifest.repositoryId === repositoryId && manifest.repository === repository && manifest.common === common && manifest.expectedHead === attempt.baseSha && attempt.target === attempt.baseSha && attempt.role === 'integrator', 'Repair target changed', 'STALE_TARGET');
    requireValue(attempt.taskId === null ? manifest.kind === 'final_repair' && integrationOperationId === effectId && manifest.candidateSha === headSha : manifest.kind !== 'final_repair', 'Repair operation kind changed', 'STALE_TARGET');
    const proof = JSON.parse(this.repositories.artifacts.get(proofArtifactId).toString('utf8'));
    requireValue(proof.repositoryId === repositoryId && proof.operationId === attempt.operationId && proof.baseSha === attempt.baseSha && proof.headSha === headSha, 'Repair proof belongs to another candidate', 'STALE_TARGET');
    this.repositories.artifacts.get(proof.deltaArtifactId);
    const prefix = `refs/companion/integrations/${integrationOperationId}`;
    if (attempt.taskId !== null) {
      const tree = await this.repositories.ref(repository, `${prefix}/conflict`);
      requireValue(tree, 'No recorded conflict tree', 'STALE_TARGET'); this.checkConflict(integrationOperationId, tree);
    }
    const proposalPath = join(this.directory, `${integrationOperationId}.proposal.json`);
    let proposal;
    if (pathExists(proposalPath)) {
      requireValue(lstatSync(proposalPath).isFile() && !lstatSync(proposalPath).isSymbolicLink(), 'Repair proposal changed', 'OWNERSHIP_UNCERTAIN');
      proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
      requireValue(JSON.stringify(proposal.repair) === JSON.stringify(this.repairIdentity(input)), 'Another repair owns the proposal', 'OWNERSHIP_UNCERTAIN');
    } else {
      const resource = this.repositories.resource(attempt.operationId);
      requireValue(resource && resource.repository === repository && resource.common === common && resource.worktree === attempt.worktree && resource.branch === attempt.branch && resource.baseSha === attempt.baseSha, 'Repair checkout changed', 'OWNERSHIP_UNCERTAIN');
      requireValue(await this.repositories.checkCheckout(resource) === headSha, 'Repair branch moved', 'STALE_TARGET');
      const treeSha = (await git(repository, ['rev-parse', `${headSha}^{tree}`])).trim();
      const integrated = (await git(repository, ['-c', 'user.name=Companion', '-c', 'user.email=companion@example.invalid', 'commit-tree', treeSha, '-p', attempt.baseSha], `Resolve integration ${integrationOperationId} with ${effectId}\n`)).trim();
      proposal = { headSha: integrated, treeSha, repair: this.repairIdentity(input) };
      writeFileSync(proposalPath, JSON.stringify(proposal), { mode: 0o600, flag: 'wx' });
      this.failpoint('repair_proposal_recorded');
    }
    requireValue((await git(repository, ['show', '-s', '--format=%P', proposal.headSha])).trim() === attempt.baseSha
      && (await git(repository, ['rev-parse', `${proposal.headSha}^{tree}`])).trim() === proposal.treeSha
      && (await git(repository, ['rev-parse', `${headSha}^{tree}`])).trim() === proposal.treeSha, 'Repair proposal commit changed', 'OWNERSHIP_UNCERTAIN');
    const proposed = await this.repositories.ref(repository, `${prefix}/proposed`);
    requireValue(!proposed || proposed === proposal.headSha, 'Repair proposal ref changed', 'OWNERSHIP_UNCERTAIN');
    const applied = await this.repositories.ref(repository, `${prefix}/applied`);
    if (applied) {
      const observed = await this.observeRepair(input);
      requireValue(observed.status === 'integrated' && observed.headSha === proposal.headSha, 'Applied repair evidence changed', 'OWNERSHIP_UNCERTAIN');
      return { status: /** @type {const} */ ('integrated'), headSha: proposal.headSha };
    }
    const goalPath = join(this.directory, `goal.${goalId}.json`);
    requireValue(lstatSync(goalPath).isFile() && !lstatSync(goalPath).isSymbolicLink(), 'Goal ownership changed', 'OWNERSHIP_UNCERTAIN');
    const goal = JSON.parse(readFileSync(goalPath, 'utf8'));
    requireValue(goal.goalId === goalId && goal.repositoryId === repositoryId && goal.repository === repository && goal.common === common
      && await this.repositories.ref(repository, `refs/companion/goals/${goalId}`) === goal.initialHead, 'Goal ownership ref changed', 'OWNERSHIP_UNCERTAIN');
    if (!proposed) await git(repository, ['update-ref', `${prefix}/proposed`, proposal.headSha, '0'.repeat(40)]);
    this.failpoint('repair_proposed');
    await git(repository, ['update-ref', '--stdin'], `start\nverify ${prefix}/proposed ${proposal.headSha}\nupdate refs/heads/companion-goals/${goalId} ${proposal.headSha} ${attempt.baseSha}\ncreate ${prefix}/applied ${proposal.headSha}\nprepare\ncommit\n`);
    this.failpoint('repair_advanced');
    return { status: /** @type {const} */ ('integrated'), headSha: proposal.headSha };
  }
  /** Read external receipts without applying new work, including after abort.
   * @param {string} operationId
   * @returns {Promise<{status: 'integrated' | 'pending' | 'unknown'; headSha: string | null}>}
   */
  async observeIntegration(operationId) {
    identifier(operationId);
    try {
      requireValue(gitScopeStopped(join(this.directory, `${operationId}.processes`)), 'Git command is not stopped');
      requireValue(realpathSync(this.directory) === this.directory, 'Integration directory changed');
      const path = join(this.directory, `${operationId}.json`);
      if (!pathExists(path)) return { status: 'pending', headSha: null };
      requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Integration manifest changed');
      const input = JSON.parse(readFileSync(path, 'utf8'));
      requireValue(input.operationId === operationId, 'Integration identity changed'); identifier(input.goalId);
      const { repository, common } = await this.repositories.repository(input.repositoryId);
      requireValue(input.repository === repository && input.common === common, 'Integration repository changed');
      const applied = await this.repositories.ref(repository, `refs/companion/integrations/${operationId}/applied`);
      if (!applied) return { status: 'pending', headSha: null };
      const proposalPath = join(this.directory, `${operationId}.proposal.json`), goalPath = join(this.directory, `goal.${input.goalId}.json`);
      for (const file of [proposalPath, goalPath]) requireValue(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Integration receipt changed');
      const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')), goal = JSON.parse(readFileSync(goalPath, 'utf8'));
      requireValue(proposal.headSha === applied && goal.goalId === input.goalId && goal.repositoryId === input.repositoryId && goal.repository === repository && goal.common === common
        && await this.repositories.ref(repository, `refs/companion/integrations/${operationId}/proposed`) === applied
        && await this.repositories.ref(repository, `refs/heads/companion-goals/${input.goalId}`) === applied
        && await this.repositories.ref(repository, `refs/companion/goals/${input.goalId}`) === goal.initialHead
        && (await git(repository, ['show', '-s', '--format=%P', applied])).trim() === input.expectedHead
        && (await git(repository, ['rev-parse', `${applied}^{tree}`])).trim() === proposal.treeSha, 'Integration receipt does not match Git');
      return { status: 'integrated', headSha: applied };
    } catch { return { status: 'unknown', headSha: null }; }
  }
  /** @param {string} operationId @param {string} treeSha */
  checkConflict(operationId, treeSha) {
    requireValue(realpathSync(this.directory) === this.directory, 'Integration directory changed', 'OWNERSHIP_UNCERTAIN');
    const path = join(this.directory, `${operationId}.conflict.json`);
    requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Conflict report changed', 'OWNERSHIP_UNCERTAIN');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    requireValue(report.treeSha === treeSha, 'Conflict ref does not match its private evidence', 'OWNERSHIP_UNCERTAIN');
    const artifact = this.repositories.artifacts.get(report.artifactId);
    requireValue(artifact.subarray(0, 41).toString('ascii') === `${treeSha}\n`, 'Conflict artifact changed', 'OWNERSHIP_UNCERTAIN');
  }
  /** Each repair attempt gets a separately owned copy of the recorded conflict.
   * @param {Parameters<import('../types.d.ts').RepositoryPort['provisionRepair']>[0]} input
   */
  async provisionRepair({ goalId, repositoryId, integrationOperationId, attempt }) {
    identifier(goalId); identifier(integrationOperationId);
    const { repository, common } = await this.repositories.repository(repositoryId);
    requireValue(realpathSync(this.directory) === this.directory, 'Integration directory identity changed', 'OWNERSHIP_UNCERTAIN');
    const path = join(this.directory, `${integrationOperationId}.json`);
    requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Integration manifest changed', 'OWNERSHIP_UNCERTAIN');
    const input = JSON.parse(readFileSync(path, 'utf8'));
    requireValue(input.goalId === goalId && input.repositoryId === repositoryId && input.repository === repository && input.common === common && input.expectedHead === attempt.baseSha && attempt.target === attempt.baseSha && attempt.role === 'integrator', 'Repair target changed', 'STALE_TARGET');
    const treeSha = await this.repositories.ref(repository, `refs/companion/integrations/${integrationOperationId}/conflict`);
    requireValue(treeSha && await this.repositories.ref(repository, `refs/heads/companion-goals/${goalId}`) === attempt.baseSha, 'Conflict evidence changed', 'STALE_TARGET');
    this.checkConflict(integrationOperationId, treeSha);
    const branch = `companion/${goalId}/${attempt.id}`;
    const existing = this.repositories.resource(attempt.operationId);
    const resource = existing ? { worktree: existing.worktree, branch: existing.branch, baseSha: existing.baseSha }
      : await this.repositories.provision({ repositoryId, operationId: attempt.operationId, branch, baseSha: attempt.baseSha });
    await this.conflict({ ...input, operationId: attempt.operationId }, treeSha, branch);
    return resource;
  }
  /** Materialize only the recorded conflict tree in the operation-owned checkout.
   * Existing user/agent edits are evidence, never overwritten during replay.
   * @param {Parameters<import('../types.d.ts').RepositoryPort['integrate']>[0]} input
   * @param {string} treeSha @param {string} [branch]
   */
  async conflict(input, treeSha, branch = `companion/${input.goalId}/${input.operationId}`) {
    const { repository, common } = await this.repositories.repository(input.repositoryId);
    const resource = this.repositories.resource(input.operationId);
    requireValue(resource && resource.repository === repository && resource.common === common && resource.repositoryId === input.repositoryId && resource.baseSha === input.expectedHead && resource.branch === branch, 'Conflict resource identity changed', 'OWNERSHIP_UNCERTAIN');
    requireValue(await this.repositories.ref(repository, `refs/companion/resources/${input.operationId}`) === input.expectedHead, 'Conflict ownership ref changed', 'OWNERSHIP_UNCERTAIN');
    requireValue(await this.repositories.checkCheckout(resource, false) === input.expectedHead, 'Conflict checkout head moved', 'OWNERSHIP_UNCERTAIN');
    requireValue(!(await git(resource.worktree, ['ls-files', '--others'])), 'Conflict checkout contains untracked or ignored files', 'OWNERSHIP_UNCERTAIN');
    const status = await git(resource.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!status) await git(resource.worktree, ['read-tree', '--reset', '-u', treeSha]);
    else {
      requireValue((await git(resource.worktree, ['write-tree'])).trim() === treeSha
        && !(await git(resource.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--name-only']))
        && !(await git(resource.worktree, ['ls-files', '--others'])), 'Conflict checkout has unrecorded edits', 'OWNERSHIP_UNCERTAIN');
    }
    this.failpoint('conflict_materialized');
    return { status: /** @type {const} */ ('conflict'), worktree: resource.worktree };
  }

}
