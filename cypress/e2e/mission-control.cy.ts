import { goalView } from '../../server/orchestration/domain/state-view.mjs';
import { fixture } from '../../tests/helpers/orchestration/domain-fixture.mjs';

describe('Mission Control navigation', () => {
  const base = goalView(fixture().goal);
  const goals = [
    { ...base, id: 'design', title: 'Design ingestion', status: 'awaiting_approval', contracts: [] },
    { ...base, id: 'waiting', title: 'Publish dashboard', status: 'delivered', contracts: [], pr: { number: 7, url: 'https://github.com/example/project/pull/7', headSha: base.baseSha }, mergeSync: { checkedAt: 1789470000000, state: 'open', error: null } },
    { ...base, id: 'complete', title: 'Improve search', status: 'merged', contracts: [] },
  ];
  beforeEach(() => {
    cy.intercept('GET', '/api/orchestration/snapshot', { goals, cursor: 0, journalId: 'fixture', readOnly: true });
    cy.intercept('GET', '/api/orchestration/configuration', { readOnly: true, terminal: false, limits: { global: 4, perGoal: 4, planners: 2 }, capabilities: [], repositories: [] });
    cy.intercept('GET', '/api/orchestration/stream', { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: '' });
    cy.intercept('POST', '/api/settings/dev-repos/reconcile', { scans: {} });
    cy.intercept('GET', '/api/orchestration/goals/*', request => request.reply({ body: goals.find(goal => request.url.endsWith('/' + goal.id)) ?? {} }));
    cy.intercept('GET', '/api/updates*', { statusCode: 404, body: {} });
  });
  for (const width of [1440, 390]) it(`opens the fleet, inspects a waiting PR and returns at ${width}px`, () => {
    cy.viewport(width, 900); cy.visit('/orchestration');
    cy.findByRole('heading', { name: 'Mission Control' }).should('be.visible');
    cy.findByRole('link', { name: 'Sessions' }).should('be.visible');
    if (width > 1000) cy.get('.mission-sidebar .app-navigation a').then(links => {
      const first = links[0].getBoundingClientRect(), second = links[1].getBoundingClientRect();
      expect(second.top).to.be.at.least(first.bottom);
      expect(first.left).to.be.lessThan(220);
    });
    cy.findByRole('button', { name: 'Waiting for merge' }).click();
    cy.findByRole('button', { name: 'Design ingestion' }).should('not.exist');
    cy.findByRole('button', { name: 'Publish dashboard' }).click();
    cy.findByRole('link', { name: 'Open pull request #7' }).should('have.attr', 'href', 'https://github.com/example/project/pull/7');
    cy.contains('Checks run every 15 minutes').should('be.visible');
    cy.findByRole('tab', { name: 'Run report' }).click();
    cy.contains('No review or verification evidence yet').should('be.visible');
    cy.reload(); cy.findByRole('heading', { name: 'Publish dashboard' }).should('be.visible');
    cy.findByRole('button', { name: /Back to Mission Control/ }).click();
    cy.findByRole('searchbox').type('search');
    cy.findByRole('button', { name: 'Improve search' }).should('be.visible');
    cy.document().then(document => expect(document.documentElement.scrollWidth).to.be.at.most(width));
    // A desktop viewport fits the whole fleet, so the document may not scroll.
    cy.scrollTo('top', { ensureScrollable: false }); cy.screenshot(`mission-control-${width}`, { capture: 'fullPage' });
  });
  it('Needs You shows only outstanding decisions', () => {
    cy.viewport(1440, 900); cy.visit('/orchestration?view=needs');
    cy.findByRole('heading', { name: 'Needs You' }).should('be.visible');
    cy.findByRole('button', { name: 'Design ingestion' }).should('be.visible');
    cy.findByRole('button', { name: 'Publish dashboard' }).should('not.exist');
    cy.findByRole('button', { name: 'Improve search' }).should('not.exist');
  });
  it('opens the selected execution agent terminal from the phone workspace', () => {
    const f = fixture(); f.approve(); f.request('implementation', 'implementer', 'A'); f.dispatch('implementation');
    const goal = { ...goalView(f.goal), contracts: f.goal.contracts };
    cy.intercept('GET', '/api/orchestration/snapshot', { goals: [goal], cursor: 1, journalId: 'visible', readOnly: false });
    cy.intercept('GET', '/api/orchestration/configuration', { readOnly: false, terminal: true, limits: { global: 4, perGoal: 4, planners: 2 }, capabilities: [{ role: 'planner', mode: 'interactive' }, { role: 'implementer', mode: 'background' }], repositories: [] });
    cy.intercept('GET', '/api/orchestration/goals/goal', goal);
    cy.intercept('POST', '/api/orchestration/goals/goal/terminal', { opened: true }).as('openOwnedTerminal');
    cy.viewport(390, 844); cy.visit('/orchestration?goal=goal');
    cy.findByRole('tab', { name: 'Waves & sessions' }).click();
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
    cy.contains('.mission-last-activity', 'Pull request published').should('be.visible');
    cy.findByRole('button', { name: 'Publish dashboard' }).click();
    cy.findByRole('tab', { name: 'Activity' }).click();
    cy.contains('PR publication approved').should('be.visible');
    cy.findByRole('button', { name: 'Older activity' }).click(); cy.contains('Goal created').should('be.visible');
    cy.findByRole('button', { name: 'Newer activity' }).click(); cy.contains('PR publication approved').should('be.visible');
    cy.screenshot(`goal-activity-${width}`, { capture: 'fullPage' });
    cy.findByRole('tab', { name: 'Run report' }).click();
    cy.get('@checkEvidence.all').should('have.length', 0);
    cy.findByRole('button', { name: 'Inspect check output' }).click(); cy.wait('@checkEvidence');
    cy.findByLabelText('Check output').should('contain.text', '<script>unsafe()</script>').and('contain.text', 'All checks passed.');
    cy.findByLabelText('Check output').find('script').should('not.exist');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    cy.screenshot(`goal-report-${width}`, { capture: 'fullPage' });
  });

});
