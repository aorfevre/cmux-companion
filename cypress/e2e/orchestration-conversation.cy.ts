import type { Goal, LaunchRequest } from '../../server/orchestration/types';
const suite = Cypress.expose('orchestration') && !Cypress.expose('orchestrationReadOnly') ? describe : describe.skip;
suite('Conversational Goals with the real disposable service', () => {
  it('keeps one supervisor through questions, revision, queued steering, reload and dispatch', () => {
    cy.viewport(1440, 1000);
    cy.task('orchestrationRelease', 'reset');
    cy.task('orchestrationRelease', 'launch-transient');
    cy.visit('/orchestration');
    cy.task<string>('orchestrationPairing', null, { log: false }).then(token => {
      cy.findByLabelText('Pairing code').type(token, { log: false });
      cy.findByRole('button', { name: 'Pair this device' }).click();
    });
    cy.findByRole('button', { name: 'Start a goal' }).click();
    cy.findByRole('button', { name: /^Project / }).click();
    cy.findByRole('button', { name: /Show all projects/ }).click();
    cy.get('.project-choice').first().click();
    cy.findByLabelText('Try conversational Goals (evaluation)').check();
    cy.findByLabelText('Title (optional)').type('Conversation fixture');
    cy.findByLabelText('What should we accomplish?').type('Build the disposable modules.');
    cy.findByRole('button', { name: 'Start goal' }).click();
    cy.get('.goal-conversation').should('be.visible');
    cy.contains('Shall I use the disposable module fixture', { timeout: 20000 }).should('be.visible');
    cy.get('.goal-conversation').within(() => {
      cy.findByLabelText('Message your supervisor').type('Yes, use the fixture.');
      cy.findByRole('button', { name: 'Send message' }).click();
      cy.findByRole('button', { name: 'Approve revision 1', timeout: 20000 }).should('be.enabled');
      cy.findByLabelText('Message your supervisor').type('Please revise the plan.');
      cy.findByRole('button', { name: 'Send message' }).click();
      cy.findByRole('button', { name: 'Approve revision 2', timeout: 20000 }).should('be.enabled');
      cy.findByRole('button', { name: 'Pause goal' }).click();
      cy.findByRole('button', { name: 'Resume goal' }).should('be.enabled');
      cy.findByLabelText('Message your supervisor').type('Keep this guidance through reload.');
      cy.findByRole('button', { name: 'Send message' }).click();
      cy.contains('Queued for supervisor').should('be.visible');
    });
    cy.reload();
    cy.get('.goal-conversation').within(() => {
      cy.contains('Keep this guidance through reload.').should('be.visible');
      cy.findByRole('button', { name: 'Resume goal' }).click();
      cy.contains('Keep this guidance through reload.').closest('section').contains('Answered', { timeout: 10000 });
      cy.findByRole('button', { name: 'Approve revision 2' }).click();
      cy.contains('Automatic launch retry 1 of 1 is queued', { timeout: 20000 }).should('be.visible');
      cy.findByRole('heading', { name: 'Working agents', timeout: 20000 }).should('be.visible');
      cy.findByLabelText('Message your supervisor').focus().should('have.focus');
    });
    cy.document().its('documentElement.clientWidth').should('equal', 1440);
    cy.screenshot('conversation-desktop');
    cy.viewport(390, 844);
    cy.get('.goal-composer').scrollIntoView().should('be.visible');
    cy.screenshot('conversation-phone');
    cy.task<{ goals: Goal[]; launches: LaunchRequest[] }>('orchestrationEvidence').then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Conversation fixture')!;
      expect(goal.experienceVersion).to.equal(2);
      const retried = goal.attempts.filter(attempt => attempt.launchFailure?.scheduled);
      expect(retried).to.have.length(1);
      expect(retried[0].workerState).to.equal('stopped');
      expect(goal.attempts.filter(attempt => attempt.role === 'implementer' && attempt.taskId === retried[0].taskId)).to.have.length(2);
      expect(goal.conversation!.messages.filter(message => message.text === 'Keep this guidance through reload.')).to.have.length(1);
      expect(evidence.launches.filter(launch => launch.goalId === goal.id && launch.attempt.role === 'planner')).to.have.length(1);
    });
    cy.task('orchestrationRelease', 'siblings');
    cy.task('orchestrationRelease', 'final');
    cy.get('.goal-conversation').within(() => {
      cy.findByRole('heading', { name: 'Result', timeout: 60000 }).should('be.visible');
      cy.contains('summary', 'Worker checks and repair budgets').click();
      cy.contains('unit · run 1 of 3').should('be.visible');
      cy.contains('unit · run 2 of 3').should('be.visible');
      cy.contains('unit: Failed').should('be.visible');
      cy.contains('unit: Passed').should('be.visible');
      cy.findByRole('button', { name: 'Inspect changes' }).click();
      cy.findByLabelText('Integrated diff').should('contain.text', 'aSource() + bSource()');
      cy.findByRole('button', { name: 'Approve & publish PR' }).should('be.enabled');
    });
    cy.task<{ goals: Goal[]; prCreates: unknown[] }>('orchestrationEvidence').then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Conversation fixture')!;
      expect(goal.verificationRuns!.filter(run => run.attemptId)).to.have.length(2);
      expect(goal.finalRepairCount).to.equal(1);
      expect(goal.hold).to.equal(null);
      expect(evidence.prCreates).to.have.length(0);
      expect(goal.verification!.headSha).to.equal(goal.integrationHead);
      expect(goal.reviews.some(review => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'accept')).to.equal(true);
      cy.wrap(goal.integrationHead).as('publishedHead');
    });
    cy.viewport(1440, 1000); cy.screenshot('conversation-result-desktop');
    cy.viewport(390, 844); cy.screenshot('conversation-result-phone');
    cy.get('.goal-conversation').findByRole('button', { name: 'Approve & publish PR' }).click();
    cy.get('.goal-conversation').findByRole('link', { name: /Open pull request #/, timeout: 30000 }).should('be.visible');
    cy.reload();
    cy.get('.goal-conversation').findByRole('link', { name: /Open pull request #/, timeout: 10000 }).should('be.visible');
    cy.task<{ goals: Goal[]; prCreates: { headSha?: string }[] }>('orchestrationEvidence').then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Conversation fixture')!;
      expect(evidence.prCreates).to.have.length(1);
      cy.get('@publishedHead').then(head => expect(goal.pr!.headSha).to.equal(head));
    });
    cy.get('.goal-conversation').findByRole('button', { name: 'Abort goal' }).click();
    cy.get('.goal-conversation').contains('Aborted · evidence retained').should('be.visible');
  });
});
