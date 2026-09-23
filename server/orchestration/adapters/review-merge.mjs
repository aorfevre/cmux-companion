import { identifier, requireValue, sha } from '../domain/contracts.mjs';
import { ownedArea } from '../domain/graph.mjs';
import { git, gitBytes } from './git.mjs';

/** Companion's own merge of the target branch into the pull request branch.
 * The merge is committed whether or not it conflicts: a conflicted tree carries
 * the markers for the fixer to resolve, exactly as an integration conflict does.
 * One merge per round is pinned under an owned ref, so a retry after a crash
 * never merges a target that has moved in the meantime.
 */
export class ReviewMerge {
  /** @param {{ repositories: { repository(repositoryId: string): Promise<{ repository: string; common: string }> }; remote: { fetchBase(repositoryId: string, branch: string): Promise<string> } }} options */
  constructor({ repositories, remote }) { this.repositories = repositories; this.remote = remote; }
  /** @param {string} roundId */
  ref(roundId) { return `refs/companion/review-merges/${identifier(roundId)}`; }
  /** @param {string} repository @param {string} name */
  async read(repository, name) {
    try { return (await git(repository, ['rev-parse', '--verify', '--quiet', name])).trim(); }
    catch (error) { if (/** @type {{exitCode?: unknown}} */ (error).exitCode === 1) return null; throw error; }
  }
  /** Parse `merge-tree -z` output: the tree SHA, then one NUL-terminated
   * `mode SP oid SP stage TAB path` record per conflicted stage entry. The
   * written tree holds stage-0 blobs with markers inline, so this list is the
   * only record of which paths Git could not resolve.
   * @param {Buffer} output @returns {{ treeSha: string; conflictPaths: string[] }} */
  parse(output) {
    const records = output.toString('utf8').split('\0');
    const treeSha = sha(records[0].trim());
    /** @type {string[]} */ const conflictPaths = [];
    for (const record of records.slice(1)) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const path = record.slice(tab + 1);
      if (path && !conflictPaths.includes(path)) conflictPaths.push(path);
    }
    return { treeSha, conflictPaths };
  }
  /** The port method name matches the coordinator's call, so the adapter drops
   * straight into the repository port without a wrapper.
   * @param {{ goalId: string; repositoryId: string; roundId: string; prHeadSha: string; baseBranch: string }} input
   * @returns {Promise<{ mergedBaseSha: string; mergeCommitSha: string; conflictPaths: string[] }>} */
  async prepareReviewMerge(input) {
    identifier(input.goalId); identifier(input.repositoryId); sha(input.prHeadSha);
    const { repository } = await this.repositories.repository(input.repositoryId);
    const ref = this.ref(input.roundId);
    const recorded = await this.read(repository, ref);
    if (recorded) return this.observe(repository, recorded, input);
    const mergedBaseSha = sha(await this.remote.fetchBase(input.repositoryId, input.baseBranch));
    requireValue(mergedBaseSha !== input.prHeadSha, 'The target branch head equals the pull request head', 'STALE_TARGET');
    await git(repository, ['cat-file', '-e', `${input.prHeadSha}^{commit}`]);
    // allowConflict: a conflicted merge exits 1 and still writes a valid tree.
    const { treeSha, conflictPaths } = this.parse(await gitBytes(repository,
      ['merge-tree', '--write-tree', '--no-messages', '-z', input.prHeadSha, mergedBaseSha], undefined, true));
    const message = `Merge ${input.baseBranch} into the pull request branch for review round ${input.roundId}\n`;
    const commit = sha((await git(repository, ['-c', 'user.name=Companion', '-c', 'user.email=companion@example.invalid',
      'commit-tree', treeSha, '-p', input.prHeadSha, '-p', mergedBaseSha], message)).trim());
    // The ref is the durable record. A crash after this point replays the same
    // merge; a target that moved afterwards never rewrites it. A lost race is
    // resolved by reading whichever commit the ref actually holds.
    try { await git(repository, ['update-ref', ref, commit, '0'.repeat(40)]); }
    catch { const raced = await this.read(repository, ref); requireValue(raced, 'Review merge ref could not be reserved', 'OWNERSHIP_UNCERTAIN'); return this.observe(repository, /** @type {string} */ (raced), input); }
    return { mergedBaseSha, mergeCommitSha: commit, conflictPaths };
  }
  /** Every recorded conflicted path is free of conflict markers at the given
   * commit. Ancestry and changed-path scope do not prove a resolution: a fixer
   * can touch a conflicted file and leave its markers, and that commit would
   * otherwise reach the pull request. Git holds the contents, so the proof
   * belongs here.
   * @param {{ repositoryId: string; headSha: string; conflictPaths: string[] }} input
   * @returns {Promise<string[]>} the paths that still carry markers */
  async unresolvedPaths(input) {
    sha(input.headSha);
    const { repository } = await this.repositories.repository(input.repositoryId);
    /** @type {string[]} */ const unresolved = [];
    for (const path of input.conflictPaths) {
      const target = `${input.headSha}:${ownedArea(path)}`;
      // Deleting the file is a correct resolution of a modify/delete conflict,
      // and an absent path carries no markers. Only a present blob is read.
      if (!(await this.exists(repository, target))) continue;
      const text = (await gitBytes(repository, ['show', target], undefined, true)).toString('utf8');
      // Git's own marker shapes, anchored to a line start as Git writes them.
      if (/^<{7}[ \t]|^={7}$|^>{7}[ \t]/m.test(text)) unresolved.push(path);
    }
    return unresolved;
  }
  /** A blob exists at that commit-and-path. Absence is a fact about the tree,
   * not a failure; every other Git error still propagates.
   * @param {string} repository @param {string} target */
  async exists(repository, target) {
    try { await git(repository, ['cat-file', '-e', target]); return true; }
    catch { return false; }
  }
  /** Re-derive a recorded merge from Git alone, so a replay never re-merges a
   * target that moved since.
   * @param {string} repository @param {string} recorded @param {{ prHeadSha: string }} input */
  async observe(repository, recorded, input) {
    const parents = (await git(repository, ['rev-list', '--parents', '-n', '1', recorded])).trim().split(' ').slice(1);
    requireValue(parents.length === 2 && parents[0] === input.prHeadSha, 'A review merge is recorded for another pull request head', 'IDEMPOTENCY_CONFLICT');
    // Recompute against the same two parents: identical inputs, identical tree.
    const { conflictPaths } = this.parse(await gitBytes(repository,
      ['merge-tree', '--write-tree', '--no-messages', '-z', parents[0], parents[1]], undefined, true));
    return { mergedBaseSha: sha(parents[1]), mergeCommitSha: sha(recorded), conflictPaths };
  }
}
