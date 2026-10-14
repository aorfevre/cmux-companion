import type { Goal, LaunchRequest } from '../../server/orchestration/types';
const suite = Cypress.expose('orchestration') && !Cypress.expose('orchestrationReadOnly') ? describe : describe.skip;
function settledSupervisor(remaining = 100): Cypress.Chainable<{ goals: Goal[] }> {
  return cy.task<{ goals: Goal[] }>('orchestrationEvidence').then(evidence => {
    if (evidence.goals.find(goal => goal.title === 'Conversation fixture')?.conversation?.waiting) return cy.wrap(evidence, { log: false });
    expect(remaining, 'supervisor finishes its current event turn').to.be.greaterThan(0);
    return cy.wait(100).then(() => settledSupervisor(remaining - 1));
  });
}
suite('Conversational Goals with the real disposable service', () => {
  it('recovers stopped agents and keeps conversation, approvals and queued steering through reload', () => {
    cy.viewport(1440, 1000);
    cy.task('orchestrationRelease', 'reset');
    cy.task('orchestrationRelease', 'launch-transient');
    cy.task('orchestrationRelease', 'stop-planner');
    cy.task('orchestrationRelease', 'stop-reviewer');
    cy.visit('/orchestration');
    cy.task<string>('orchestrationPairing', null, { log: false }).then(token => {
      cy.findByLabelText('Pairing code').type(token, { log: false });
      cy.findByRole('button', { name: 'Pair this device' }).click();
    });
    cy.findByRole('button', { name: 'Start a goal' }).click();
    cy.findByRole('button', { name: /^Project / }).click();
    cy.findByRole('button', { name: /Show all projects/ }).click();
    cy.get('.project-choice').first().click();
    cy.findByLabelText('Supervisor').should('be.enabled').select('codex');
    cy.findByLabelText('Title (optional)').type('Conversation fixture');
    cy.findByLabelText('What should we accomplish?').type('Build the disposable modules.');
    cy.findByRole('button', { name: 'Start goal' }).click();
    cy.get('.goal-conversation').should('be.visible');
    cy.findByRole('region', { name: 'Goal decision' }).should('contain.text', 'Agents are recovering the goal.');
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Recover goal' }).should('not.exist');
    cy.screenshot('agent-recovery-desktop', { capture: 'viewport' });
    cy.viewport(390, 844); cy.screenshot('agent-recovery-phone', { capture: 'viewport' });
    cy.viewport(1440, 1000);
    cy.contains('Shall I use the disposable module fixture', { timeout: 20000 }).should('be.visible');
    cy.get('.goal-conversation').within(() => {
      cy.findByLabelText('Message your supervisor').type('Yes, use the fixture.');
      cy.findByRole('button', { name: 'Send message' }).click();
    });
    // Decisions live in the bar above the conversation, never inside a proposal card.
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Approve plan & start work', timeout: 20000 }).should('be.enabled');
    cy.get('.goal-conversation').within(() => {
      cy.findByRole('region', { name: 'Proposal revision 1' }).should('contain.text', 'Request changes in the message box below.');
      cy.findByLabelText('Message your supervisor').type('Please revise the plan.');
      cy.findByRole('button', { name: 'Send message' }).click();
    });
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Approve plan & start work', timeout: 20000 }).should('be.enabled');
    cy.findByRole('region', { name: 'Proposal revision 2', timeout: 20000 }).should('be.visible');
    cy.findByLabelText('Conversation history').find('summary').first().click();
    cy.get('.goal-conversation').contains('summary', 'Proposal 1 · Superseded by 2').should('be.visible');
    cy.findByLabelText('Conversation history').find('summary').first().click();
    cy.findByRole('button', { name: 'More' }).click(); cy.findByLabelText('More actions').findByRole('button', { name: 'Pause goal' }).click();
    cy.findByRole('region', { name: 'Goal decision' }).within(() => {
      cy.findByRole('status').should('have.text', 'Your plan is ready to approve.');
      cy.findByRole('button', { name: 'Approve plan & start work' }).should('be.enabled');
    });
    cy.get('.goal-conversation').within(() => {
      cy.findByLabelText('Message your supervisor').type('Keep this guidance through reload.');
      cy.findByRole('button', { name: 'Send message' }).click();
      cy.contains('Queued for supervisor').should('be.visible');
    });
    cy.reload();
    cy.get('.goal-conversation').contains('Keep this guidance through reload.').should('be.visible');
    cy.findByRole('button', { name: 'More' }).click(); cy.findByLabelText('More actions').findByRole('button', { name: 'Resume goal' }).click();
    cy.findByLabelText('Conversation history').find('summary').first().click();
    cy.get('.goal-conversation').contains('Keep this guidance through reload.').closest('section').contains('Answered', { timeout: 10000 });
    settledSupervisor();
    // The service can settle after the last browser snapshot; refresh before
    // approving that version, since approvals deliberately do not auto-rebase.
    cy.reload();
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Approve plan & start work' }).should('be.enabled').click();
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Approve plan & start work' }).should('not.exist');
    cy.findByLabelText('Conversation history').find('summary').first().click();
    cy.get('.goal-conversation').within(() => {
      cy.contains('Agent recovery scheduled:', { timeout: 20000 }).should('be.visible');
      cy.findByRole('heading', { name: 'Working agents', timeout: 20000 }).should('be.visible');
      cy.findByRole('region', { name: 'Working agents' }).findAllByRole('listitem', { timeout: 20000 }).should('have.length', 2);
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
      expect(goal.team?.assignments.find(entry => entry.role === 'planner')?.profileId).to.equal('codex');
      const retried = goal.attempts.filter(attempt => attempt.launchFailure?.code === 'PROVIDER_SPAWN_EAGAIN');
      expect(retried).to.have.length(1);
      expect(retried[0].workerState).to.equal('stopped');
      expect(goal.attempts.filter(attempt => attempt.role === 'implementer' && attempt.taskId === retried[0].taskId)).to.have.length(2);
      expect(goal.conversation!.messages.filter(message => message.text === 'Keep this guidance through reload.')).to.have.length(1);
      expect(evidence.launches.filter(launch => launch.goalId === goal.id && launch.attempt.role === 'planner')).to.have.length(2);
      expect(goal.recoveryPolicy!.decisions.filter(entry => entry.state === 'applied').length).to.be.at.least(3);
      const causes = goal.recoveryPolicy!.decisions.flatMap(entry => entry.evidence.map(item => item.cause));
      expect(causes).to.include('NATIVE_TERMINAL_FAILED');
      expect(causes).to.include('OUTPUT_LIMIT');
      expect(goal.recoveries?.filter(entry => !goal.recoveryPolicy!.decisions.some(decision => decision.holdId === entry.hold.id))).to.have.length(0);
    });
    cy.task('orchestrationRelease', 'siblings');
    cy.task('orchestrationRelease', 'final');
    cy.get('.goal-conversation').within(() => {
      cy.findByRole('heading', { name: 'Result', timeout: 60000 }).should('be.visible');
      cy.contains('summary', 'Review and check evidence').click();
      cy.contains('summary', 'Worker checks and repair budgets').click();
      cy.contains('unit · run 1 of 3').should('be.visible');
      cy.contains('unit · run 2 of 3').should('be.visible');
      cy.contains('unit: Failed').should('be.visible');
      cy.contains('unit: Passed').should('be.visible');
      cy.findByRole('button', { name: 'Inspect changes' }).click();
      cy.findByLabelText('Integrated diff').should('contain.text', 'aSource() + bSource()');
    });
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Create pull request' }).should('be.enabled');
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
    settledSupervisor();
    cy.reload();
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('button', { name: 'Create pull request' }).click();
    cy.get('.goal-conversation').findByRole('link', { name: /Open pull request #/, timeout: 30000 }).should('be.visible');
    cy.reload();
    cy.get('.goal-conversation').findByRole('link', { name: /Open pull request #/, timeout: 10000 }).should('be.visible');
    cy.task<{ goals: Goal[]; prCreates: { headSha?: string }[] }>('orchestrationEvidence').then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Conversation fixture')!;
      expect(evidence.prCreates).to.have.length(1);
      cy.get('@publishedHead').then(head => expect(goal.pr!.headSha).to.equal(head));
    });
    cy.findByRole('button', { name: 'More' }).click(); cy.findByLabelText('More actions').findByRole('button', { name: 'Abort goal' }).click();
    cy.findByRole('region', { name: 'Goal decision' }).findByRole('status').should('have.text', 'Aborted. Evidence is retained.');
  });
});
