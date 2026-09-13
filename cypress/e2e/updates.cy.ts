const updatesSuite = Cypress.expose('settings') ? describe : describe.skip;
updatesSuite('User-approved bundled updates with a real disposable service', () => {
  it('defaults off, confirms an exact commit, queues safely and supports opt-in without installing early', () => {
    cy.viewport(390, 844);
    cy.task('updatesBusy', true);
    cy.visit('/settings');
    cy.task<string>('settingsPairing', null, { log: false }).then(token => {
      cy.findByLabelText('Pairing code').type(token, { log: false });
      cy.findByRole('button', { name: 'Pair this device' }).click();
    });
    cy.findByRole('switch', { name: 'Automatic installation' }).should('not.be.checked').and('be.disabled');
    cy.findByRole('checkbox', { name: 'Allow update changes on this device' }).check();
    cy.findByRole('button', { name: 'Check for updates' }).click();
    cy.findByRole('button', { name: 'Update when idle' }).click();
    cy.findByRole('group', { name: 'Confirm update' }).should('contain.text', 'aaaaaaa');
    cy.task<{ activations: string[] }>('updatesEvidence').its('activations').should('have.length', 0);
    cy.findByRole('button', { name: 'Confirm installation' }).click();
    cy.findByRole('button', { name: 'Cancel queued update' }).should('be.visible').click();
    cy.findByRole('switch', { name: 'Automatic installation' }).check();
    cy.contains('Queued by automatic installation.', { timeout: 12000 }).should('be.visible');
    cy.reload();
    cy.findByRole('switch', { name: 'Automatic installation' }).should('be.checked');
    cy.findByRole('checkbox', { name: 'Allow update changes on this device' }).check();
    cy.findByRole('switch', { name: 'Automatic installation' }).uncheck();
    cy.contains('Queued update cancelled', { timeout: 12000 }).should('be.visible');
    cy.task<{ activations: string[] }>('updatesEvidence').its('activations').should('have.length', 0);
    cy.findByRole('button', { name: 'Update when idle' }).click();
    cy.findByRole('button', { name: 'Confirm installation' }).click();
    cy.task('updatesBusy', false);
    cy.contains('Update complete', { timeout: 12000 }).should('be.visible');
    cy.task<{ activations: string[] }>('updatesEvidence').its('activations').should('deep.equal', ['a'.repeat(40)]);
    cy.findByRole('switch', { name: 'Automatic installation' }).should('not.be.checked');
    cy.screenshot('manual-update-mobile');
    cy.reload();
    cy.contains('Update complete', { timeout: 12000 }).should('be.visible');
  });
});
