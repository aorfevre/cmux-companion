const settingsSuite = Cypress.expose('settings') ? describe : describe.skip;
settingsSuite('Named Dev repos and unified settings with a real disposable service', () => {
  it('pairs, discovers two directories, tracks automatically, configures a repository and preserves settings', () => {
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
      cy.get('.repository-row').should('have.length', name === 'karven' ? 1 : 2);
      cy.findByRole('button', { name: 'Add selected repositories' }).should('not.exist');
    }
    cy.get('.repository-row').first().click(); cy.findByLabelText('Repository name').clear().type('My project');
    cy.contains('summary', 'Check GitHub remote').click();
    cy.findByLabelText('GitHub destination').type('example/disposable'); cy.findByLabelText('Git remote').type('git@github.com:example/disposable.git');
    cy.findByRole('button', { name: 'Save changes' }).click(); cy.contains('Saved on this Mac.').should('be.visible');
    cy.findByRole('button', { name: 'Choose an agent' }).click(); cy.findByLabelText('Default provider').select('codex'); cy.findByRole('button', { name: 'Save changes' }).click(); cy.contains('Saved on this Mac.').should('be.visible');
    cy.findByRole('button', { name: 'Complete setup' }).click(); cy.location('pathname').should('equal', '/orchestration');
    cy.visit('/settings#agents'); cy.findByLabelText('Default provider').should('have.value', 'codex');
    cy.visit('/settings#dev-repos'); cy.get('.repository-row').should('have.length', 2); cy.findByLabelText('Search repositories').type('karven'); cy.get('.repository-row').should('have.length', 1);
    for (const width of [360, 390, 1440]) { cy.viewport(width, 900); cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width)); cy.screenshot(`settings-dev-repos-${width}`, { capture: "viewport" }); }
    cy.visit('/'); cy.findByRole('heading', { name: /^Goals$/ }).should('be.visible'); cy.findByRole('navigation', { name: 'Main navigation' }).find('a').should('have.length', 3); cy.findByRole('link', { name: 'Browse sessions' }).click(); cy.location('search').should('equal', '?view=sessions'); cy.findByRole('link', { name: '← Back to Goals' }).click(); cy.findByRole('button', { name: /^Project / }).click();
    cy.findByRole('button', { name: 'My project karven' }).should('not.exist');
    cy.findByRole('button', { name: /Show all projects/ }).click();
    cy.findByRole('button', { name: 'My project karven' }).should('be.visible');
    cy.findByRole('button', { name: 'example rekord' }).should('be.visible');
    cy.findByRole('button', { name: 'Add to favorites: My project (karven)' }).click();
    cy.contains('Saved on this Mac.').should('be.visible');
    cy.reload(); cy.findByRole('button', { name: /^Project / }).click();
    cy.findByRole('button', { name: 'My project karven' }).should('be.visible');
    cy.findByRole('button', { name: 'example rekord' }).should('not.exist');
    for (const width of [360, 390, 1440]) {
      cy.viewport(width, 900); cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
      cy.get('.project-picker').scrollIntoView();
      cy.get('.project-picker').screenshot(`project-favorites-${width}`);
    }
    cy.get('body').invoke('css', 'zoom', '2'); cy.viewport(390, 844);
    cy.document().then(doc => { const overflow = [...doc.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > 391).map(el => `${el.tagName}.${el.className}:${Math.round(el.getBoundingClientRect().right)}`).join(', '); expect(doc.documentElement.scrollWidth, overflow).to.be.at.most(390); });
    cy.get('.project-picker').screenshot('project-favorites-zoom'); cy.get('body').invoke('css', 'zoom', '1');
    cy.findByLabelText('Search projects').type('{esc}'); cy.findByRole('button', { name: /^Project / }).should('have.focus').click();
    cy.findByLabelText('Search projects').type('karven'); cy.findByRole('button', { name: 'My project karven' }).click();
    cy.findByLabelText('What should we accomplish?').type('Plan a disposable change'); cy.findByRole('button', { name: 'New goal' }).click(); cy.findByRole('navigation', { name: 'Goals' }).should('contain.text', 'Plan a disposable change');
    cy.findByRole('link', { name: 'Manage projects and providers' }).click(); cy.findByRole('button', { name: 'Dev repos' }).click(); cy.get('.repository-row').first().click(); cy.findByRole('switch', { name: 'Enabled for new work' }).uncheck(); cy.findByRole('button', { name: 'Save changes' }).click(); cy.contains('Saved on this Mac.').should('be.visible');
    cy.visit('/orchestration'); cy.findByRole('navigation', { name: 'Goals' }).should('contain.text', 'Plan a disposable change'); cy.findByRole('button', { name: /^Project / }).click();
    cy.findByRole('button', { name: 'My project karven' }).click(); cy.findByRole('button', { name: 'New goal' }).should('be.disabled');
    cy.findByRole('link', { name: 'Configure repository' }).should('be.visible');
    cy.viewport(390, 844); cy.task('settingsAddRepository'); cy.visit('/orchestration');
    cy.findByRole('button', { name: /^Project / }).click(); cy.findByRole('button', { name: /Show all projects/ }).click();
    cy.get('.project-choice').should('have.length', 3); cy.contains('excluded-worktree').should('not.exist');
    cy.findByRole('button', { name: 'new-repository karven' }).click();
    cy.findByRole('link', { name: 'Choose checks' }).should('not.exist');
    cy.findByLabelText('What should we accomplish?').type('Discover checks for this new goal');
    cy.findByRole('button', { name: 'New goal' }).should('be.enabled').click();
    cy.findByRole('navigation', { name: 'Goals' }).should('contain.text', 'Discover checks for this new goal');
    cy.screenshot('goal-without-repository-checks', { capture: 'viewport' });
  });
  it('keeps a large projected catalog bounded and readable', () => {
    cy.intercept('GET', '/api/orchestration/configuration', req => req.continue(res => {
      if (!Array.isArray(res.body.repositories)) return;
      const source = res.body.repositories[0];
      res.body.repositories = [...res.body.repositories, ...Array.from({ length: 80 }, (_, i) => ({ ...source, id: `visual-${i}`, name: i === 0 ? 'A-very-long-project-name-that-needs-to-wrap-without-hiding-its-star' : `Project ${i}`, devRepoName: i % 2 ? 'karven' : 'rekord' }))];
    }));
    cy.visit('/orchestration');
    cy.task<string>('settingsPairing', null, { log: false }).then(token => { cy.findByLabelText('Pairing code').type(token, { log: false }); cy.findByRole('button', { name: 'Pair this device' }).click(); });
    cy.findByRole('button', { name: /^Project / }).click(); cy.findByRole('button', { name: /Show all projects/ }).click();
    cy.get('.project-choice').should('have.length', 83);
    for (const width of [360, 390, 1440]) {
      cy.viewport(width, 900);
      cy.get('.project-picker-results').then(rows => { expect(rows[0].scrollHeight).to.be.greaterThan(rows[0].clientHeight); expect(rows[0].clientHeight).to.be.at.most(360); });
      cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
      cy.get('.project-picker').screenshot(`project-catalog-${width}`);
    }
  });

});
