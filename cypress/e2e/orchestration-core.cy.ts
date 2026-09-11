import type { Goal, LaunchRequest } from '../../server/orchestration/types';
type Evidence = {goals:Goal[];overlaps:string[];launches:LaunchRequest[];prCreates:unknown[];pulls:{branch:string}[]};
const suite = Cypress.expose('orchestration') ? describe : describe.skip;
suite('Mobile orchestration with real service and disposable Git', () => {
  beforeEach(() => {
    cy.viewport(390, 844);
    cy.task('orchestrationRelease', 'reset');
    cy.visit('/orchestration');
    cy.task<string>('orchestrationPairing', null, { log: false }).then(token => {
      cy.findByLabelText('Pairing token').type(token, { log: false });
      cy.findByRole('button', { name: 'Pair device' }).click();
    });
    cy.findByRole('heading', { name: 'Start a goal' }).should('be.visible');
  });
  const writable = Cypress.expose('orchestrationReadOnly') ? it.skip : it;
  const readonly = Cypress.expose('orchestrationReadOnly') ? it : it.skip;
  readonly('protects the real service in read-only mode', () => {
    cy.contains('Read-only mode · controls are disabled.').should('be.visible');
    cy.findByRole('button', { name: 'Start planning' }).should('be.disabled');
    cy.request({ method: 'POST', url: '/api/orchestration/commands', body: { id: 'readonly', goalId: 'readonly', expectedVersion: 0, type: 'create_goal', payload: {} }, failOnStatusCode: false }).its('status').should('equal', 403);
    cy.task<Evidence>('orchestrationEvidence').its('goals').should('have.length', 0);
  });
  writable('reviews a plan, overlaps implementers, repairs review and verification, then publishes one exact-head PR', () => {
    cy.findByLabelText('What should we accomplish?').type('Build the parallel fixture');
    cy.findByRole('button', { name: 'Start planning' }).click();
    cy.findByRole('button', { name: 'Approve revision 1', timeout: 20000 }).should('be.enabled').click();
    cy.get('[data-task="A"]').should('contain.text', 'running');
    cy.get('[data-task="B"]').should('contain.text', 'running');
    cy.get('[data-task="C"]').should('contain.text', 'pending');
    cy.task<Evidence>('orchestrationEvidence', { title: 'Build the parallel fixture', overlap: true }).then(evidence => {
      const goal = evidence.goals.find((entry) => entry.title === 'Build the parallel fixture')!;
      expect(evidence.overlaps).to.include(goal.id);
      expect(evidence.launches.filter((entry) => entry.goalId === goal.id && entry.attempt.taskId === 'C')).to.have.length(0);
    });
    cy.reload(); cy.contains('button', 'Build the parallel fixture').click();
    cy.get('[data-task="A"]').should('contain.text', 'running');
    cy.task('orchestrationRelease', 'siblings');
    cy.contains('Blocking: Composition does not add its inputs', { timeout: 30000 }).should('be.visible');
    cy.findByRole('region', { name: 'Combined verification' }).contains('p', 'injected_dependencies', { timeout: 30000 }).should('contain.text', 'Failed');
    cy.findByRole('link', { name: /Open pull request/ }).should('not.exist');
    cy.task<Evidence>('orchestrationEvidence').then(evidence => { expect(evidence.prCreates).to.have.length(0); });
    cy.task('orchestrationRelease', 'final');
    cy.findByRole('link', { name: 'Open pull request #1', timeout: 30000 }).should('be.visible');
    cy.task<Evidence>('orchestrationEvidence', { title: 'Build the parallel fixture', status: 'delivered' }).then(evidence => {
      const goal = evidence.goals.find((entry) => entry.title === 'Build the parallel fixture')!;
      expect(goal.status).to.equal('delivered'); expect(goal.pr!.headSha).to.equal(goal.integrationHead); expect(goal.verification!.headSha).to.equal(goal.pr!.headSha);
      expect(evidence.prCreates).to.have.length(1);
      const composition = evidence.launches.find((entry) => entry.goalId === goal.id && entry.attempt.taskId === 'C' && entry.attempt.role === 'implementer')!;
      cy.task<string>('orchestrationGit', { branch: composition.attempt.branch, file: 'src/a.mjs' }).should('include', 'return 2');
      cy.task<string>('orchestrationGit', { branch: composition.attempt.branch, file: 'src/b.mjs' }).should('include', 'return 3');
      cy.task<string>('orchestrationGit', { branch: evidence.pulls[0].branch, file: 'src/composition.mjs' }).should('include', 'aSource() + bSource()');
    });
    cy.document().then(doc => { expect(doc.documentElement.scrollWidth).to.be.at.most(390); });
  });
  writable('aborts waiting siblings and reconciles without running their dependent task', () => {
    cy.findByLabelText('What should we accomplish?').type('Abort this fixture');
    cy.findByRole('button', { name: 'Start planning' }).click();
    cy.findByRole('button', { name: 'Approve revision 1', timeout: 20000 }).click();
    cy.get('[data-task="A"]').should('contain.text', 'running');
    cy.findByRole('button', { name: 'Abort goal' }).click();
    cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'aborted');
    cy.findByRole('button', { name: 'Reconcile workers' }).click();
    cy.task<Evidence>('orchestrationEvidence', { title: 'Abort this fixture', status: 'aborted' }).then(evidence => {
      const goal = evidence.goals.find((entry) => entry.title === 'Abort this fixture')!;
      expect(goal.status).to.equal('aborted');
      expect(evidence.launches.filter((entry) => entry.goalId === goal.id && entry.attempt.taskId === 'C')).to.have.length(0);
    });
  });
});
