const defaults = { devRepos: [], projects: [], provider: 'claude', providers: { claude: { executable: 'ccs', args: ['claude'], model: 'default' }, codex: { executable: 'ccs', args: ['codex'], model: 'default' } }, tools: { cmux: 'cmux', tailscale: 'tailscale', chrome: 'chrome' }, execution: { global: 4, perGoal: 4, planners: 2, ceilingMs: 1800000, idleMs: 240000, maxOutputBytes: 1048576, killGraceMs: 5000 }, previews: { portStart: 8500, portEnd: 8599 }, onboarding: { completed: true } };
describe('Terminal provider commands', () => {
  it('keeps aliases editable and places failed save recovery beside Save on mobile', () => {
    cy.intercept('GET', '**/api/settings/local', { revision: 1, settings: defaults, imported: false });
    cy.intercept('GET', '**/api/health', { version: {} });
    cy.intercept('POST', '**/api/settings/providers/validate', { ready: true, resolution: { message: 'Resolved xclaude to ccsxp claude. Permission bypass flags are ignored.' } }).as('validate');
    cy.intercept('PATCH', '**/api/settings/local', { statusCode: 400, body: { error: 'The terminal command could not be saved. Check its definition.' } }).as('save');
    cy.viewport(390, 844); cy.visit('/settings#agents');
    cy.findByLabelText('claude connection').select('terminal');
    cy.findByLabelText('claude terminal command').type('ccs'); cy.findByLabelText('claude connection').should('have.value', 'terminal');
    cy.findByLabelText('claude terminal command').clear().type('xclaude');
    cy.findByLabelText('codex connection').select('terminal'); cy.findByLabelText('codex terminal command').type('xcodex');
    cy.findByRole('button', { name: 'Save changes' }).click(); cy.wait('@save');
    cy.get('.settings-save').findByRole('alert').should('contain.text', 'The terminal command could not be saved').and('be.visible');
    cy.findByLabelText('claude terminal command').should('have.value', 'xclaude'); cy.findByLabelText('codex terminal command').should('have.value', 'xcodex');
    cy.contains('Ready for new goals. Resolved xclaude to ccsxp claude. Permission bypass flags are ignored.').should('exist');
    cy.get('.settings-save').screenshot('terminal-command-save-failure');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
  });
});
