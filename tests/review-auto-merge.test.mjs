import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mergeEligible } from '../scripts/review-auto-merge.mjs';
const fixture = () => ({
  pr: { number: 1, author: { login: 'author', __typename: 'User' }, isDraft: false, baseRefName: 'main', headRefOid: 'head', mergeable: 'MERGEABLE',
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ author: { login: 'reviewer', __typename: 'User' }, state: 'APPROVED', commit: { oid: 'head' } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: ['macos', 'verify'].map(name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })) } } } }] } },
  protection: { required_status_checks: { strict: true, checks: ['macos', 'verify'].map(context => ({ context, app_id: 15368 })) }, enforce_admins: { enabled: true }, required_conversation_resolution: { enabled: true }, required_pull_request_reviews: { dismiss_stale_reviews: true, require_last_push_approval: true, required_approving_review_count: 1 } },
  repository: { allow_auto_merge: true },
});
test('only protected, verified, reviewed non-draft heads qualify for native auto-merge', () => {
  const good = fixture(); assert.equal(mergeEligible(good.pr, good.protection, good.repository, true), true);
  for (const change of [f => { f.pr.isDraft = true; }, f => { delete f.pr.author; }, f => { f.protection = null; }, f => { f.repository.allow_auto_merge = false; }, f => { delete f.protection.required_pull_request_reviews.required_approving_review_count; }, f => { f.protection.required_status_checks.strict = false; }, f => { f.protection.required_status_checks.checks[0].app_id = null; }, f => { f.protection.required_pull_request_reviews.dismiss_stale_reviews = false; }, f => { f.pr.reviews.nodes = []; }, f => { f.pr.reviews.nodes[0].author.__typename = 'Bot'; }, f => { f.pr.reviews.nodes[0].author.login = 'author'; }, f => { f.pr.reviews.nodes[0].commit.oid = 'old'; }, f => { f.pr.reviews.nodes[0].state = 'CHANGES_REQUESTED'; }, f => { f.pr.reviewThreads.nodes.push({ isResolved: false }); }, f => { f.pr.reviews.pageInfo.hasPreviousPage = true; }, f => { f.pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = 'FAILURE'; }, f => { f.pr.mergeable = 'UNKNOWN'; }]) {
    const f = fixture(); change(f); assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), false);
  }
  assert.equal(mergeEligible(good.pr, good.protection, good.repository, false), false);
});

test('human and bot-authored PRs need current human approval, without a provider status or review', () => {
  for (const authorType of ['User', 'Bot']) {
    const f = fixture(); f.pr.author.__typename = authorType;
    assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), true);
    f.pr.reviews.nodes[0].author = { login: 'coderabbitai', __typename: 'Bot' };
    assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), false);
  }
});

test('configured approval counts use distinct humans and their latest current-head reviews', () => {
  const f = fixture(); f.protection.required_pull_request_reviews.required_approving_review_count = 2;
  assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), false);
  f.pr.reviews.nodes.push(structuredClone(f.pr.reviews.nodes[0]));
  assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), false, 'duplicate approvals do not count twice');
  f.pr.reviews.nodes.push({ author: { login: 'second-reviewer', __typename: 'User' }, state: 'APPROVED', commit: { oid: 'head' } });
  assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), true);
  f.pr.reviews.nodes.push({ author: { login: 'reviewer', __typename: 'User' }, state: 'DISMISSED', commit: { oid: 'head' } });
  assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), false);
});

test('the installed bot is explicitly opted out and automation cannot request provider reviews', () => {
  const config = readFileSync(new URL('../.coderabbit.yaml', import.meta.url), 'utf8');
  for (const key of ['request_changes_workflow', 'high_level_summary', 'review_status', 'commit_status', 'enabled', 'auto_incremental_review', 'auto_reply']) {
    assert.match(config, new RegExp(`^ +${key}: false$`, 'm'));
  }
  const script = readFileSync(new URL('../scripts/review-auto-merge.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /coderabbit|issues\/|companion-review-request/i);
  const workflow = readFileSync(new URL('../.github/workflows/review-auto-merge.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^ {2}pull-requests: read$/m);
  assert.doesNotMatch(workflow, /Request reviews/);
});
