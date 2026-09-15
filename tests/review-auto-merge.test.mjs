import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEligible } from '../scripts/review-auto-merge.mjs';
const fixture = () => ({
  pr: { number: 1, isDraft: false, baseRefName: 'main', headRefOid: 'head', mergeable: 'MERGEABLE',
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ author: { login: 'coderabbitai[bot]', __typename: 'Bot' }, state: 'APPROVED', commit: { oid: 'head' } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: ['macos', 'verify'].map(name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })) } } } }] } },
  protection: { required_status_checks: { strict: true, checks: [...['macos', 'verify'].map(context => ({ context, app_id: 15368 })), { context: 'CodeRabbit', app_id: -1 }] }, enforce_admins: { enabled: true }, required_conversation_resolution: { enabled: true }, required_pull_request_reviews: { dismiss_stale_reviews: true, require_last_push_approval: true, required_approving_review_count: 1 } },
  repository: { allow_auto_merge: true },
});
test('only protected, verified, reviewed non-draft heads qualify for native auto-merge', () => {
  const good = fixture(); assert.equal(mergeEligible(good.pr, good.protection, good.repository, true), true);
  for (const change of [f => { f.pr.isDraft = true; }, f => { f.protection = null; }, f => { f.repository.allow_auto_merge = false; }, f => { delete f.protection.required_pull_request_reviews.required_approving_review_count; }, f => { f.protection.required_status_checks.strict = false; }, f => { f.protection.required_status_checks.checks[0].app_id = null; }, f => { f.protection.required_pull_request_reviews.dismiss_stale_reviews = false; }, f => { f.pr.reviews.nodes = []; }, f => { f.pr.reviews.nodes[0].commit.oid = 'old'; }, f => { f.pr.reviews.nodes[0].state = 'CHANGES_REQUESTED'; }, f => { f.pr.reviewThreads.nodes.push({ isResolved: false }); }, f => { f.pr.reviews.pageInfo.hasPreviousPage = true; }, f => { f.pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = 'FAILURE'; }, f => { f.pr.mergeable = 'UNKNOWN'; }]) {
    const f = fixture(); change(f); assert.equal(mergeEligible(f.pr, f.protection, f.repository, true), false);
  }
  assert.equal(mergeEligible(good.pr, good.protection, good.repository, false), false);
});
