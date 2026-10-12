import type { Goal, LaunchRequest } from '../../server/orchestration/types';
const suite = Cypress.expose('orchestration') && !Cypress.expose('orchestrationReadOnly') ? describe : describe.skip;
suite('Conversational Goals with the real disposable service', () => {
  it('keeps one supervisor through questions, revision, queued steering, reload and dispatch', () => {
    cy.viewport(1440, 1000);
    cy.task('orchestrationRelease', 'reset');
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
      expect(goal.conversation!.messages.filter(message => message.text === 'Keep this guidance through reload.')).to.have.length(1);
      expect(evidence.launches.filter(launch => launch.goalId === goal.id && launch.attempt.role === 'planner')).to.have.length(1);
    });
    cy.get('.goal-conversation').findByRole('button', { name: 'Abort goal' }).click();
    cy.get('.goal-conversation').contains('Aborted · evidence retained').should('be.visible');
  });
});
