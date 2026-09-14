const settings = { devRepos: [{ id: 'karven', name: 'karven', path: '/Users/example/Developers/karven' }, { id: 'rekord', name: 'rekord', path: '/Users/example/Developers/rekord' }], projects: [{ id: 'example', name: 'companion', path: '/Users/example/Developers/karven/companion', devRepoId: 'karven', enabled: true, github: 'example/companion', remote: 'git@github.com:example/companion.git', checks: [{ id: 'test', executable: 'npm', args: ['test'] }] }], provider: 'claude', providers: { claude: { executable: 'ccs', args: ['claude'], model: 'default' }, codex: { executable: 'ccs', args: ['codex'], model: 'default' } }, tools: { cmux: 'cmux', tailscale: 'tailscale', chrome: 'chrome' }, execution: { global: 4, perGoal: 4, planners: 2, ceilingMs: 1800000, idleMs: 240000, maxOutputBytes: 1048576, killGraceMs: 5000 }, previews: { portStart: 8500, portEnd: 8599 }, onboarding: { completed: true } };
function fixtures() {
  cy.intercept('**/api/**', { statusCode: 501, body: { error: 'Unavailable in visual fixture' } });
  cy.intercept('GET', '**/api/auth/status', { paired: true });
  cy.intercept('GET', '**/api/bootstrap', { connected: true, host: { mac_display_name: 'Development Mac' }, workspaces: [], error: null, refreshedAt: '2026-09-13' });
  cy.intercept('GET', '**/api/inbox', { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept('GET', '**/api/repos', { repos: [] });
  cy.intercept('GET', '**/api/previews', { previews: [] });
  cy.intercept('GET', '**/api/account-usage*', { generatedAt: '2026-09-13', source: 'CCS', available: true, summary: { ready: 0, low: 0, exhausted: 0, reconnect: 0, unavailable: 0 }, providers: [] });
  cy.intercept('GET', '**/api/health', { version: { builtAt: '2026-09-13T12:00:00Z' } });
  cy.intercept('GET', '**/api/settings/local', { revision: 1, settings, imported: false });
  cy.intercept('GET', '**/api/updater/updates', { available: true, revision: 1, automatic: false, candidate: null, deployedSha: 'a'.repeat(40), observedSha: 'a'.repeat(40), request: null, checking: false, lastCheckAt: null });
  cy.intercept('GET', '**/api/updater/status', { available: false });
  cy.intercept('GET', '**/api/orchestration/snapshot', { goals: [], cursor: 0, journalId: 'fixture', readOnly: false });
  cy.intercept('GET', '**/api/orchestration/configuration', { readOnly: false, terminal: false, limits: settings.execution, capabilities: [{ role: 'planner', mode: 'interactive' }], repositories: [{ id: 'example', name: 'companion', devRepoName: 'karven', github: 'example/companion', baseSha: 'a'.repeat(40), baseBranch: 'main', error: null }] });
  cy.intercept('GET', '**/api/orchestration/stream', { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: '' });
}
const routes = ['/?view=sessions', '/?view=launch', '/?view=inbox', '/?view=apps', '/?view=usage', '/orchestration', '/settings#general', '/settings#dev-repos', '/settings#agents', '/settings#notifications', '/settings#updates', '/settings#advanced'];
describe('Interface consistency matrix', () => {
  for (const width of [360, 390, 1440]) it(`keeps every main surface readable and within ${width}px`, () => {
    fixtures(); cy.viewport(width, 900);
    for (const route of routes) {
      cy.visit(route); cy.findByRole('navigation', { name: 'Main navigation' }).should('be.visible');
      cy.findByRole('link', { name: 'Goals' }).should('have.attr', 'href', '/orchestration');
      cy.findByRole('link', { name: 'Settings' }).should('have.attr', 'href', '/settings');
      cy.get('main h1').should('be.visible');
      if (route === '/orchestration') cy.findByRole('button', { name: /^Project / }).should('be.visible');
      if (route.includes('/settings#')) cy.get('.settings-content h2').should('be.visible');
      cy.document().then(doc => { expect(doc.documentElement.scrollWidth, route).to.be.at.most(width); });
      cy.screenshot(`consistency-${width}-${route.replace(/[^a-z]+/g, '-')}`, { capture: 'viewport' });
    }
  });
  it('preserves drafts on cancelled navigation, supports keyboard focus and reflows enlarged text', () => {
    fixtures(); cy.viewport(1440, 900); cy.visit('/settings#agents'); cy.findByLabelText('Default provider').select('codex');
    cy.on('window:confirm', () => false); cy.findByRole('button', { name: 'Advanced' }).click(); cy.findByLabelText('Default provider').should('have.value', 'codex');
    cy.findByRole('button', { name: 'Discard changes' }).click(); cy.findByLabelText('Default provider').should('have.value', 'claude');
    cy.findByLabelText('Default provider').focus(); cy.press(Cypress.Keyboard.Keys.TAB); cy.focused().should('not.have.value', 'claude');
    cy.document().then(doc => { doc.documentElement.style.zoom = '2'; });
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(1440)); cy.screenshot('settings-enlarged-text', { capture: 'viewport' });
    cy.document().then(doc => { doc.documentElement.style.zoom = ''; });
    cy.window().then(win => { win.location.hash = 'updates'; }); cy.findByRole('heading', { name: 'Companion updates' }).should('be.visible');
    cy.visit('/?view=settings'); cy.location('pathname').should('eq', '/settings'); cy.findByRole('button', { name: 'Dev repos' }).click(); cy.location('hash').should('eq', '#dev-repos'); cy.go('back'); cy.location('hash').should('eq', '');
  });
});
