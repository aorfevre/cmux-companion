import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { DomainError, branchName, identifier, integer, requireValue, sha } from '../domain/contracts.mjs';

/** Explicitly configured GitHub CLI boundary. Fake compositions never construct
 * this adapter or load native credentials. API payloads use stdin, not shell text.
 */
export class GitHubCli {
  /** @param {{ repositories: ReadonlyMap<string,string>; cwd: string; env: NodeJS.ProcessEnv; execute?: (argv: string[], input?: string) => Promise<string> }} options */
  constructor({ repositories, cwd, env, execute }) {
    this.repositories = repositories; this.cwd = realpathSync(cwd);
    this.env = { PATH: env.PATH, HOME: env.HOME, GH_CONFIG_DIR: env.GH_CONFIG_DIR, GH_TOKEN: env.GH_TOKEN, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    this.execute = execute ?? ((argv, input) => new Promise((resolve, reject) => {
      const child = execFile('gh', argv, { cwd: this.cwd, env: this.env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(new DomainError(child.pid === undefined ? 'EXTERNAL_NOT_SENT' : 'GITHUB_OPERATION_UNCERTAIN', 'GitHub request did not return confirmed success')) : resolve(stdout));
      child.stdin?.end(input);
    }));
  }
  /** @param {string} repositoryId */
  repository(repositoryId) {
    identifier(repositoryId); const slug = this.repositories.get(repositoryId);
    requireValue(slug && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(slug) && !slug.includes('..'), 'GitHub repository is not configured', 'UNSUPPORTED_CAPABILITY');
    return slug;
  }
  /** @param {string} repositoryId */
  identity(repositoryId) { return `github.com:${this.repository(repositoryId).toLowerCase()}`; }
  /** Read a saved PR directly; branch deletion and later head updates do not erase merge evidence.
   * @param {string} repositoryId @param {number} number
   * @returns {Promise<{ number:number; url:string; state:'open'|'closed'|'merged' }>}
   */
  async readPull(repositoryId, number) {
    const slug = this.repository(repositoryId); integer(number, 1);
    const pr = JSON.parse(await this.execute(['api', '--hostname', 'github.com', '--method', 'GET', `repos/${slug}/pulls/${number}`]));
    requireValue(pr.number === number && pr.base?.repo?.full_name?.toLowerCase() === slug.toLowerCase()
      && typeof pr.html_url === 'string' && pr.html_url.toLowerCase() === `https://github.com/${slug.toLowerCase()}/pull/${number}`
      && ['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean'
      && (!pr.merged || pr.state === 'closed'), 'GitHub PR identity or merge state changed', 'OWNERSHIP_UNCERTAIN');
    return { number, url: pr.html_url, state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed' };
  }
  /** @param {string} repositoryId @param {string} branch
   * @returns {ReturnType<import('../types.d.ts').GitHubPort['find']>}
   */
  async find(repositoryId, branch) {
    const slug = this.repository(repositoryId); branchName(branch);
    /** @type {Awaited<ReturnType<import('../types.d.ts').GitHubPort['find']>>} */ const matches = [];
    for (let page = 1; page <= 10; page++) {
      const response = JSON.parse(await this.execute(['api', '--hostname', 'github.com', '--method', 'GET', `repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${slug.split('/')[0]}:${branch}`)}&per_page=100&page=${page}`]));
      requireValue(Array.isArray(response), 'GitHub returned malformed PR data', 'OWNERSHIP_UNCERTAIN');
      for (const pr of response) {
        requireValue(pr.head?.repo?.full_name?.toLowerCase() === slug.toLowerCase() && pr.base?.repo?.full_name?.toLowerCase() === slug.toLowerCase() && pr.head.ref === branch
          && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.html_url === 'string' && pr.html_url.toLowerCase() === `https://github.com/${slug.toLowerCase()}/pull/${pr.number}`
          && ['open', 'closed'].includes(pr.state) && typeof pr.body === 'string', 'GitHub PR identity changed', 'OWNERSHIP_UNCERTAIN');
        const markers = pr.body.match(/<!-- companion-goal:[A-Za-z0-9][A-Za-z0-9_-]* -->/g) ?? [];
        matches.push({ number: pr.number, url: pr.html_url, branch: pr.head.ref, baseBranch: branchName(pr.base.ref), headSha: sha(pr.head.sha), marker: markers.length === 1 ? markers[0] : null, state: pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed' });
      }
      if (response.length < 100) return matches;
    }
    throw new DomainError('OWNERSHIP_UNCERTAIN', 'GitHub PR inventory exceeded the bounded observation limit');
  }
  /** @param {import('../types.d.ts').PublicationInput} input @param {{ beforeSend?: ()=>boolean }} [options] */
  async create(input, { beforeSend } = {}) {
    const slug = this.repository(input.repositoryId); branchName(input.branch); branchName(input.baseBranch); identifier(input.goalId); sha(input.headSha);
    requireValue(input.marker === `<!-- companion-goal:${input.goalId} -->`, 'Publication marker changed');
    const payload = { title: `Companion goal ${input.goalId}`, head: input.branch, base: input.baseBranch, body: `${input.marker}\n\nImplements the approved goal at verified commit \`${input.headSha}\`.\n\nIndependent integration review and required repository checks passed before publication.\n` };
    if (beforeSend && !beforeSend()) return;
    await this.execute(['api', '--hostname', 'github.com', '--method', 'POST', `repos/${slug}/pulls`, '--input', '-'], JSON.stringify(payload));
  }
}
