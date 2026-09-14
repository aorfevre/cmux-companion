describe('Goal Kanban navigation', () => {
  it('keeps mobile columns focused and opens the complete goal request', () => {
    const base = { repositoryId: 'example', version: 1, generation: 0, title: '', revision: 0, approvedRevision: null, integrationHead: 'a'.repeat(40), baseBranch: 'main', pr: null, verification: null, publication: null, tasks: [], attempts: [], reviews: [], actions: [], approvalBlocked: null };
    const goals = (['discovering', 'awaiting_approval', 'building', 'ready_to_publish', 'merged'] as const).map((status, i) => ({ ...base, id: `board-${i}`, status, title: `Outcome ${i}`, description: `Full request ${i}\nhttps://example.com/design`, plannerName: `EXAMPLE Planning Outcome ${i}`, contracts: [] }));
    cy.intercept('GET', '**/api/orchestration/snapshot', { goals, cursor: 1, journalId: 'kanban', readOnly: false });
    cy.intercept('GET', '**/api/orchestration/configuration', { readOnly: false, terminal: false, limits: { global: 4, perGoal: 2, planners: 1 }, capabilities: [{ role: 'planner', mode: 'interactive' }], repositories: [{ id: base.repositoryId, name: 'Example', baseSha: null, baseBranch: 'main', error: null }] });
    cy.intercept('POST', '**/api/settings/dev-repos/reconcile', { scans: {} });
    cy.intercept('GET', '**/api/settings/favorites', { revision: 0, ids: [] });
    cy.intercept('GET', '**/api/orchestration/goals/board-1', goals[1]);
    cy.viewport(390, 844); cy.visit('/orchestration');
    cy.findByRole('button', { name: 'Planning (1)' }).should('be.visible');
    cy.contains('.orch-goal-card', 'Outcome 0').should('be.visible');
    cy.contains('.orch-goal-card', 'Outcome 1').should('not.be.visible');
    cy.findByRole('button', { name: 'Needs approval (1)' }).click();
    cy.contains('.orch-goal-card', 'Outcome 1').should('contain.text', 'EXAMPLE Planning Outcome 1').click();
    cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'https://example.com/design');
    cy.findByRole('heading', { name: 'Independent reviews' }).should('not.exist');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
    cy.get('.orch-kanban').screenshot('goal-kanban-mobile');
    cy.viewport(1440, 1000); cy.contains('.orch-goal-card', 'Outcome 0').should('be.visible'); cy.contains('.orch-goal-card', 'Outcome 4').should('be.visible');
    cy.get('.orch-kanban').screenshot('goal-kanban-desktop');
  });
});
