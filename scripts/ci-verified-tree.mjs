import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKFLOW = '.github/workflows/verify.yml';
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 10000 }).trim();

/** Validate independent GitHub run/job evidence against the tested Git tree.
 * Missing or ambiguous evidence always means run the ordinary full checks. */
export function eligibleProof({ repository, tree, sourceHeadSha, workflowId, run, jobs, artifact, evidence, testedCommit }) {
  if (!hash(tree) || !hash(sourceHeadSha) || !run || !evidence || !artifact || !testedCommit) return false;
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.event !== 'pull_request' || run.workflow_id !== workflowId || run.path !== WORKFLOW
    || run.head_sha !== sourceHeadSha || run.status !== 'completed' || run.conclusion !== 'success'
    || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return false;
  if (artifact.expired !== false || artifact.name !== `verified-tree-${run.id}-${run.run_attempt}`
    || artifact.workflow_run?.id !== run.id || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 65536) return false;
  for (const [jobName, stepNames] of [
    ['verify', ['Install dependencies', 'Run full verification']],
    ['macos', ['Install dependencies', 'Run macOS boundary checks']],
  ]) {
    const matching = jobs?.filter(job => job.name === jobName);
    if (matching?.length !== 1 || matching[0].conclusion !== 'success' || matching[0].status !== 'completed'
      || matching[0].run_id !== run.id || matching[0].run_attempt !== run.run_attempt) return false;
    for (const name of stepNames) {
      const steps = matching[0].steps?.filter(step => step.name === name);
      if (steps?.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') return false;
    }
  }
  return evidence.version === 2 && evidence.repository === repository && evidence.workflow === WORKFLOW
    && evidence.runId === run.id && evidence.runAttempt === run.run_attempt
    && evidence.sourceHeadSha === sourceHeadSha && evidence.tree === tree && hash(evidence.testedSha)
    && testedCommit.sha === evidence.testedSha && testedCommit.tree?.sha === tree
    && testedCommit.parents?.length === 2 && testedCommit.parents[1].sha === sourceHeadSha;
}

/** Choose the latest run, never an older success after a newer failure/re-run. */
export function latestRun(runs, sourceHeadSha, workflowId) {
  return runs.filter(run => run.head_sha === sourceHeadSha && run.workflow_id === workflowId && run.event === 'pull_request')
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

function context(env) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('Missing repository');
  return { repository: env.GITHUB_REPOSITORY, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
}
function record(env) {
  const { repository, runId, runAttempt } = context(env);
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt) || runId < 1 || runAttempt < 1) throw new Error('Only PR verification can record proof');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const sourceHeadSha = event.pull_request?.head?.sha, testedSha = git('rev-parse', 'HEAD');
  if (!hash(sourceHeadSha) || testedSha !== env.GITHUB_SHA) throw new Error('Unsupported checkout');
  const evidence = { version: 2, repository, workflow: WORKFLOW, runId, runAttempt, sourceHeadSha, testedSha, tree: git('rev-parse', 'HEAD^{tree}') };
  mkdirSync('.ci-evidence', { recursive: true });
  writeFileSync('.ci-evidence/verified-tree.json', JSON.stringify(evidence));
}

async function response(url, token, fetchImpl) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://api.github.com') throw new Error('Unsupported API origin');
  const result = await fetchImpl(parsed, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
  return result;
}
async function json(url, token, fetchImpl) {
  const result = await response(url, token, fetchImpl);
  if (!result.ok) throw new Error('GitHub evidence unavailable');
  return result.json();
}
async function downloadEvidence(url, token, fetchImpl) {
  let result = await response(url, token, fetchImpl);
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    const destination = new URL(result.headers.get('location'));
    if (destination.protocol !== 'https:') throw new Error('Unsafe artifact redirect');
    // GitHub's signed artifact URL is a different origin. Never forward the token.
    result = await fetchImpl(destination, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  }
  if (!result.ok) throw new Error('Artifact unavailable');
  const chunks = []; let length = 0;
  for await (const chunk of result.body) {
    length += chunk.length; if (length > 65536) throw new Error('Artifact too large'); chunks.push(chunk);
  }
  const directory = mkdtempSync(join(tmpdir(), 'verified-tree-'));
  try {
    const archive = join(directory, 'proof.zip'); writeFileSync(archive, Buffer.concat(chunks));
    const raw = execFileSync('unzip', ['-p', archive, 'verified-tree.json'], { encoding: 'utf8', maxBuffer: 16384, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(raw);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function reuse(env, fetchImpl) {
  const { repository } = context(env), token = env.GITHUB_TOKEN;
  if (!token || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return false;
  const head = git('rev-parse', 'HEAD');
  const parents = git('cat-file', '-p', 'HEAD').split('\n\n', 1)[0].split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.length !== 2 || head !== env.GITHUB_SHA) return false;
  const sourceHeadSha = parents[1], tree = git('rev-parse', 'HEAD^{tree}');
  const api = `https://api.github.com/repos/${repository}`;
  const workflow = await json(`${api}/actions/workflows/verify.yml`, token, fetchImpl);
  if (workflow.path !== WORKFLOW || workflow.state !== 'active' || !Number.isSafeInteger(workflow.id) || workflow.id < 1) return false;
  const found = await json(`${api}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${sourceHeadSha}&per_page=100`, token, fetchImpl);
  if (found.total_count > 100) return false;
  const selected = latestRun(found.workflow_runs ?? [], sourceHeadSha, workflow.id);
  if (!selected) return false;
  // Re-read the run to observe its current attempt/conclusion, not a stale list entry.
  const run = await json(`${api}/actions/runs/${selected.id}`, token, fetchImpl);
  if (run.status !== 'completed' || run.conclusion !== 'success') return false;
  const [jobPage, artifactPage] = await Promise.all([
    json(`${api}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, token, fetchImpl),
    json(`${api}/actions/runs/${run.id}/artifacts?per_page=100`, token, fetchImpl),
  ]);
  const artifacts = artifactPage.artifacts?.filter(item => item.name === `verified-tree-${run.id}-${run.run_attempt}`);
  if (artifacts?.length !== 1 || artifactPage.total_count > 100 || jobPage.total_count > 100) return false;
  const artifact = artifacts[0];
  if (artifact.expired || artifact.size_in_bytes > 65536) return false;
  const evidence = await downloadEvidence(`${api}/actions/artifacts/${artifact.id}/zip`, token, fetchImpl);
  if (!hash(evidence.testedSha)) return false;
  const testedCommit = await json(`${api}/git/commits/${evidence.testedSha}`, token, fetchImpl);
  const currentRun = await json(`${api}/actions/runs/${run.id}`, token, fetchImpl);
  const accepted = eligibleProof({ repository, tree, sourceHeadSha, workflowId: workflow.id, run: currentRun, jobs: jobPage.jobs, artifact, evidence, testedCommit });
  if (accepted && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Reused full verification from [PR run ${run.id}, attempt ${run.run_attempt}](https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}) for Git tree \`${tree}\`.\n`);
  return accepted;
}

export async function main(mode, env = process.env, { fetchImpl = fetch } = {}) {
  if (mode === 'record') { record(env); return; }
  if (mode !== 'reuse') throw new Error('Expected record or reuse');
  let accepted = false;
  try { accepted = await reuse(env, fetchImpl); } catch { /* Missing evidence always runs full verification. */ }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reused=${accepted}\n`);
  process.stdout.write(accepted ? 'Reusing successful verification of the exact merged Git tree.\n' : 'Full verification required.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(() => { process.stderr.write('Unable to record verification evidence.\n'); process.exitCode = 1; });
}
