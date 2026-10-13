import { goalView } from '../../server/orchestration/domain/state-view.mjs';
import { fixture } from '../../tests/helpers/orchestration/domain-fixture.mjs';

describe('Goals list', () => {
  const base = goalView(fixture().goal);
  const goals = [
    { ...base, id: 'design', title: 'Design ingestion', status: 'awaiting_approval', planReviewPending: false, contracts: [], actions: [{ type: 'approve', label: 'Approve revision 1', payload: { revision: 1 } }], decision: { ...base.decision, state: 'Your plan is ready to approve.', primary: { type: 'approve', label: 'Approve revision 1', payload: { revision: 1 } }, rank: 0 as const, stage: 'Needs approval' } },
    { ...base, id: 'waiting', title: 'Publish dashboard', status: 'delivered', contracts: [], pr: { number: 7, url: 'https://github.com/example/project/pull/7', headSha: base.baseSha }, mergeSync: { checkedAt: 1789470000000, state: 'open', error: null }, decision: { ...base.decision, state: 'Pull request published. Waiting for merge.', rank: 2 as const, stage: 'Waiting for merge' } },
    { ...base, id: 'complete', title: 'Improve search', status: 'merged', contracts: [], decision: { ...base.decision, state: 'Merged on GitHub.', rank: 3 as const, stage: 'Complete' } },
  ];
  for (const width of [1440, 390]) it(`ranks decisions first, acts from a row and lands Needs you from the retired route at ${width}px`, () => {
    const retry = { type: 'retry_startup', label: 'Retry startup', payload: {} };
    const failed = { ...base, id: 'failed', title: 'Original failed goal', startup: { status: 'failed', error: 'Repository is owned by another service.' }, actions: [retry], decision: { state: 'Repository is owned by another service.', reason: null, detail: null, primary: retry, next: null, rank: 0, stage: 'Planning' } };
    const reviewing = { ...base, id: 'reviewing', title: 'Isolated test goal', status: 'awaiting_approval', planReviewPending: true, approvalBlocked: 'Independent plan review must accept this revision.', decision: { state: 'Your plan waits on a blocker.', reason: 'Independent plan review must accept this revision.', detail: null, primary: null, next: null, rank: 1, stage: 'Needs approval' } };
    cy.intercept('GET', '/api/orchestration/snapshot', { goals: [reviewing, failed], cursor: 0, journalId: 'fixture', readOnly: false });
    cy.intercept('GET', '/api/orchestration/configuration', { readOnly: false, terminal: false, limits: { global: 4, perGoal: 4, planners: 2 }, capabilities: [], repositories: [] });
    cy.intercept('POST', '/api/orchestration/commands', { statusCode: 200, body: {} }).as('command');
    cy.viewport(width, 900); cy.visit('/orchestration?view=needs');
    cy.location('search').should('not.contain', 'view=needs');
    cy.findByRole('button', { name: 'Needs you' }).should('have.attr', 'aria-pressed', 'true');
    cy.findByRole('article', { name: 'Original failed goal' }).should('be.visible').and('contain.text', 'Repository is owned by another service.');
    cy.findByRole('article', { name: 'Isolated test goal' }).should('not.exist');
    cy.findByRole('article', { name: 'Original failed goal' }).findByRole('button', { name: 'Retry startup' }).should('be.visible').click();
    cy.wait('@command').its('request.body').should('include', { goalId: 'failed', type: 'retry_startup' });
    cy.location('search').should('not.contain', 'goal=');
    cy.findByRole('button', { name: 'All' }).click();
    cy.get('article').first().should('have.attr', 'aria-label', 'Original failed goal');
    cy.findByRole('article', { name: 'Isolated test goal' }).should('contain.text', 'Needs approval').and('contain.text', 'Independent plan review must accept this revision.');
    cy.document().then(document => expect(document.documentElement.scrollWidth).to.be.at.most(width));
  });
  beforeEach(() => {
    cy.intercept('GET', '/api/orchestration/snapshot', { goals, cursor: 0, journalId: 'fixture', readOnly: true });
    cy.intercept('GET', '/api/orchestration/configuration', { readOnly: true, terminal: false, limits: { global: 4, perGoal: 4, planners: 2 }, capabilities: [], repositories: [] });
    cy.intercept('GET', '/api/orchestration/stream', { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: '' });
    cy.intercept('POST', '/api/settings/dev-repos/reconcile', { scans: {} });
    cy.intercept('GET', '/api/orchestration/goals/*', request => request.reply({ body: goals.find(goal => request.url.endsWith('/' + goal.id)) ?? {} }));
    cy.intercept('GET', '/api/updates*', { statusCode: 404, body: {} });
  });
  for (const width of [1440, 390]) it(`opens the list, inspects a waiting PR and returns at ${width}px`, () => {
    cy.viewport(width, 900); cy.visit('/orchestration');
    cy.findByRole('heading', { name: 'Goals' }).should('be.visible');
    cy.findByRole('link', { name: 'Sessions' }).should('be.visible');
    if (width > 1000) cy.get('.mission-sidebar .app-navigation a').then(links => {
      const first = links[0].getBoundingClientRect(), second = links[1].getBoundingClientRect();
      expect(second.top).to.be.at.least(first.bottom);
      expect(first.left).to.be.lessThan(220);
    });
    cy.findByRole('button', { name: 'Done' }).click();
    cy.findByRole('article', { name: 'Design ingestion' }).should('not.exist');
    cy.findByRole('button', { name: 'Open Publish dashboard' }).click();
    cy.findByRole('region', { name: 'Goal result' }).findByRole('link', { name: 'Open pull request #7' }).should('have.attr', 'href', 'https://github.com/example/project/pull/7');
    cy.contains('summary', 'Technical details').click();
    cy.contains('Checks run every 15 minutes').should('be.visible');
    cy.contains('No review or verification evidence yet').should('be.visible');
    cy.reload(); cy.findByRole('heading', { name: 'Publish dashboard' }).should('be.visible');
    cy.findByRole('button', { name: /Back to Goals/ }).click();
    cy.findByRole('searchbox').type('search');
    cy.findByRole('article', { name: 'Improve search' }).should('be.visible');
    cy.document().then(document => expect(document.documentElement.scrollWidth).to.be.at.most(width));
    // A desktop viewport fits the whole fleet, so the document may not scroll.
    cy.scrollTo('top', { ensureScrollable: false }); cy.screenshot(`goals-list-${width}`, { capture: 'fullPage' });
  });
  it('the Needs you chip shows only outstanding decisions', () => {
    cy.viewport(1440, 900); cy.visit('/orchestration');
    cy.findByRole('button', { name: 'Needs you' }).click();
    cy.findByRole('article', { name: 'Design ingestion' }).should('be.visible');
    cy.findByRole('article', { name: 'Publish dashboard' }).should('not.exist');
    cy.findByRole('article', { name: 'Improve search' }).should('not.exist');
  });
  it('opens the selected execution agent terminal from the phone workspace', () => {
    const f = fixture(); f.approve(); f.request('implementation', 'implementer', 'A'); f.dispatch('implementation');
    const goal = { ...goalView(f.goal), contracts: f.goal.contracts };
    cy.intercept('GET', '/api/orchestration/snapshot', { goals: [goal], cursor: 1, journalId: 'visible', readOnly: false });
    cy.intercept('GET', '/api/orchestration/configuration', { readOnly: false, terminal: true, limits: { global: 4, perGoal: 4, planners: 2 }, capabilities: [{ role: 'planner', mode: 'interactive' }, { role: 'implementer', mode: 'background' }], repositories: [] });
    cy.intercept('GET', '/api/orchestration/goals/goal', goal);
    cy.intercept('POST', '/api/orchestration/goals/goal/terminal', { opened: true }).as('openOwnedTerminal');
    cy.viewport(390, 844); cy.visit('/orchestration?goal=goal');
    cy.contains('summary', 'Technical details').click();
    cy.contains('summary', 'Agent session').click();
    cy.findByRole('button', { name: 'Open implementer terminal' }).should('be.visible').click();
    cy.wait('@openOwnedTerminal').its('request.body').should('deep.equal', { expectedVersion: goal.version, attemptId: 'implementation' });
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
  });

  for (const width of [390, 1440]) it(`inspects activity and exact-head check output at ${width}px`, () => {
    const headSha = 'a'.repeat(40), artifactId = 'b'.repeat(64);
    const goal = { ...goals[1], lastActivity: { kind: 'pr_observed', createdAt: '2026-09-15T12:00:00Z' }, verification: { headSha, checks: [{ id: 'unit', passed: true, artifactId }] } };
    cy.intercept('GET', '/api/orchestration/snapshot', { goals: [goal], cursor: 2, journalId: 'evidence', readOnly: true });
    cy.intercept('GET', '/api/orchestration/goals/waiting', goal);
    cy.intercept('GET', '/api/orchestration/goals/waiting/activity*', request => request.reply(request.url.includes('before=')
      ? { events: [{ id: 1, kind: 'goal_created', createdAt: '2026-09-15T10:00:00Z', revision: 0, version: 1 }], nextBefore: null, historyPruned: false }
      : { events: [{ id: 5, kind: 'publication_approved', createdAt: '2026-09-15T12:00:00Z', revision: 1, version: 5 }], nextBefore: 5, historyPruned: false }));
    cy.intercept('GET', `/api/orchestration/goals/waiting/checks/${artifactId}`, { checkId: 'unit', headSha, code: '', stdout: '<script>unsafe()</script>\nAll checks passed.', stderr: '', truncated: false }).as('checkEvidence');
    cy.viewport(width, 900); cy.visit('/orchestration');
    cy.findByRole('article', { name: 'Publish dashboard' }).should('contain.text', 'Pull request published');
    cy.findByRole('button', { name: 'Open Publish dashboard' }).click();
    cy.contains('summary', 'Technical details').click();
    cy.contains('PR publication approved').should('be.visible');
    cy.findByRole('button', { name: 'Older activity' }).click(); cy.contains('Goal created').should('be.visible');
    cy.findByRole('button', { name: 'Newer activity' }).click(); cy.contains('PR publication approved').should('be.visible');
    cy.screenshot(`goal-activity-${width}`, { capture: 'fullPage' });
    cy.get('@checkEvidence.all').should('have.length', 0);
    cy.findByRole('region', { name: 'Goal result' }).findByRole('button', { name: 'Inspect check output' }).click(); cy.wait('@checkEvidence');
    cy.findByLabelText('Check output').should('contain.text', '<script>unsafe()</script>').and('contain.text', 'All checks passed.');
    cy.findByLabelText('Check output').find('script').should('not.exist');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    cy.screenshot(`goal-report-${width}`, { capture: 'fullPage' });
  });

});
