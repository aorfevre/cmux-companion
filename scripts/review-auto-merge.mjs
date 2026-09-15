import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Pure admission policy. Native GitHub protections remain the final authority. */
export function mergeEligible(pr, protection, repository, verified) {
  const checks = protection?.required_status_checks;
  const required = checks?.checks ?? [];
  if (!repository.allow_auto_merge || !checks?.strict || !protection.enforce_admins?.enabled
    || !protection.required_conversation_resolution?.enabled
    || !protection.required_pull_request_reviews?.dismiss_stale_reviews
    || !protection.required_pull_request_reviews?.require_last_push_approval
    || !required.some(check => check.context === 'CodeRabbit')
    || (protection.required_pull_request_reviews.required_approving_review_count ?? 0) < 1
    || !['macos', 'verify'].every(name => required.some(check => check.context === name && check.app_id === 15368))) return false;
  if (pr.isDraft || pr.baseRefName !== 'main' || pr.mergeable !== 'MERGEABLE' || !verified
    || pr.reviews.pageInfo.hasPreviousPage || pr.reviewThreads.pageInfo.hasNextPage
    || pr.reviewThreads.nodes.some(thread => !thread.isResolved)) return false;
  const latest = new Map(pr.reviews.nodes.filter(review => review.author).map(review => [review.author.login, review]));
  const rabbit = latest.get('coderabbitai[bot]');
  if (!rabbit || rabbit.author.__typename !== 'Bot' || rabbit.state !== 'APPROVED' || rabbit.commit?.oid !== pr.headRefOid
    || [...latest.values()].some(review => review.state === 'CHANGES_REQUESTED')) return false;
  const contexts = pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts;
  return Boolean(contexts && !contexts.pageInfo.hasNextPage && contexts.nodes.length
    && contexts.nodes.every(check => check.__typename === 'CheckRun'
      ? check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)
      : check.state === 'SUCCESS')
    && ['macos', 'verify'].every(name => contexts.nodes.some(check => check.name === name && check.conclusion === 'SUCCESS')));
}

const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN,baseRefName:"main"){pageInfo{hasNextPage} nodes{
  number isDraft headRefOid baseRefName mergeable author{login __typename}
  reviews(last:100){pageInfo{hasPreviousPage} nodes{author{login __typename} state commit{oid}}}
  reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}
}}}}`;

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const slug = process.env.GITHUB_REPOSITORY;
  if (!/^[\w-]+\/[\w.-]+$/.test(slug ?? '')) throw new Error('Expected a GitHub repository');
  const gh = (args, input, token = process.env.GH_TOKEN) => execFileSync('gh', args, { input, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = (route, input) => JSON.parse(gh(['api', route, ...(input ? ['--method', 'POST', '--input', '-'] : [])], input && JSON.stringify(input)));
  const [owner, name] = slug.split('/');
  const data = api('graphql', { query, variables: { owner, name } });
  if (data.errors) throw new Error('PR inventory unavailable');
  const pulls = data.data.repository.pullRequests;
  if (pulls.pageInfo.hasNextPage) throw new Error('PR inventory exceeds bound');
  const repository = api(`repos/${slug}`);
  let protection;
  try { protection = JSON.parse(gh(['api', `repos/${slug}/branches/main/protection`], undefined, process.env.AUTO_MERGE_TOKEN || process.env.GH_TOKEN)); }
  catch { console.log('Auto-merge unavailable: main branch protection cannot be verified.'); }
  for (const pr of pulls.nodes) {
    if (pr.isDraft) continue;
    // CodeRabbit normally skips bot authors. Request one review per exact head.
    if (pr.author?.__typename === 'Bot' && !pr.reviews.nodes.some(review => review.author?.login === 'coderabbitai[bot]' && review.commit?.oid === pr.headRefOid)) {
      const marker = `<!-- companion-review-request:${pr.headRefOid} -->`;
      const comments = api(`repos/${slug}/issues/${pr.number}/comments?per_page=100`);
      if (comments.length < 100 && !comments.some(comment => comment.body?.includes(marker))) {
        if (!dryRun) api(`repos/${slug}/issues/${pr.number}/comments`, { body: `@coderabbitai review\n\n${marker}` });
        console.log(`${dryRun ? 'Would request' : 'Requested'} CodeRabbit review for #${pr.number}.`);
      }
    }
    const runs = api(`repos/${slug}/actions/workflows/verify.yml/runs?event=pull_request&head_sha=${pr.headRefOid}&per_page=100`).workflow_runs;
    const latest = runs.filter(run => run.head_sha === pr.headRefOid).sort((a, b) => b.id - a.id)[0];
    if (!mergeEligible(pr, protection, repository, latest?.conclusion === 'success')) continue;
    // A dedicated token preserves the resulting main push CI event. GITHUB_TOKEN
    // merges can suppress downstream workflows, leaving the updater without proof.
    if (!process.env.AUTO_MERGE_TOKEN) { console.log(`Auto-merge #${pr.number} requires the configured auto-merge GitHub App; left open.`); continue; }
    if (dryRun) { console.log(`Would enable protected auto-merge for #${pr.number}.`); continue; }
    gh(['pr', 'merge', String(pr.number), '--repo', slug, '--auto', '--merge', '--match-head-commit', pr.headRefOid], undefined, process.env.AUTO_MERGE_TOKEN);
    console.log(`Enabled protected auto-merge for #${pr.number}.`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
