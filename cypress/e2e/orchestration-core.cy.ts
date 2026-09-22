import type { Goal, LaunchRequest } from '../../server/orchestration/types';
type Evidence = {goals:Goal[];overlaps:string[];launches:LaunchRequest[];prCreates:unknown[];pulls:{branch:string}[];replies:unknown[];resolutions:unknown[]};
const suite = Cypress.expose('orchestration') ? describe : describe.skip;
suite('Mobile orchestration with real service and disposable Git', () => {
  beforeEach(() => {
    cy.viewport(390, 844);
    cy.task('orchestrationRelease', 'reset');
    cy.visit('/orchestration');
    cy.task<string>('orchestrationPairing', null, { log: false }).then(token => {
      cy.findByLabelText('Pairing code').type(token, { log: false });
      cy.findByRole('button', { name: 'Pair this device' }).click();
    });
    cy.findByRole('button', { name: 'Start a goal' }).should('be.visible');
    if (!Cypress.expose('orchestrationReadOnly')) cy.findByRole('button', { name: 'Start a goal' }).click();
  });
  const writable = Cypress.expose('orchestrationReadOnly') ? it.skip : it;
  const readonly = Cypress.expose('orchestrationReadOnly') ? it : it.skip;
  readonly('protects the real service in read-only mode', () => {
    cy.contains('Read-only mode · controls are disabled.').should('be.visible');
    cy.findByRole('button', { name: 'Start a goal' }).should('be.disabled');
    cy.request({ method: 'POST', url: '/api/orchestration/commands', body: { id: 'readonly', goalId: 'readonly', expectedVersion: 0, type: 'create_goal', payload: {} }, failOnStatusCode: false }).its('status').should('equal', 403);
    cy.task<Evidence>('orchestrationEvidence').its('goals').should('have.length', 0);
  });
  writable('automatically revises a rejected plan, waits for approval, and filters aborted history', () => {
    cy.task('orchestrationRelease', 'reject-plan');
    cy.findByRole('button', { name: /^Project / }).click(); cy.findByRole('button', { name: /Show all projects/ }).click(); cy.get('.project-choice').first().click();
    cy.findByLabelText('Title (optional)').type('Automatic plan revision');
    cy.findByLabelText('What should we accomplish?').type('Revise the rejected fixture plan before asking me to approve.');
    cy.findByRole('button', { name: 'Start goal' }).click();
    cy.findByRole('button', { name: 'Automatic plan revision', timeout: 20000 }).find('.mission-workers').click();
    cy.findByRole('button', { name: 'Approve revision 2', timeout: 30000 }).should('be.enabled');
    cy.contains('Automatic plan revisions: 1 of 2.').should('be.visible');
    cy.task<Evidence>('orchestrationEvidence').then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Automatic plan revision')!;
      expect(goal.planRevisionCount).to.equal(1);
      expect(evidence.launches.filter(entry => entry.goalId === goal.id && entry.attempt.role === 'implementer')).to.have.length(0);
    });
    cy.findByRole('button', { name: 'Abort goal' }).click();
    cy.findByRole('button', { name: /Back to Mission Control/ }).click();
    cy.findByRole('button', { name: 'Automatic plan revision' }).should('not.exist');
    cy.findByRole('button', { name: /^Aborted$/ }).click();
    cy.findByRole('button', { name: 'Automatic plan revision' }).find('.mission-workers').click();
    cy.findByRole('heading', { name: 'Automatic plan revision' }).should('be.visible');
    cy.findByRole('button', { name: /Back to Mission Control/ }).click();
    cy.findByRole('button', { name: /^Aborted$/ }).should('have.attr', 'aria-pressed', 'true');
    cy.screenshot('aborted-fleet-phone');
    cy.viewport(1200, 1000); cy.screenshot('aborted-fleet-desktop');
  });
  writable('reviews a plan, overlaps implementers, repairs review and verification, then publishes one exact-head PR', () => {
    cy.findByRole('button', { name: /^Project / }).click(); cy.findByRole('button', { name: /Show all projects/ }).click(); cy.get('.project-choice').first().click();
    cy.findByLabelText('Title (optional)').type('Build the parallel fixture');
    cy.findByLabelText('What should we accomplish?').type('Build the parallel fixture from the attached design. See https://example.com/design');
    cy.findByLabelText('Reference files').selectFile([
      { contents: Cypress.Buffer.from('<svg>Read as source</svg>'), fileName: 'design.svg', mimeType: 'image/svg+xml' },
      { contents: Cypress.Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64'), fileName: 'design.png', mimeType: 'image/png' },
    ]);
    cy.findByRole('button', { name: 'Remove design.png' }).should('be.visible');
    cy.findByRole('button', { name: 'Start goal' }).click();
    cy.contains('.mission-goal-link', 'Build the parallel fixture', { timeout: 20000 }).click();
    cy.findByRole('link', { name: 'design.svg' }).then(link => {
      cy.request(link.attr('href')!).then(response => { expect(response.headers['content-type']).to.include('text/plain'); expect(response.body).to.equal('<svg>Read as source</svg>'); });
    });
    cy.findByRole('link', { name: 'design.png' }).should('be.visible');
    cy.findByRole('tab', { name: 'Team & models' }).click();
    cy.findByLabelText('Profile for Implementation A').select('codex');
    cy.contains('summary', 'Manual override · Why').should('be.visible');
    cy.get('[role=tablist] [role=tab]').then(tabs => {
      const rectangles = [...tabs].map(tab => tab.getBoundingClientRect());
      rectangles.slice(1).forEach((rectangle, index) => expect(rectangle.left).to.be.at.least(rectangles[index].right));
      [...tabs].forEach(tab => expect(tab.scrollWidth).to.be.at.most(tab.clientWidth + 1));
    });
    cy.screenshot('team-proposal-phone');
    cy.viewport(1200, 1000); cy.screenshot('team-proposal-desktop');
    cy.document().then(doc => { expect(doc.documentElement.scrollWidth).to.be.at.most(1200); });
    cy.viewport(390, 844);
    cy.findByRole('button', { name: 'Approve revision 1', timeout: 20000 }).should('be.enabled').click();
    cy.findByRole('tab', { name: 'Waves & sessions' }).click();
    cy.get('[data-task="A"]').should('contain.text', 'running');
    cy.get('[data-task="B"]').should('contain.text', 'running');
    cy.get('[data-task="C"]').should('contain.text', 'pending').and('contain.text', 'Waiting for the prior wave barrier');
    cy.findByRole('region', { name: 'Independent modules' }).should('contain.text', 'Barrier checks: modules');
    cy.get('[data-task="A"]').should('contain.text', 'implementer: running');
    cy.get('[data-task="B"]').should('contain.text', 'implementer: running');
    cy.screenshot('execution-waves-phone');
    cy.viewport(1200, 1000); cy.screenshot('execution-waves-desktop');
    cy.document().then(doc => { expect(doc.documentElement.scrollWidth).to.be.at.most(1200); });
    cy.viewport(390, 844);
    cy.task<Evidence>('orchestrationEvidence', { title: 'Build the parallel fixture', overlap: true }).then(evidence => {
      const goal = evidence.goals.find((entry) => entry.title === 'Build the parallel fixture')!;
      expect(evidence.overlaps).to.include(goal.id);
      expect(evidence.launches.filter((entry) => entry.goalId === goal.id && entry.attempt.taskId === 'C')).to.have.length(0);
    });
    cy.reload(); cy.findByRole('tab', { name: 'Waves & sessions' }).click();
    cy.get('[data-task="A"]').should('contain.text', 'running');
    cy.task('orchestrationRelease', 'siblings');
    cy.findByRole('tab', { name: 'Run report' }).click();
    cy.contains('Blocking: Composition does not add its inputs', { timeout: 30000 }).should('be.visible');
    // Task review findings repair automatically; verification failures still require recovery.
    cy.findByRole('region', { name: 'Combined verification', timeout: 30000 }).contains('p', 'injected_dependencies', { timeout: 30000 }).should('contain.text', 'Failed');
    cy.findByRole('region', { name: 'Combined verification' }).contains('p', 'prepare').should('contain.text', 'Passed');
    cy.findByRole('region', { name: 'Combined verification' }).findAllByRole('button', { name: 'Inspect check output' }).first().click();
    cy.findByLabelText('Check output').should('contain.text', 'fixture prepare');
    cy.findByRole('link', { name: /Open pull request/ }).should('not.exist');
    cy.task<Evidence>('orchestrationEvidence').then(evidence => { expect(evidence.prCreates).to.have.length(0); });
    cy.task<string>('orchestrationAdvanceTarget').as('movedTarget');
    cy.task('orchestrationRelease', 'final');
    cy.findByRole('button', { name: 'Recover goal', timeout: 30000 }).should('be.enabled').click();
    cy.findByRole('button', { name: 'Approve & publish PR', timeout: 30000 }).should('be.enabled').click();
    cy.contains('The target branch moved to', { timeout: 30000 }).should('be.visible');
    cy.findByRole('link', { name: /Open pull request/ }).should('not.exist');
    cy.task<Evidence>('orchestrationEvidence').then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Build the parallel fixture')!;
      expect(goal.publication!.observation!.status).to.equal('target_moved');
      cy.wrap(goal.integrationHead).as('reviewedHead');
      cy.wrap(goal.reviews.length).as('reviewCount');
      expect(evidence.prCreates).to.have.length(0);
    });
    cy.reload();
    cy.findByRole('button', { name: 'Publish reviewed head against moved target' }).should('be.enabled').click();
    cy.findByRole('link', { name: 'Open pull request #1', timeout: 30000 }).should('be.visible');
    cy.task<Evidence>('orchestrationEvidence', { title: 'Build the parallel fixture', status: 'delivered' }).then(evidence => {
      const goal = evidence.goals.find((entry) => entry.title === 'Build the parallel fixture')!;
      expect(goal.waveResults!.map(result => result.waveId)).to.include.members(['modules', 'composition']);
      expect(goal.verificationRuns!.find(run => run.waveId === 'modules')!.result!.verification.checks.every(check => check.passed)).to.equal(true);
      expect(goal.status).to.equal('delivered'); expect(goal.pr!.headSha).to.equal(goal.integrationHead); expect(goal.verification!.headSha).to.equal(goal.pr!.headSha);
      expect(evidence.prCreates).to.have.length(1);
      cy.get('@reviewedHead').should('equal', goal.pr!.headSha);
      cy.get('@reviewCount').should('equal', goal.reviews.length);
      cy.get('@movedTarget').should('equal', goal.publication!.plan.acceptedTargets!.at(-1)!.baseHeadSha);
      const moduleBarrier = goal.waveResults!.find(result => result.waveId === 'modules')!;
      const composition = evidence.launches.find((entry) => entry.goalId === goal.id && entry.attempt.taskId === 'C' && entry.attempt.role === 'implementer')!;
      expect(composition.attempt.baseSha).to.equal(moduleBarrier.headSha);
      expect(goal.team!.approved).to.equal(true);
      expect(goal.attempts.find(attempt => attempt.taskId === 'A' && attempt.role === 'implementer')!.assignment!.profileId).to.equal('codex');
      cy.task<string>('orchestrationGit', { branch: composition.attempt.branch, file: 'src/a.mjs' }).should('include', 'return 2');
      cy.task<string>('orchestrationGit', { branch: composition.attempt.branch, file: 'src/b.mjs' }).should('include', 'return 3');
      cy.task<string>('orchestrationGit', { branch: evidence.pulls[0].branch, file: 'src/composition.mjs' }).should('include', 'aSource() + bSource()');
    });
    // A configuration fault and an unreachable GitHub must read differently:
    // one says a retry is useless, the other invites a retry.
    cy.task('orchestrationRelease', 'threads-uncapable');
    cy.findByRole('button', { name: 'Address review comments', timeout: 30000 }).should('be.enabled').click();
    cy.findByLabelText('Review round phase', { timeout: 30000 }).should('contain.text', 'unavailable in this configuration').and('not.contain.text', 'online');
    cy.task('orchestrationRelease', 'clear-threads-uncapable');
    cy.findByRole('button', { name: 'Recover goal', timeout: 30000 }).click();
    cy.task('orchestrationRelease', 'threads-offline');
    cy.findByRole('button', { name: 'Address review comments', timeout: 30000 }).should('be.enabled').click();
    cy.findByLabelText('Review round phase', { timeout: 30000 }).should('contain.text', 'Retry when your Mac is online');
    cy.task('orchestrationRelease', 'clear-threads-offline');
    cy.findByRole('button', { name: 'Recover goal', timeout: 30000 }).click();
    cy.task('orchestrationRelease', 'seed-threads');
    cy.findByRole('button', { name: 'Address review comments', timeout: 30000 }).should('be.enabled').click();
    cy.findByRole('button', { name: 'Address review comments', timeout: 60000 }).should('be.enabled');
    cy.findByRole('tab', { name: 'Run report' }).click();
    cy.findByRole('heading', { name: 'Review rounds' }).should('be.visible');
    cy.contains(/Addressed · 2 threads/).should('be.visible');
    cy.task<Evidence>('orchestrationEvidence', { title: 'Build the parallel fixture', status: 'delivered' }).then(evidence => {
      const goal = evidence.goals.find(entry => entry.title === 'Build the parallel fixture')!;
      // The two fault rounds are recorded before the successful one.
      expect(goal.reviewRounds!).to.have.length(3);
      expect(goal.reviewRounds!.map(round => round.outcome)).to.deep.equal(['failed', 'failed', 'addressed']);
      expect(goal.pr!.headSha).to.equal(goal.reviewRounds!.at(-1)!.fixHeadSha);
      // The approved checks must execute on the fix head. A refused check would
      // fail the round with no run and no output at all.
      const fixRun = goal.verificationRuns!.find(run => run.headSha === goal.reviewRounds!.at(-1)!.fixHeadSha)!;
      expect(fixRun, 'the fix head is verified by its own run').to.not.equal(undefined);
      expect(fixRun.result!.verification.checks.map(check => check.id)).to.include('unit');
      expect(fixRun.result!.verification.checks.every(check => check.passed)).to.equal(true);
      expect(goal.mergeSync).to.equal(undefined);
      expect(evidence.replies).to.have.length(2);
      expect(evidence.resolutions).to.have.length(1);
      cy.task<string>('orchestrationGit', { branch: evidence.pulls[0].branch, file: 'src/a.mjs' }).should('include', 'addressed review');
    });
    cy.document().then(doc => { expect(doc.documentElement.scrollWidth).to.be.at.most(390); });
  });
  writable('aborts waiting siblings and reconciles without running their dependent task', () => {
    cy.findByRole('button', { name: /^Project / }).click(); cy.findByRole('button', { name: /Show all projects/ }).click(); cy.get('.project-choice').first().click();
    cy.findByLabelText('What should we accomplish?').type('Abort this fixture');
    cy.findByRole('button', { name: 'Start goal' }).click();
    cy.contains('.mission-goal-link', 'Abort this fixture', { timeout: 20000 }).click();
    cy.findByRole('button', { name: 'Approve revision 1', timeout: 20000 }).click();
    cy.findByRole('tab', { name: 'Waves & sessions' }).click();
    cy.get('[data-task="A"]').should('contain.text', 'running');
    cy.findByRole('button', { name: 'Abort goal' }).click();
    cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'Aborted');
    cy.contains('summary', 'Source and technical details').click(); cy.findByRole('button', { name: 'Reconcile workers' }).click();
    cy.task<Evidence>('orchestrationEvidence', { title: 'Abort this fixture', status: 'aborted' }).then(evidence => {
      const goal = evidence.goals.find((entry) => entry.title === 'Abort this fixture')!;
      expect(goal.status).to.equal('aborted');
      expect(evidence.launches.filter((entry) => entry.goalId === goal.id && entry.attempt.taskId === 'C')).to.have.length(0);
    });
  });
});
