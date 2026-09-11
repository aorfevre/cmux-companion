import { mkdirSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identifier, requireValue, sha, text } from '../domain/contracts.mjs';
import { ownedArea } from '../domain/graph.mjs';
import { git, pathExists } from './git.mjs';

/** A scoped native agent tool, not shell access. Native file tools edit the owned
 * checkout; this adapter stages its delta and commits with fixed Git argv. A
 * durable proposal and atomic branch/receipt refs reconcile a lost response.
 */
export class AgentCommits {
  /** @param {{ repositories: import('./git.mjs').GitRepository; failpoint?: (point: string) => void }} options */
  constructor({ repositories, failpoint = () => {} }) {
    this.repositories = repositories; this.failpoint = failpoint;
    this.directory = join(repositories.directory, 'agent-commits');
    mkdirSync(this.directory, { mode: 0o700, recursive: true });
    requireValue(!lstatSync(this.directory).isSymbolicLink(), 'Agent commit directory is a symlink', 'OWNERSHIP_UNCERTAIN');
    /** @type {Set<string>} */ this.active = new Set();
  }
  /** @param {{ repositoryId: string; attempt: import('../types.d.ts').Attempt; ownedAreas: string[]; id: string; expectedHead: string; message: string; assertAuthorized: () => void }} input */
  async commit(input) {
    const { repositoryId, attempt, id, expectedHead, message, assertAuthorized } = input;
    identifier(id); identifier(attempt.operationId); sha(expectedHead); text(message, 1000);
    requireValue(attempt.role === 'implementer' || attempt.role === 'integrator', 'This role cannot commit', 'FORBIDDEN');
    const areas = input.ownedAreas.map(ownedArea); requireValue(areas.length > 0, 'Commit needs approved scope');
    requireValue(!this.active.has(attempt.operationId), 'Another commit owns this checkout', 'ALREADY_RUNNING');
    this.active.add(attempt.operationId);
    try {
      assertAuthorized();
      const repo = await this.repositories.repository(repositoryId), resource = this.repositories.resource(attempt.operationId);
      requireValue(resource && resource.repositoryId === repositoryId && resource.common === repo.common && resource.repository === repo.repository && resource.worktree === attempt.worktree && resource.branch === attempt.branch && resource.baseSha === attempt.baseSha, 'Commit checkout does not match its recorded attempt', 'OWNERSHIP_UNCERTAIN');
      const ownerRef = `refs/companion/resources/${attempt.operationId}`;
      requireValue(await this.repositories.ref(repo.repository, ownerRef) === attempt.baseSha, 'Commit resource ownership evidence changed', 'OWNERSHIP_UNCERTAIN');
      const currentHead = await this.repositories.checkCheckout(resource, false);
      requireValue(realpathSync(this.directory) === this.directory, 'Commit directory identity changed', 'OWNERSHIP_UNCERTAIN');
      const path = join(this.directory, `${attempt.operationId}.${id}.json`);
      const request = { schemaVersion: 1, operationId: attempt.operationId, id, expectedHead, message, repositoryId, areas, branch: resource.branch };
      const ref = `refs/companion/agent-commits/${attempt.operationId}/${id}`;
      const read = () => {
        requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Commit proposal identity changed', 'OWNERSHIP_UNCERTAIN');
        return JSON.parse(readFileSync(path, 'utf8'));
      };
      let proposal = pathExists(path) ? read() : null;
      if (proposal) requireValue(JSON.stringify(proposal.request) === JSON.stringify(request), 'Commit id was reused with different input', 'IDEMPOTENCY_CONFLICT');
      const receipt = await this.repositories.ref(repo.repository, ref);
      if (receipt) {
        requireValue(proposal?.headSha === receipt, 'Commit receipt has no matching proposal', 'OWNERSHIP_UNCERTAIN');
        await git(repo.repository, ['merge-base', '--is-ancestor', receipt, `refs/heads/${resource.branch}`]);
        assertAuthorized(); return { headSha: receipt };
      }
      requireValue(currentHead === expectedHead, 'Agent commit head changed', 'STALE_TARGET');
      await git(repo.repository, ['merge-base', '--is-ancestor', attempt.baseSha, expectedHead]);
      if (!proposal) {
        // Repository validation rejects executable clean filters/merge drivers.
        // Hook, fsmonitor and credential/global config execution are disabled by git().
        await git(resource.worktree, ['add', '--all', '--', '.']);
        const treeSha = sha((await git(resource.worktree, ['write-tree'])).trim());
        this.failpoint('tree_captured');
        // Validate immutable objects, not a shared index that can change between
        // asynchronous checks. Only this exact tree becomes the proposal commit.
        const changed = (await git(repo.repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', expectedHead, treeSha])).split('\0').filter(Boolean);
        requireValue(changed.length > 0 && changed.length <= 1000, 'Commit delta is empty or too large', 'INVALID_CANDIDATE');
        for (const path of changed) requireValue(ownedArea(path) === path && areas.some((area) => path === area || path.startsWith(`${area}/`)), 'Commit changes paths outside approved task ownership', 'SCOPE_VIOLATION');
        const raw = await git(repo.repository, ['diff', '--no-ext-diff', '--no-textconv', '--raw', expectedHead, treeSha]);
        requireValue(!/^:\d+ (120000|160000) /m.test(raw), 'Agent commits cannot introduce symlinks or submodules', 'UNSUPPORTED_HISTORY');
        const headSha = sha((await git(repo.repository, ['-c', 'user.name=Companion Agent', '-c', 'user.email=agent@companion.invalid', '-c', 'commit.gpgSign=false', 'commit-tree', treeSha, '-p', expectedHead], `${message}\n`)).trim());
        proposal = { request, headSha, treeSha };
        writeFileSync(path, JSON.stringify(proposal), { mode: 0o600, flag: 'wx' });
        this.failpoint('proposed');
      }
      sha(proposal.headSha); sha(proposal.treeSha);
      requireValue((await git(repo.repository, ['show', '-s', '--format=%P', proposal.headSha])).trim() === expectedHead && (await git(repo.repository, ['rev-parse', `${proposal.headSha}^{tree}`])).trim() === proposal.treeSha, 'Commit proposal object changed', 'OWNERSHIP_UNCERTAIN');
      assertAuthorized();
      await git(repo.repository, ['update-ref', '--stdin'], `start\nverify ${ownerRef} ${attempt.baseSha}\nupdate refs/heads/${resource.branch} ${proposal.headSha} ${expectedHead}\ncreate ${ref} ${proposal.headSha}\nprepare\ncommit\n`);
      this.failpoint('advanced');
      return { headSha: proposal.headSha };
    } finally { this.active.delete(attempt.operationId); }
  }
}
