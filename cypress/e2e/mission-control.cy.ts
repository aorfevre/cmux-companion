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
    cy.scrollTo('top'); cy.screenshot(`mission-control-${width}`, { capture: 'fullPage' });
  });
  it('Needs You shows only outstanding decisions', () => {
    cy.viewport(1440, 900); cy.visit('/orchestration?view=needs');
    cy.findByRole('heading', { name: 'Needs You' }).should('be.visible');
    cy.findByRole('button', { name: 'Design ingestion' }).should('be.visible');
    cy.findByRole('button', { name: 'Publish dashboard' }).should('not.exist');
    cy.findByRole('button', { name: 'Improve search' }).should('not.exist');
  });
});
