/** Stateful external boundary; head SHAs are read from the real disposable remote. */
export class FakeGitHub {
  constructor({ remote }) { this.remote = remote; this.pulls = []; this.creates = []; this.promotions = []; this.loseReadyResponse = false; this.loseResponse = false; this.beforeCreate = async () => {};
    this.threads = new Map(); this.replies = []; this.resolutions = []; this.loseReplyResponse = false; this.threadsUnavailable = false; }
  identity(repositoryId) { return `fake-github:${repositoryId}`; }
  async find(repositoryId, branch) {
    const headSha = await this.remote.head(repositoryId, branch);
    return this.pulls.filter((pr) => pr.repositoryId === repositoryId && pr.branch === branch).map((pr) => ({ ...pr, headSha: headSha ?? pr.headSha }));
  }
  async readPull(repositoryId, number) {
    const pr = this.pulls.find(pr => pr.repositoryId === repositoryId && pr.number === number);
    if (!pr) throw new Error('PR not found');
    return { number: pr.number, url: pr.url, state: pr.state, mergeable: pr.mergeable ?? 'mergeable' };
  }
  async listReviewThreads(repositoryId, number) {
    if (this.threadsUnavailable) throw new Error('GraphQL unavailable');
    if (!this.pulls.some(pr => pr.repositoryId === repositoryId && pr.number === number)) throw new Error('PR not found');
    return structuredClone(this.threads.get(number) ?? []).filter(thread => !thread.resolved).map(thread => { delete thread.resolved; return thread; });
  }
  async replyToThread(repositoryId, threadId, body, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return;
    this.replies.push({ repositoryId, threadId, body });
    if (this.loseReplyResponse) throw new Error('Lost reply response');
  }
  async resolveThread(repositoryId, threadId, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return;
    this.resolutions.push({ repositoryId, threadId });
    for (const list of this.threads.values()) for (const thread of list) if (thread.id === threadId) thread.resolved = true;
  }
  async ready(input, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return /** @type {const} */ ('cancelled');
    const pr = this.pulls.find(pr => pr.repositoryId === input.repositoryId && pr.branch === input.branch);
    if (!pr || pr.headSha !== input.headSha || pr.marker !== input.marker) throw new Error('Draft target changed');
    if (!pr.draft) return;
    this.promotions.push(structuredClone(input)); pr.draft = false;
    if (this.loseReadyResponse) throw new Error('Lost successful promotion response');
  }
  async create(input, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return;
    this.creates.push(structuredClone(input)); await this.beforeCreate(input);
    this.pulls.push({ repositoryId: input.repositoryId, headSha: await this.remote.head(input.repositoryId, input.branch), number: this.pulls.length + 1, url: `https://github.invalid/pr/${this.pulls.length + 1}`, branch: input.branch, baseBranch: input.baseBranch, marker: input.marker, state: 'open', draft: true });
    if (this.loseResponse) throw new Error('Lost successful PR response');
  }
}
