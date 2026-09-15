const configuration = { readOnly: false, terminal: false, limits: { global: 4, perGoal: 4, planners: 2 }, capabilities: [], repositories: [] };
for (const width of [390, 1440]) {
  it(`opens Goals and pairs directly at ${width}px`, () => {
    cy.viewport(width, 900); let paired = false;
    cy.intercept('**/api/**', { statusCode: 501, body: { error: 'Missing Goals fixture' } });
    cy.intercept('GET', '**/api/orchestration/snapshot', req => req.reply(paired ? { goals: [], cursor: 0, journalId: 'fixture', readOnly: false } : { statusCode: 401, body: { error: 'Pair this device' } }));
    cy.intercept('GET', '**/api/orchestration/configuration', req => req.reply(paired ? configuration : { statusCode: 401, body: { error: 'Pair this device' } }));
    cy.intercept('POST', '**/api/orchestration/pair', req => { paired = true; req.reply({ paired: true }); }).as('pairGoal');
    cy.intercept('GET', '**/api/orchestration/stream', { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: '' });
    cy.visit('/'); cy.findByRole('heading', { name: 'Mission Control' }).should('be.visible');
    cy.findByLabelText('Pairing code').type('  disposable-code  '); cy.findByRole('button', { name: 'Pair this device' }).click();
    cy.wait('@pairGoal').its('request.body').should('deep.equal', { token: 'disposable-code' });
    cy.findByRole('button', { name: 'Start a goal' }).click(); cy.findByRole('link', { name: 'Set up goals' }).should('be.visible');
    cy.findByRole('navigation', { name: 'Main navigation' }).within(() => { cy.findByRole('link', { name: 'Mission Control' }).should('have.attr', 'aria-current', 'page'); cy.findByRole('link', { name: 'Sessions' }).should('be.visible'); });
    cy.findByRole('link', { name: 'Sessions' }).should('have.attr', 'href', '/?view=sessions');
    cy.screenshot(`goals-empty-${width}`, { capture: 'viewport' });
  });
}
it('recovers from an unavailable Mac without routing through Sessions', () => {
  cy.intercept('**/api/**', { statusCode: 503, body: { error: 'Mac is offline' } });
  cy.visit('/'); cy.findByRole('heading', { name: 'Goals are unavailable' }).should('be.visible');
  cy.intercept('GET', '**/api/orchestration/snapshot', { goals: [], cursor: 0, journalId: 'fixture', readOnly: false });
  cy.intercept('GET', '**/api/orchestration/configuration', configuration);
  cy.findByRole('button', { name: 'Try again' }).click(); cy.findByRole('button', { name: 'Start a goal' }).click(); cy.findByRole('link', { name: 'Set up goals' }).should('be.visible'); cy.contains('Mac is offline').should('not.exist');
});
