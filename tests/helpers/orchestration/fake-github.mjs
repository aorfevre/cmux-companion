/** Stateful external boundary; head SHAs are read from the real disposable remote. */
export class FakeGitHub {
  constructor({ remote }) { this.remote = remote; this.pulls = []; this.creates = []; this.loseResponse = false; this.beforeCreate = async () => {}; }
  identity(repositoryId) { return `fake-github:${repositoryId}`; }
  async find(repositoryId, branch) {
    const headSha = await this.remote.head(repositoryId, branch);
    return this.pulls.filter((pr) => pr.repositoryId === repositoryId && pr.branch === branch).map((pr) => ({ ...pr, headSha: headSha ?? pr.headSha }));
  }
  async create(input, { beforeSend } = {}) {
    if (beforeSend && !beforeSend()) return;
    this.creates.push(structuredClone(input)); await this.beforeCreate(input);
    this.pulls.push({ repositoryId: input.repositoryId, headSha: await this.remote.head(input.repositoryId, input.branch), number: this.pulls.length + 1, url: `https://github.invalid/pr/${this.pulls.length + 1}`, branch: input.branch, baseBranch: input.baseBranch, marker: input.marker, state: 'open' });
    if (this.loseResponse) throw new Error('Lost successful PR response');
  }
}
