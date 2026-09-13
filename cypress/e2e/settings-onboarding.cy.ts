const settingsSuite = Cypress.expose('settings') ? describe : describe.skip;
settingsSuite('Named Dev repos and unified settings with a real disposable service', () => {
  it('pairs, discovers two directories, selects explicitly, configures a repository and preserves settings', () => {
    cy.viewport(390, 844); cy.visit('/onboarding');
    cy.task<string>('settingsPairing', null, { log: false }).then(token => { cy.findByLabelText('Pairing code').type(token, { log: false }); cy.findByRole('button', { name: 'Pair this device' }).click(); });
    for (const name of ['karven', 'rekord']) {
      cy.findByRole('button', { name: 'Add Dev repo' }).click();
      cy.findByRole('button', { name: 'Choose folder' }).click();
      cy.findByRole('dialog', { name: 'Choose a folder' }).within(() => {
        cy.findByRole('navigation', { name: 'Folder locations' }).contains('button', 'Home').click();
        cy.findByRole('button', { name }).should('be.visible');
        if (name === 'karven') for (const width of [360, 390, 1440]) { cy.viewport(width, 900); cy.root().then(dialog => expect(dialog[0].scrollWidth).to.be.at.most(dialog[0].clientWidth)); cy.screenshot(`folder-picker-${width}`, { capture: 'viewport' }); }
        cy.viewport(390, 844); cy.findByRole('button', { name }).click();
        cy.findByRole('button', { name: 'Use this folder' }).click();
      });
      cy.findByLabelText('Dev repo name').should('have.value', name);
      cy.findByRole('button', { name: 'Save Dev repo and discover' }).click();
      cy.findByRole('button', { name: 'Select all available' }).click(); cy.findByRole('button', { name: 'Add selected repositories' }).click();
      cy.contains('Selected repositories added. Configure checks to enable goals.').should('be.visible');
    }
    cy.get('.repository-row').first().click(); cy.findByLabelText('Repository name').clear().type('My project');
    cy.findByLabelText('GitHub destination').type('example/disposable'); cy.findByLabelText('Git remote').type('git@github.com:example/disposable.git');
    cy.findByRole('checkbox', { name: /npm run test/ }).check(); cy.findByRole('button', { name: 'Save changes' }).click(); cy.contains('Saved on this Mac.').should('be.visible');
    cy.findByRole('button', { name: 'Choose an agent' }).click(); cy.findByLabelText('Default provider').select('codex'); cy.findByRole('button', { name: 'Save changes' }).click(); cy.contains('Saved on this Mac.').should('be.visible');
    cy.findByRole('button', { name: 'Complete setup' }).click(); cy.location('pathname').should('equal', '/orchestration');
    cy.visit('/settings#agents'); cy.findByLabelText('Default provider').should('have.value', 'codex');
    cy.visit('/settings#dev-repos'); cy.get('.repository-row').should('have.length', 2); cy.findByLabelText('Search repositories').type('karven'); cy.get('.repository-row').should('have.length', 1);
    for (const width of [360, 390, 1440]) { cy.viewport(width, 900); cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width)); cy.screenshot(`settings-dev-repos-${width}`, { capture: "viewport" }); }
    cy.visit('/'); cy.findByRole('heading', { name: /^Goals$/ }).should('be.visible'); cy.findByRole('navigation', { name: 'Main navigation' }).find('a').should('have.length', 3); cy.findByRole('link', { name: 'Browse sessions' }).click(); cy.location('search').should('equal', '?view=sessions'); cy.findByRole('link', { name: '← Back to Goals' }).click(); cy.findByLabelText('Repository').find('option').should('contain.text', 'karven / My project').and('contain.text', 'rekord / example');
    cy.findByLabelText('Search repositories').type('karven'); cy.findByLabelText('Repository').find('option').should('have.length', 1);
    cy.findByLabelText('What should we accomplish?').type('Plan a disposable change'); cy.findByRole('button', { name: 'New goal' }).click(); cy.findByRole('navigation', { name: 'Goals' }).should('contain.text', 'Plan a disposable change');
    cy.findByRole('link', { name: 'Manage projects and providers' }).click(); cy.findByRole('button', { name: 'Dev repos' }).click(); cy.get('.repository-row').first().click(); cy.findByRole('switch', { name: 'Enabled for new work' }).uncheck(); cy.findByRole('button', { name: 'Save changes' }).click(); cy.contains('Saved on this Mac.').should('be.visible');
    cy.visit('/orchestration'); cy.findByRole('navigation', { name: 'Goals' }).should('contain.text', 'Plan a disposable change'); cy.findByLabelText('Repository').find('option').should('not.contain.text', 'My project');
  });
});
