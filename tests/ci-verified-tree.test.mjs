import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eligibleProof, latestRun, main } from '../scripts/ci-verified-tree.mjs';

function proof() {
  const repository = 'owner/repo', tree = 'a'.repeat(40), sourceHeadSha = 'b'.repeat(40), testedSha = 'c'.repeat(40);
  const value = { repository, tree, sourceHeadSha, workflowId: 7,
    run: { id: 123, run_attempt: 2, repository: { full_name: repository }, head_repository: { full_name: repository }, event: 'pull_request', workflow_id: 7, path: '.github/workflows/verify.yml', head_sha: sourceHeadSha, status: 'completed', conclusion: 'success' },
    jobs: [{ name: 'verify', run_id: 123, run_attempt: 2, status: 'completed', conclusion: 'success', steps: ['Install dependencies', 'Run full verification'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }],
    artifact: { expired: false, name: 'verified-tree-123-2', workflow_run: { id: 123 }, size_in_bytes: 1200 },
    evidence: { version: 2, repository, workflow: '.github/workflows/verify.yml', runId: 123, runAttempt: 2, sourceHeadSha, testedSha, tree },
    testedCommit: { sha: testedSha, tree: { sha: tree }, parents: [{ sha: 'd'.repeat(40) }, { sha: sourceHeadSha }] },
  };
  value.jobs.push({ ...structuredClone(value.jobs[0]), name: 'macos', steps: ['Install dependencies', 'Run macOS boundary checks'].map(name => ({ name, status: 'completed', conclusion: 'success' })) });
  return value;
}

test('only the same tested merge tree with independently successful full steps is reusable', () => {
  assert.equal(eligibleProof(proof()), true);
  const changes = [
    value => { value.tree = 'e'.repeat(40); },
    value => { value.run.event = 'push'; },
    value => { value.run.repository.full_name = 'other/repo'; },
    value => { value.run.head_repository.full_name = 'fork/repo'; },
    value => { value.run.workflow_id = 8; },
    value => { value.run.run_attempt++; },
    value => { value.run.conclusion = 'failure'; },
    value => { value.artifact = null; },
    value => { value.artifact.expired = true; },
    value => { value.evidence.tree = 'e'.repeat(40); },
    value => { value.testedCommit.tree.sha = 'e'.repeat(40); },
    value => { value.testedCommit.parents[1].sha = 'e'.repeat(40); },
    value => { value.jobs[0].steps[1].conclusion = 'skipped'; },
    value => { value.jobs[0].steps.shift(); },
  ];
  for (const change of changes) { const value = proof(); change(value); assert.equal(eligibleProof(value), false, change.toString()); }
});

test('a newer failed run or unsuccessful latest attempt cannot reuse an older success', () => {
  const value = proof();
  const newest = { ...value.run, id: 124, conclusion: 'failure' };
  const selected = latestRun([value.run, newest], value.sourceHeadSha, value.workflowId);
  assert.equal(selected.id, 124);
  assert.equal(eligibleProof({ ...value, run: selected }), false);
  assert.equal(eligibleProof({ ...value, run: { ...value.run, run_attempt: 3, status: 'in_progress', conclusion: null } }), false);
  assert.equal(latestRun([value.run], 'f'.repeat(40), 7), null);
});

test('missing CI context falls back to full verification without dependencies or credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-proof-test-')), output = join(directory, 'output');
  try {
    await main('reuse', { GITHUB_OUTPUT: output });
    assert.equal(readFileSync(output, 'utf8'), 'reused=false\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real depth-one merge checkout and ZIP proof reuse only complete independent API evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-shallow-proof-')), original = process.cwd();
  const source = join(directory, 'source'), shallow = join(directory, 'shallow'); mkdirSync(source);
  const runGit = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=CI Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    runGit(source, 'init', '--initial-branch=main');
    writeFileSync(join(source, 'base'), 'base'); runGit(source, 'add', '.'); runGit(source, 'commit', '-m', 'base');
    runGit(source, 'switch', '-c', 'feature'); writeFileSync(join(source, 'feature'), 'feature'); runGit(source, 'add', '.'); runGit(source, 'commit', '-m', 'feature');
    const sourceHeadSha = runGit(source, 'rev-parse', 'HEAD');
    runGit(source, 'switch', 'main'); runGit(source, 'merge', '--no-ff', 'feature', '-m', 'Merge PR');
    runGit(directory, 'clone', '--depth=1', `file://${source}`, shallow);
    assert.equal(runGit(shallow, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 1, 'rev-list cannot expose parents in this shallow checkout');
    process.chdir(shallow);
    const value = proof(); value.sourceHeadSha = sourceHeadSha; value.run.head_sha = sourceHeadSha;
    value.tree = runGit(shallow, 'rev-parse', 'HEAD^{tree}');
    const testedSha = runGit(shallow, 'rev-parse', 'HEAD');
    value.evidence = { ...value.evidence, sourceHeadSha, tree: value.tree, testedSha };
    value.testedCommit = { sha: testedSha, tree: { sha: value.tree }, parents: [{ sha: 'd'.repeat(40) }, { sha: sourceHeadSha }] };
    const proofFile = join(directory, 'verified-tree.json'), zipFile = join(directory, 'proof.zip');
    const eventPath = join(directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: sourceHeadSha } } }));
    const recordEnv = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: value.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: testedSha };
    await assert.rejects(main('record', { ...recordEnv, GITHUB_RUN_ID: '0' }));
    await main('record', recordEnv);
    assert.deepEqual(JSON.parse(readFileSync('.ci-evidence/verified-tree.json', 'utf8')), value.evidence);
    writeFileSync(proofFile, readFileSync('.ci-evidence/verified-tree.json'));
    execFileSync('zip', ['-j', zipFile, proofFile], { stdio: 'ignore' });
    const archive = readFileSync(zipFile), artifact = { ...value.artifact, id: 999, size_in_bytes: archive.length };
    let scenario = 'valid', downloads = 0;
    const fetchImpl = async (input, options) => {
      const url = new URL(input);
      if (url.hostname === 'artifact.example') {
        assert.equal(options.headers?.Authorization, undefined, 'bearer token never crosses the artifact redirect'); downloads++;
        return new Response(scenario === 'malformed' ? Buffer.from('not a ZIP') : archive);
      }
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      if (scenario === 'api-failure') return new Response('{}', { status: 403 });
      if (url.pathname.endsWith('/zip')) return new Response(null, { status: 302, headers: { location: 'https://artifact.example/proof.zip' } });
      let body;
      if (url.pathname.endsWith('/workflows/verify.yml')) body = { id: 7, path: '.github/workflows/verify.yml', state: scenario === 'disabled' ? 'disabled_manually' : 'active' };
      else if (url.pathname.endsWith('/workflows/7/runs')) body = { total_count: 1, workflow_runs: [value.run] };
      else if (url.pathname.endsWith('/runs/123')) body = value.run;
      else if (url.pathname.endsWith('/jobs')) body = { total_count: 1, jobs: value.jobs };
      else if (url.pathname.endsWith('/artifacts')) body = { total_count: scenario === 'duplicate' ? 2 : 1, artifacts: scenario === 'duplicate' ? [artifact, artifact] : [{ ...artifact, expired: scenario === 'expired' }] };
      else if (url.pathname.endsWith(`/git/commits/${testedSha}`)) body = value.testedCommit;
      else assert.fail(`Unexpected API path ${url.pathname}`);
      return Response.json(body);
    };
    for (scenario of ['valid', 'malformed', 'duplicate', 'expired', 'api-failure', 'disabled']) {
      const output = join(directory, `${scenario}.output`), summary = join(directory, `${scenario}.summary`);
      await main('reuse', { GITHUB_REPOSITORY: value.repository, GITHUB_TOKEN: 'fixture-token', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: testedSha, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, { fetchImpl });
      assert.equal(readFileSync(output, 'utf8'), `reused=${scenario === 'valid'}\n`, scenario);
      if (scenario === 'valid') { assert.match(readFileSync(summary, 'utf8'), /actions\/runs\/123\/attempts\/2/); assert.ok(readFileSync(summary, 'utf8').includes(value.tree)); }
    }
    assert.equal(downloads, 2, 'only valid and malformed scenarios reach archive handling');
  } finally { process.chdir(original); rmSync(directory, { recursive: true, force: true }); }
});


test('reuse requires current macOS evidence and rejects pre-coverage proofs', () => {
  for (const mutate of [
    value => { value.jobs = value.jobs.filter(job => job.name !== 'macos'); },
    value => { value.jobs[1].conclusion = 'failure'; },
    value => { value.jobs[1].steps[1].conclusion = 'skipped'; },
    value => { value.jobs[1].run_attempt++; },
    value => { value.jobs.push(structuredClone(value.jobs[1])); },
    value => { value.evidence.version = 1; },
  ]) { const value = proof(); mutate(value); assert.equal(eligibleProof(value), false); }
});
