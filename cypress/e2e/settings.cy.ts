import type { Settings } from '../../app/settings/settings-panel';
function fixtures() {
  const now = new Date().toISOString();
  let snapshot = { revision: 1, imported: false, settings: {
    devRepos: [], projects: [], provider: 'claude', providers: { claude: { executable: 'ccs', args: ['claude'], model: 'default' }, codex: { executable: 'ccs', args: ['codex'], model: 'default' } },
    launchProfiles: [], teamDefaults: {}, tools: { cmux: 'cmux', tailscale: 'tailscale' }, execution: { global: 4, perGoal: 4, planners: 2, ceilingMs: 1800000, idleMs: 240000, maxOutputBytes: 1048576, killGraceMs: 5000 }, onboarding: { completed: true },
  } as Settings };
  cy.intercept('**/api/**', { statusCode: 501, body: { error: 'Missing deterministic API fixture' } });
  cy.intercept('GET', '**/api/settings/local', req => req.reply(snapshot));
  cy.intercept('PATCH', '**/api/settings/local', req => { expect(req.body.expectedRevision).to.equal(snapshot.revision); snapshot = { ...snapshot, revision: snapshot.revision + 1, settings: { ...snapshot.settings, ...req.body.changes } }; req.reply(snapshot); }).as('save');
  cy.intercept('POST', '**/api/settings/providers/validate', { ready: true }).as('validate');
  cy.intercept('GET', '**/api/bootstrap', { connected: true, host: { mac_display_name: 'Settings Mac' }, workspaces: [], error: null, refreshedAt: now }).as('bootstrap');
  cy.intercept('GET', '**/api/health', { version: { builtAt: now } });
  cy.intercept('GET', '**/api/updater/status', { available: false });
  cy.intercept('GET', '**/api/updater/updates', { available: false });
  cy.intercept('GET', '**/api/account-usage*', { generatedAt: now, source: 'CCS', available: true, summary: { ready: 1, low: 0, exhausted: 0, reconnect: 0, unavailable: 1 }, providers: [
    { id: 'claude', label: 'Claude', available: true, accounts: [{ id: 'fresh', label: 'Ready account', email: null, plan: null, isDefault: true, paused: false, status: 'ready', message: null, updatedAt: now, windows: [{ id: 'weekly', cadence: 'weekly', category: 'usage', label: 'Weekly', remainingPercent: 72, reported: true, resetAt: null }] }] },
    { id: 'codex', label: 'Codex', available: true, accounts: [{ id: 'stale', label: 'Stale account', email: null, plan: null, isDefault: false, paused: false, status: 'ready', message: null, updatedAt: '2020-01-01T00:00:00Z', windows: [{ id: 'weekly', cadence: 'weekly', category: 'usage', label: 'Weekly', remainingPercent: 33, reported: true, resetAt: null }] }] },
  ] }).as('usage');
}
function visitSettings() { cy.visit('/settings#general'); cy.wait('@bootstrap'); cy.findByRole('heading', { name: 'Setup' }).should('be.visible'); }
for (const width of [390, 1200]) describe(`Setup at ${width}px`, () => {
  beforeEach(() => { cy.viewport(width, 900); fixtures(); });
  it('preserves device input protection, shows capacity freshness and retains updater access', () => {
    visitSettings();
    cy.findByLabelText(/Protect terminal input/).should('be.checked').uncheck();
    cy.reload(); cy.findByLabelText(/Protect terminal input/).should('not.be.checked').check();
    cy.findByRole('button', { name: 'Account usage' }).click(); cy.wait('@usage');
    cy.contains('72%').should('be.visible'); cy.contains('33%').should('not.exist'); cy.contains('Capacity unknown:').should('be.visible');
    cy.get('.local-settings-page').screenshot(`setup-capacity-${width}`);
    cy.findByRole('button', { name: 'Updates' }).click(); cy.contains('Update controls are unavailable. An installed bundled updater is required.').should('be.visible');
    cy.findByRole('button', { name: 'Notifications' }).should('not.exist'); cy.contains('Local apps and preview links').should('not.exist');
    cy.findByRole('button', { name: '← Setup overview' }).click(); cy.contains('Workspace readiness').should('be.visible');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    cy.screenshot(`setup-overview-${width}`, { capture: 'viewport' });
  });
  it('validates and persists a named role profile without leaving Setup', () => {
    cy.visit('/settings#agents'); cy.findByRole('button', { name: 'Add launch profile' }).click();
    cy.findByLabelText('Profile name').clear().type('Design team');
    cy.findByRole('checkbox', { name: 'Planner & designer' }).check();
    cy.findByLabelText('Preferred Planner & designer').select('Design team');
    cy.findByRole('button', { name: 'Save changes' }).click(); cy.wait('@validate'); cy.wait('@save');
    cy.reload(); cy.findByLabelText('Profile name').should('have.value', 'Design team');
    cy.findByLabelText('Preferred Planner & designer').find('option:selected').should('have.text', 'Design team');
    cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    cy.screenshot(`setup-profiles-${width}`, { capture: 'viewport' });
  });
});
describe("Settings install prompt", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("hides the home-screen button until the browser offers installation", () => {
    fixtures();
    visitSettings();
    cy.findByRole("button", { name: "Add companion to home screen" }).should("not.exist");
    cy.window().then((win) => {
      const event = new win.Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt?: () => Promise<void> };
      event.prompt = cy.stub().resolves();
      cy.wrap(event.prompt).as("installPrompt");
      win.dispatchEvent(event);
      expect(event.defaultPrevented).to.equal(true);
    });
    cy.findByRole("button", { name: "Add companion to home screen" }).click();
    cy.get("@installPrompt").should("have.been.calledOnce");
  });
});
