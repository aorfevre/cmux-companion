import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exactSha } from './control.mjs';
const execute = promisify(execFile);
const SLUG = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubUpdates {
  constructor({ repository, api, workflow = 'verify.yml' }) {
    if (!SLUG.test(repository) || workflow !== 'verify.yml') throw new TypeError('Unsupported update repository or workflow');
    this.repository = repository; this.workflow = workflow;
    this.api = api ?? (async path => {
      const { stdout } = await execute('gh', ['api', '--hostname', 'github.com', path], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } });
      return JSON.parse(stdout);
    });
  }
  async eligible(sha) {
    exactSha(sha);
    const workflow = await this.api(`repos/${this.repository}/actions/workflows/${this.workflow}`);
    if (!Number.isSafeInteger(workflow.id) || workflow.path !== '.github/workflows/verify.yml' || workflow.state !== 'active') return false;
    const response = await this.api(`repos/${this.repository}/actions/workflows/${workflow.id}/runs?branch=main&event=push&head_sha=${sha}&per_page=100`);
    // Evaluate the latest run/attempt, so an earlier success cannot hide a rerun failure.
    const runs = (response.workflow_runs ?? []).filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.workflow_id === workflow.id && run.repository?.full_name?.toLowerCase() === this.repository.toLowerCase() && run.head_repository?.full_name?.toLowerCase() === this.repository.toLowerCase());
    const latest = runs.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
    return Boolean(latest && latest.status === 'completed' && latest.conclusion === 'success');
  }
  async discover(deployedSha) {
    exactSha(deployedSha);
    // Bound network work: inspect at most 100 first-parent-visible GitHub commits.
    // If no eligible commit is found in this window, leave the installation alone.
    const commits = await this.api(`repos/${this.repository}/commits?sha=main&per_page=100`);
    if (!Array.isArray(commits) || !commits.length) throw new Error('Update history unavailable');
    const observedSha = exactSha(commits[0].sha);
    for (const commit of commits.slice(0, 100)) {
      const sha = exactSha(commit.sha);
      if (sha === deployedSha) break;
      const comparison = await this.api(`repos/${this.repository}/compare/${deployedSha}...${sha}`);
      if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== deployedSha) continue;
      if (await this.eligible(sha)) return { observedSha, deployedSha, candidate: { sha, changesUrl: `https://github.com/${this.repository}/compare/${deployedSha}...${sha}` } };
    }
    return { observedSha, deployedSha, candidate: null };
  }
  async revalidate(deployedSha, sha) {
    exactSha(deployedSha); exactSha(sha);
    const [main, comparison] = await Promise.all([
      this.api(`repos/${this.repository}/compare/${sha}...main`),
      this.api(`repos/${this.repository}/compare/${deployedSha}...${sha}`),
    ]);
    if (!['ahead', 'identical'].includes(main.status) || main.merge_base_commit?.sha !== sha || comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== deployedSha || !await this.eligible(sha)) throw new Error('Update eligibility changed');
  }
}
