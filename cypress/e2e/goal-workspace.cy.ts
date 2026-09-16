describe('Goal workspace navigation', () => {
  it('preserves creation drafts and opens the complete request on desktop and phone', () => {
    const base = { repositoryId: 'example', version: 1, generation: 0, title: '', revision: 0, approvedRevision: null, integrationHead: 'a'.repeat(40), baseBranch: 'main', pr: null, verification: null, publication: null, tasks: [], attempts: [], reviews: [], actions: [], approvalBlocked: null };
    const goals = (['discovering', 'awaiting_approval', 'building', 'ready_to_publish', 'merged'] as const).map((status, i) => ({ ...base, id: `board-${i}`, status, title: `Outcome ${i}`, description: `Full request ${i}\nhttps://example.com/design`, plannerName: `EXAMPLE Planning Outcome ${i}`, contracts: [] }));
    cy.intercept('GET', '**/api/orchestration/snapshot', { goals, cursor: 1, journalId: 'kanban', readOnly: false });
    cy.intercept('GET', '**/api/orchestration/configuration', { readOnly: false, terminal: false, limits: { global: 4, perGoal: 2, planners: 1 }, capabilities: [{ role: 'planner', mode: 'interactive' }], repositories: [{ id: base.repositoryId, name: 'Example', baseSha: null, baseBranch: 'main', error: null }] });
    cy.intercept('POST', '**/api/settings/dev-repos/reconcile', { scans: {} });
    cy.intercept('GET', '**/api/settings/favorites', { revision: 0, ids: [] });
    cy.intercept('GET', '**/api/orchestration/goals/board-1', goals[1]);
    cy.viewport(390, 844); cy.visit('/orchestration');
    cy.findByRole('navigation', { name: 'Main navigation' }).find('a').should('have.length', 4);
    cy.findByLabelText('What should we accomplish?').should('not.exist');
    cy.findByRole('button', { name: 'Start a goal' }).click();
    cy.findByRole('heading', { name: 'Start a goal' }).should('have.focus');
    cy.findByLabelText('What should we accomplish?').type('Keep this request');
    cy.get('#goal-create').selectFile({ contents: Cypress.Buffer.from('dropped note'), fileName: 'note.txt', mimeType: 'text/plain' }, { action: 'drag-drop' });
    cy.findByRole('button', { name: 'Remove note.txt' }).should('be.visible');
    cy.window().then(win => {
      // Build the File in the app window so the form's FileReader reads it; expose it through both files and items like real browsers do.
      const file = new win.File([Cypress.Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], 'image.png', { type: 'image/png' });
      cy.findByLabelText('What should we accomplish?').trigger('paste', { clipboardData: { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], types: ['Files'] } });
    });
    cy.findAllByRole('button', { name: 'Remove pasted-image-1.png' }).should('have.length', 1);
    cy.findAllByRole('button', { name: /^Remove / }).should('have.length', 2);
    cy.findByLabelText('What should we accomplish?').should('have.value', 'Keep this request');
    cy.findByRole('button', { name: 'Cancel' }).click();
    cy.findByRole('button', { name: 'Start a goal' }).should('have.focus').click();
    cy.findByLabelText('What should we accomplish?').should('have.value', 'Keep this request');
    cy.findByRole('button', { name: 'Cancel' }).click();
    cy.findByRole('button', { name: 'Needs you' }).click();
    cy.contains('.mission-goal-link', 'Outcome 0').should('not.exist');
    cy.contains('.mission-goal-link', 'Outcome 1').click();
    cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'https://example.com/design');
    cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'EXAMPLE Planning Outcome 1');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
    cy.findByRole('button', { name: /Back to Mission Control/ }).click();
    cy.viewport(1200, 900);
    cy.findByRole('button', { name: 'All' }).click();
    cy.contains('.mission-goal-link', 'Outcome 0').should('be.visible');
    cy.contains('.mission-goal-link', 'Outcome 4').should('be.visible');
    cy.contains('.mission-goal-link', 'Outcome 1').click();
    cy.findByRole('tab', { name: 'Run report' }).click();
    cy.findByRole('heading', { name: 'No review or verification evidence yet' }).should('be.visible');
    cy.findByRole('button', { name: /Back to Mission Control/ }).click();
  });
});
