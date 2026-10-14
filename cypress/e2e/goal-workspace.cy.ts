describe('Goal workspace navigation', () => {
  it('preserves creation drafts and opens the complete request on desktop and phone', () => {
    const base = { repositoryId: 'example', version: 1, generation: 0, title: '', revision: 0, approvedRevision: null, integrationHead: 'a'.repeat(40), baseBranch: 'main', pr: null, verification: null, publication: null, tasks: [], attempts: [], reviews: [], reviewRound: null, reviewRounds: [], verificationRuns: [], actions: [], approvalBlocked: null, decision: { state: 'Your plan is ready to approve.', reason: null, detail: null, primary: null, next: null, rank: 1, stage: 'Needs approval' } };
    const approve = { type: 'approve', label: 'Approve plan & start work', payload: { revision: 1 } }, abort = { type: 'abort', label: 'Abort goal', payload: {} };
    const goals = (['discovering', 'awaiting_approval', 'building', 'ready_to_publish', 'merged'] as const).map((status, i) => ({ ...base, planReviewPending: false, id: `board-${i}`, status, title: `Outcome ${i}`, decision: { ...base.decision, rank: (status === 'awaiting_approval' ? 0 : status === 'merged' ? 3 : 1) as 0 | 1 | 3, stage: status === 'awaiting_approval' ? 'Needs approval' : status === 'merged' ? 'Complete' : 'In progress' }, description: `Full request ${i}\nhttps://example.com/design`, plannerName: `EXAMPLE Planning Outcome ${i}`, contracts: [] }));
    cy.intercept('GET', '**/api/orchestration/snapshot', { goals, cursor: 1, journalId: 'kanban', readOnly: false });
    cy.intercept('GET', '**/api/orchestration/configuration', { readOnly: false, terminal: false, limits: { global: 4, perGoal: 2, planners: 1 }, capabilities: [{ role: 'planner', mode: 'interactive' }], repositories: [{ id: base.repositoryId, name: 'Example', baseSha: null, baseBranch: 'main', error: null }] });
    cy.intercept('POST', '**/api/settings/dev-repos/reconcile', { scans: {} });
    cy.intercept('GET', '**/api/settings/favorites', { revision: 0, ids: [] });
    cy.intercept('GET', '**/api/orchestration/goals/board-1', { ...goals[1], actions: [approve, abort], decision: { ...goals[1].decision, primary: approve } });
    cy.viewport(390, 844); cy.visit('/orchestration');
    cy.findByRole('navigation', { name: 'Main navigation' }).find('a').should('have.length', 4);
    cy.findByLabelText('What should we accomplish?').should('not.exist');
    cy.findByRole('button', { name: 'Start a goal' }).click();
    cy.findByRole('heading', { name: 'Start a goal' }).should('have.focus');
    cy.findByLabelText('What should we accomplish?').type('Keep this request');
    cy.findByRole('button', { name: 'Cancel' }).click();
    cy.findByRole('button', { name: 'Start a goal' }).should('have.focus').click();
    cy.findByLabelText('What should we accomplish?').should('have.value', 'Keep this request');
    cy.findByRole('button', { name: 'Cancel' }).click();
    cy.findByRole('button', { name: 'Needs you' }).click();
    cy.findByRole('article', { name: 'Outcome 0' }).should('not.exist');
    cy.findByRole('button', { name: 'Open Outcome 1' }).click();
    cy.findByRole('region', { name: 'Your request' }).should('contain.text', 'https://example.com/design');
    cy.findByLabelText('Technical details').should('contain.text', 'EXAMPLE Planning Outcome 1');
    cy.findByRole('region', { name: 'Goal decision' }).within(() => {
      cy.findByRole('status').should('be.visible').and('have.text', 'Your plan is ready to approve.');
      cy.findByRole('button', { name: 'Approve plan & start work' }).should('be.visible').and('be.enabled');
      cy.findByRole('button', { name: 'More' }).should('be.visible').click();
      cy.findByLabelText('More actions').findByRole('button', { name: 'Abort goal' }).should('be.visible');
      cy.findByRole('button', { name: 'More' }).click();
      cy.findByLabelText('More actions').should('not.exist');
    });
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(390));
    cy.findByRole('button', { name: /Back to Goals/ }).click();
    cy.viewport(1200, 900);
    cy.findByRole('button', { name: 'All' }).click();
    cy.findByRole('article', { name: 'Outcome 0' }).should('be.visible');
    cy.findByRole('article', { name: 'Outcome 4' }).should('be.visible');
    cy.findByRole('button', { name: 'Open Outcome 1' }).click();
    cy.contains('summary', 'Technical details').click();
    cy.findByRole('heading', { name: 'No review or verification evidence yet' }).should('be.visible');
    cy.findByRole('button', { name: /Back to Goals/ }).click();
  });
});

// Replays the three reported decisions without touching installed goals.
describe('Goal decision clarity', () => {
  for (const width of [390, 1440]) for (const scenario of ['plan', 'publication', 'setup'] as const) {
    it(`${scenario}: explains the decision above a closed 32-message history at ${width}px`, () => {
      const primary = scenario === 'plan' ? { type: 'approve', label: 'Approve plan & start work', payload: { revision: 4 } }
        : scenario === 'publication' ? { type: 'accept_moved_target', label: 'Create PR with reviewed code', payload: { operationId: 'publish', baseHeadSha: 'b'.repeat(40) } } : null;
      const next = scenario === 'setup' ? { type: 'request_revision', label: 'Fix verification plan', context: 'Correct spec-present: ["/usr/bin/test","-s","docs/spec.md"] (UNSUPPORTED_CAPABILITY)' } : null;
      const effect = scenario === 'plan' ? 'Starts implementation of plan 4, including its scope, checks and proposed team. Creating a pull request requires a separate approval.'
        : scenario === 'publication' ? 'Creates a pull request to main using the same reviewed and tested commit, without incorporating the newer changes on main. This does not merge or deploy it.'
        : 'Opens a revision draft with the failed command. Sending it requests a corrected plan; implementation waits for your approval.';
      const outcome = scenario === 'plan' ? 'Choose a model for each team role when starting a goal, with recommended models and saved manual selections.'
        : scenario === 'publication' ? 'Exclude archived folders from project discovery and the project picker while preserving existing goals.'
        : 'Use the full phone screen for the terminal and keep agent questions visible and answerable.';
      const goal = { id: 'clarity', title: scenario === 'plan' ? 'Model on Start a Goal' : scenario === 'publication' ? 'Project exclusions' : 'Session on mobile', repositoryId: 'example', version: 1, generation: 1, revision: 4, approvedRevision: scenario === 'plan' ? null : 4, experienceVersion: 2,
        status: scenario === 'plan' ? 'awaiting_approval' : scenario === 'publication' ? 'ready_to_publish' : 'building', baseBranch: 'main', integrationHead: 'a'.repeat(40), planReviewPending: false,
        pr: null, publication: null, verification: null, tasks: [], attempts: [], reviews: [], reviewRound: null, reviewRounds: [], verificationRuns: [],
        actions: [...(primary ? [primary] : []), { type: 'send_goal_message', label: 'Send message', payload: {} }, { type: 'request_revision', label: 'Request revision', payload: {} }, { type: 'abort', label: 'Abort goal', payload: {} }],
        decision: { primary, next, effect, outcome, state: scenario === 'plan' ? 'Your plan is ready to approve.' : scenario === 'publication' ? 'main changed after review.' : 'The verification plan needs a correction.',
          reason: scenario === 'publication' ? 'Publication was approved, then stopped because the target branch changed. Review the result before continuing.'
            : scenario === 'setup' ? 'Check “spec-present” could not run. Retrying the unchanged plan will not fix its setup.' : null, detail: null, rank: 0, stage: 'Needs you',
          ...(scenario === 'setup' ? { checks: [
            { id: 'spec-present', argv: ['/usr/bin/test', '-s', 'docs/spec.md'], code: 'UNSUPPORTED_CAPABILITY', artifactId: 'proof' },
            { id: 'e2e-sessions', argv: ['npm', 'run', 'test:e2e:local'], code: 'CHECK_FAILED', artifactId: 'e2e-proof' },
          ] } : {}) },
        contracts: [{ revision: 4, contract: { schemaVersion: 1, outcome, scope: ['Implement the requested behavior.'], exclusions: ['No deployment.'], criteria: [{ id: 'C1', text: 'The requested behavior works.', verification: 'unit' }], verification: [{ id: 'unit', argv: ['node', '--test'] }], tasks: [] } }],
        conversation: { paused: false, messages: Array.from({ length: 32 }, (_, i) => ({ id: `m-${i}`, sequence: i, author: 'supervisor', kind: 'message', revision: 4, text: i === 31 ? 'The current plan and decision are ready for review.' : `Earlier update ${i}: ${'Implementation details and previous decisions. '.repeat(20)}`, delivery: 'delivered' })) },
      };
      cy.intercept('GET', '**/api/orchestration/snapshot', { goals: [goal], cursor: 1, journalId: 'clarity', readOnly: false });
      cy.intercept('GET', '**/api/orchestration/configuration', { readOnly: false, terminal: false, limits: { global: 4, perGoal: 2, planners: 1 }, capabilities: [], repositories: [{ id: 'example', name: 'Example', baseBranch: 'main', error: null }] });
      cy.intercept('GET', '**/api/orchestration/goals/clarity', goal);
      cy.intercept('POST', '**/api/settings/dev-repos/reconcile', { scans: {} });
      cy.intercept('GET', '**/api/settings/favorites', { revision: 0, ids: [] });
      cy.intercept('GET', '**/api/orchestration/goals/clarity/checks/proof', { checkId: 'spec-present', headSha: goal.integrationHead, code: 'UNSUPPORTED_CAPABILITY', message: 'Executable /usr/bin/test is unavailable.', stdout: '', stderr: '', truncated: false });
      cy.viewport(width, 844); cy.visit('/orchestration?goal=clarity');
      cy.findByRole('region', { name: 'Goal decision' }).within(() => {
        cy.get('.decision-effect').should('have.text', effect).and('be.visible').then($text => expect($text[0].getBoundingClientRect().bottom).to.be.at.most(844));
        cy.findByRole('button', { name: primary?.label || next!.label }).should('be.visible').then($button => expect($button[0].getBoundingClientRect().bottom).to.be.at.most(844));
      });
      cy.findByLabelText('Conversation history').should('not.have.attr', 'open');
      cy.contains('Your planning agent is not ready.').should('not.exist');
      cy.document().then(doc => { expect(doc.documentElement.scrollWidth).to.be.at.most(width); expect(doc.documentElement.scrollHeight).to.be.lessThan(2000); });
      cy.get('.goal-conversation').children().first().should('have.attr', 'aria-label', scenario === 'publication' ? 'Goal result' : 'Proposal revision 4');
      cy.screenshot(`decision-${scenario}-${width}`, { capture: 'fullPage' });
      if (scenario === 'setup') {
        cy.findByRole('region', { name: 'Blocked checks' }).within(() => {
          cy.contains('/usr/bin/test -s docs/spec.md').should('be.visible');
          cy.contains('e2e-sessions').should('be.visible');
          cy.contains('npm run test:e2e:local').should('be.visible');
          cy.findAllByRole('button', { name: 'Inspect check output' }).first().click();
          cy.findByLabelText('Check output').should('contain.text', 'Executable /usr/bin/test is unavailable.');
        });
        cy.findByRole('button', { name: 'Fix verification plan' }).click();
        cy.findByLabelText('Request a revision').should('have.focus').and('contain.value', '/usr/bin/test');
      }
      cy.findByLabelText('Conversation history').find('summary').first().click();
      cy.contains('Earlier update 0:').should('be.visible');
    });
  }
});
