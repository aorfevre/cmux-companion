// Licence usage: every CCS account's remaining quota, the reconnect sheet that
// polls a login session, refresh, and the unavailable states. Date is frozen
// so countdowns and "updated" stamps read the same on every run; timers stay
// real because the reconnect sheet polls on a short interval.
import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const frozenNow = new Date("2026-09-08T12:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(frozenNow.getTime() + offsetMinutes * 60_000).toISOString();

type Account = { id: string; label: string; email: string | null; plan: string | null; isDefault: boolean; paused: boolean; status: "ready" | "low" | "exhausted" | "reconnect" | "unavailable"; message: string | null; updatedAt: string | null; windows: Array<{ id: string; cadence: string; label: string; category: string; remainingPercent: number; resetAt: string | null; reported: true }> };

function usageFixture() {
  const work: Account = { id: "claude-work", label: "work", email: "work@example.test", plan: "max", isDefault: true, paused: false, status: "ready", message: null, updatedAt: iso(-5), windows: [
    { id: "w-5h", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 82, resetAt: iso(95), reported: true },
    { id: "w-weekly", cadence: "weekly", label: "Weekly limit", category: "usage", remainingPercent: 55, resetAt: iso((3 * 24 + 2) * 60 + 7), reported: true },
    { id: "w-monthly", cadence: "monthly", label: "Monthly provider limit", category: "usage", remainingPercent: 44, resetAt: iso(20 * 24 * 60), reported: true },
    { id: "w-review", cadence: "other", label: "code-review-tokens", category: "code-review", remainingPercent: 12, resetAt: null, reported: true },
  ] };
  const personal: Account = { id: "claude-personal", label: "personal", email: null, plan: "pro", isDefault: false, paused: true, status: "exhausted", message: "Weekly limit reached. Resets automatically.", updatedAt: iso(-1), windows: [
    { id: "p-5h", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 0, resetAt: iso(-10), reported: true },
    { id: "p-weekly", cadence: "weekly", label: "Weekly limit", category: "usage", remainingPercent: 0, resetAt: iso(36 * 60), reported: true },
  ] };
  const codex: Account = { id: "0123456789abcdefabcd", label: "codex", email: "codex@example.test", plan: "plus", isDefault: true, paused: false, status: "reconnect", message: "The OpenAI session expired. Reconnect to keep Codex available.", updatedAt: null, windows: [] };
  const daily: Account = { id: "codex-daily", label: "daily", email: "daily@example.test", plan: null, isDefault: false, paused: false, status: "low", message: null, updatedAt: iso(-2), windows: [
    { id: "d-daily", cadence: "daily", label: "gpt-5-daily", category: "additional", remainingPercent: 15, resetAt: iso(6 * 60), reported: true },
  ] };
  return { generatedAt: iso(-1), source: "CCS", available: true, summary: { ready: 1, low: 1, exhausted: 1, reconnect: 1, unavailable: 0 }, providers: [
    { id: "claude", label: "Claude Code", available: true, accounts: [work, personal] },
    { id: "codex", label: "OpenAI Codex", available: true, accounts: [codex, daily] },
  ] };
}

function scenario() {
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/settings/local", { statusCode: 404, body: { error: "Legacy settings" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: iso(0) });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: iso(-60) } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
}

function fiveAccountFixture() {
  const usage = usageFixture();
  const personal = usage.providers[0].accounts[1];
  personal.email = 'personal@example.test'; personal.status = 'low'; personal.message = null;
  personal.windows[0].remainingPercent = 100; personal.windows[0].resetAt = null;
  personal.windows[1].remainingPercent = 5; personal.windows[1].resetAt = iso(47);
  usage.providers[1].accounts = [32, 95, 48].map((remainingPercent, index) => ({
    ...usage.providers[0].accounts[0], id: `codex-${index}`, email: `codex-${index}@example.test`,
    windows: [{ id: 'weekly', cadence: 'weekly', category: 'usage', label: 'Weekly limit', remainingPercent, resetAt: iso(6 * 24 * 60 + index * 60), reported: true }],
  }));
  usage.summary = { ready: 4, low: 1, exhausted: 0, reconnect: 0, unavailable: 0 };
  return usage;
}

function visitUsage() {
  cy.clock(frozenNow.getTime(), ["Date"]);
  cy.visit("/?view=usage");
}

function account(name: string) { return cy.contains(".usage-account", name); }

describe("licence usage", () => {
  for (const width of [390, 1280, 1440]) {
    it(`opens the tracker directly from home at ${width}px`, () => {
      cy.viewport(width, 900);
      scenario();
      cy.intercept('GET', '**/api/account-usage*', fiveAccountFixture()).as('usage');
      cy.clock(frozenNow.getTime(), ['Date']);
      cy.visit('/');
      cy.wait('@usage');
      cy.findByRole('heading', { name: 'Account usage' }).should('be.visible');
      cy.findByRole('link', { name: 'Account usage' }).should('have.attr', 'aria-current', 'page');
      cy.get('.settings-categories').should('not.exist');
      account('work@example.test').should('contain.text', '82% remaining').and('contain.text', '18% used');
      cy.findByRole('link', { name: 'Mission Control' }).should('have.attr', 'href', '/orchestration');
      cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
      cy.get('.usage-page-head').should($head => expect($head[0].getBoundingClientRect().right).to.be.at.most(width));
      cy.findByRole('heading', { name: 'Account usage' }).should('have.css', 'color', 'rgb(23, 40, 32)');
      cy.findByRole('complementary', { name: 'Next weekly reset' }).should('contain.text', 'personal@example.test').and('contain.text', '5% unused').and('contain.text', '47m').and('contain.text', 'Paused in CCS');
      cy.get('.usage-account').should('have.length', 5);
      cy.get('.usage-account-details[open]').should('not.exist');
      cy.get('.reset-highlights aside').each($card => {
        cy.wrap($card).find('a svg[data-provider="claude"]').should('be.visible').and('have.attr', 'aria-hidden', 'true');
      });
      cy.get('.reset-queue-row').each($row => {
        const provider = $row.text().includes('OpenAI') ? 'codex' : 'claude';
        cy.wrap($row).find(`a svg[data-provider="${provider}"]`).should('be.visible');
      });
      cy.get('.reset-queue-row.use-next').should('contain.text', '55% unused').and('contain.text', '5h: 82% remaining');
      cy.findByRole('complementary', { name: 'Weekly capacity to use before reset' }).should('contain.text', '5h: 82% remaining');
      cy.get('.reset-queue-row').should('have.length', 5).first().should('contain.text', 'personal@example.test').and('contain.text', '47m');
      cy.findByRole('complementary', { name: 'Weekly capacity to use before reset' }).should('contain.text', 'work@example.test').and('contain.text', '55%');
      if (width >= 1280) cy.get('.reset-queue-row').each($row => {
        expect($row[0].getBoundingClientRect().bottom).to.be.at.most(900);
      });
      cy.findByRole('button', { name: 'Usable now' }).click();
      cy.get('.reset-queue-row').should('have.length', 4).first().should('contain.text', 'work@example.test');
      cy.get('.reset-queue').should('not.contain.text', 'personal@example.test');
      cy.findByRole('button', { name: /^Next reset$/ }).click();
      cy.get('.next-reset-account').should('contain.text', 'personal@example.test');
      if (width <= 1280) cy.screenshot(`account-usage-home-${width}`, { capture: 'fullPage', scale: true });
    });
  }

  it('pairs a new device on the home tracker before showing account usage', () => {
    scenario();
    let paired = false;
    cy.intercept('GET', '**/api/account-usage*', req => req.reply(paired ? usageFixture() : { statusCode: 401, body: { error: 'Pair this device' } })).as('usage');
    cy.intercept('POST', '**/api/auth/pair', req => { expect(req.body.token).to.eq('disposable-code'); paired = true; req.reply({ paired: true }); }).as('pair');
    cy.clock(frozenNow.getTime(), ['Date']);
    cy.visit('/');
    cy.wait('@usage');
    cy.get('.usage-account').should('not.exist');
    cy.findByLabelText('Pairing code').type('disposable-code');
    cy.findByRole('button', { name: 'Pair this device' }).click();
    cy.wait('@pair');
    account('work@example.test').should('be.visible');
    cy.findByLabelText('Pairing code').should('not.exist');
  });

  for (const [width, height] of [[390, 844], [1440, 900]]) {
    it(`groups accounts by provider with every cadence and status readable at ${width}px`, () => {
      cy.viewport(width, height);
      scenario();
      cy.intercept("GET", "**/api/account-usage", usageFixture()).as("usage");
      visitUsage();
      cy.wait("@usage");
      cy.findByRole("heading", { name: "Account usage" }).should("be.visible");
      cy.get(".usage-summary").should("contain.text", "4").and("contain.text", "accounts").and("contain.text", "3").and("contain.text", "need attention").and("contain.text", "Updated 1m ago");
      cy.contains(".usage-provider", "Claude Code").should("contain.text", "2 connected accounts");
      cy.contains(".usage-provider", "OpenAI Codex").should("contain.text", "2 connected accounts");
      account("work@example.test").within(() => {
        cy.get("summary").click();
        cy.contains("max · default").should("be.visible");
        cy.get(".usage-status").should("have.text", "Available");
        cy.contains(".core-window", "5 hours").should("contain.text", "82%").and("contain.text", "Resets in 1h 35m");
        cy.contains(".core-window", "Weekly").should("contain.text", "55%").and("contain.text", "Resets in 3d 2h 7m");
        cy.contains("Additional limits").should("be.visible");
        // Every reported cadence remains visible, including monthly limits.
        cy.get(".extra-window").should("have.length", 2);
        cy.contains("Monthly provider limit").should("be.visible");
        cy.contains(".extra-window", "code review tokens").should("contain.text", "12%").and("contain.text", "Reset unknown");
        cy.findByRole("button", { name: "Reconnect account" }).should("not.exist");
      });
      account("personal").within(() => {
        cy.get("summary").click();
        cy.contains("pro · paused").should("be.visible");
        cy.get(".usage-status").should("have.text", "Exhausted");
        cy.contains("Weekly limit reached. Resets automatically.").should("be.visible");
        cy.contains(".core-window", "5 hours").should("contain.text", "0%").and("contain.text", "Reset due");
        cy.contains(".core-window", "Weekly").should("contain.text", "Resets in 1d 12h 0m");
      });
      account("codex@example.test").within(() => {
        cy.get("summary").click();
        cy.get(".usage-status").should("have.text", "Reconnect");
        cy.contains("The OpenAI session expired").should("be.visible");
        cy.get(".core-window").should("have.length", 1).each(($window) => expect($window.text()).to.include("Not reported"));
        cy.findByRole("button", { name: "Reconnect account" }).should("be.visible");
      });
      account("daily@example.test").within(() => {
        cy.get("summary").click();
        cy.get(".usage-status").should("have.text", "Low");
        cy.contains(".extra-window", "GPT 5 daily").should("contain.text", "15%").and("contain.text", "daily").and("contain.text", "Resets in 6h 0m");
      });
      cy.contains("summary", "About these readings").click();
      cy.contains("OAuth credentials are used only on your Mac").should("be.visible");
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  for (const width of [390, 1440]) {
    it(`deletes a connection after confirmation and retries failures at ${width}px`, () => {
      cy.viewport(width, 900);
      scenario();
      let removed = false;
      let attempts = 0;
      cy.intercept("GET", "**/api/account-usage*", request => {
        const usage = usageFixture();
        if (removed) { usage.providers[0].accounts.shift(); usage.summary.ready = 0; }
        request.reply(usage);
      }).as("usage");
      cy.intercept("DELETE", "**/api/account-usage/claude-work", request => {
        attempts++;
        if (attempts === 1) request.reply({ statusCode: 409, body: { error: "Close the active reconnect before deleting this connection" } });
        else { removed = true; request.reply({ removed: true }); }
      }).as("delete");
      visitUsage();
      cy.wait("@usage");
      account("work@example.test").find("summary").click();
      account("work@example.test").findByRole("button", { name: "Delete connection" }).click();
      cy.findByRole("group", { name: "Delete connection confirmation" }).should("contain.text", "Claude Code").and("contain.text", "subscription remain active");
      cy.findByRole("button", { name: "Cancel" }).click();
      cy.get("@delete.all").should("have.length", 0);
      account("work@example.test").findByRole("button", { name: "Delete connection" }).click();
      cy.findByRole("button", { name: "Confirm delete" }).click();
      cy.wait("@delete");
      cy.findByRole("alert").should("contain.text", "Close the active reconnect");
      cy.findByRole("button", { name: "Confirm delete" }).click();
      cy.wait("@delete");
      cy.wait("@usage");
      cy.contains(".usage-account", "work@example.test").should("not.exist");
      cy.get(".usage-account").should("have.length", 3);
      cy.contains(".usage-provider", "Claude Code").should("contain.text", "1 connected account");
      cy.document().then(doc => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  it("refreshes from CCS on demand and returns to Settings", () => {
    cy.viewport(390, 844);
    scenario();
    let reads = 0;
    cy.intercept("GET", "**/api/account-usage*", (request) => {
      reads += 1;
      const usage = usageFixture();
      if (reads > 1) { usage.providers[0].accounts[0].windows[0].remainingPercent = 61; usage.generatedAt = iso(0); }
      request.reply(usage);
    }).as("usage");
    visitUsage();
    cy.wait("@usage").its("request.url").should("not.include", "refresh=1");
    account("work@example.test").contains(".core-window", "5 hours").should("contain.text", "82%");
    cy.findByRole("button", { name: "Refresh account usage" }).click();
    cy.wait("@usage").its("request.url").should("include", "refresh=1");
    account("work@example.test").contains(".core-window", "5 hours").should("contain.text", "61%");
    cy.get(".usage-summary").should("contain.text", "Updated now");
    cy.get(".next-usage-reset a").click();
    cy.location("hash").should("eq", "#usage");
    cy.get(".next-reset-account").should("have.focus");
    cy.findByRole("button", { name: "This device" }).click();
    cy.findByRole("heading", { name: /^Setup$/ }).should("be.visible");
    cy.location("pathname").should("eq", "/settings");
    cy.visit("/settings#agents");
    cy.findByRole("button", { name: "View account usage" }).click();
    cy.findByRole("heading", { name: "Account usage" }).should("be.visible");
    cy.location("hash").should("eq", "#usage");
  });

  it("reports a failed read without inventing quota and recovers with Try again", () => {
    cy.viewport(390, 844);
    scenario();
    let failing = true;
    cy.intercept("GET", "**/api/account-usage*", (request) => {
      if (failing) request.reply({ statusCode: 503, body: { error: "CCS did not answer within 10 seconds" } });
      else request.reply(usageFixture());
    }).as("usage");
    visitUsage();
    cy.wait("@usage");
    cy.get(".usage-error").should("contain.text", "Usage unavailable").and("contain.text", "CCS did not answer within 10 seconds");
    cy.get(".usage-account").should("not.exist");
    cy.get(".usage-summary").should("not.exist");
    cy.then(() => { failing = false; });
    cy.findByRole("button", { name: "Try again" }).click();
    cy.wait("@usage").its("request.url").should("include", "refresh=1");
    cy.get(".usage-error").should("not.exist");
    cy.get(".usage-account").should("have.length", 4);
  });

  it("distinguishes a missing CCS install from a provider that returned nothing", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/account-usage*", { generatedAt: iso(0), source: "CCS", available: false, summary: { ready: 0, low: 0, exhausted: 0, reconnect: 0, unavailable: 0 }, providers: [
      { id: "claude", label: "Claude Code", available: false, accounts: [] },
      { id: "codex", label: "OpenAI Codex", available: true, accounts: [] },
    ] }).as("usage");
    visitUsage();
    cy.wait("@usage");
    cy.get(".usage-error").should("contain.text", "CCS usage is unavailable").and("contain.text", "Check that CCS is installed on this Mac");
    cy.get(".usage-summary").should("contain.text", "0").and("contain.text", "accounts");
    cy.contains(".usage-provider", "Claude Code").should("contain.text", "This provider did not return usage.");
    cy.contains(".usage-provider", "OpenAI Codex").should("contain.text", "No CCS account connected.");
    cy.contains("OAuth credentials are used only on your Mac").should("not.exist");
  });

  it("reconnects an expired account by polling the login session and refreshes usage on success", () => {
    cy.viewport(390, 844);
    scenario();
    const session = { sessionId: "reconnect-1", provider: "codex", status: "waiting", message: "Complete the provider login", authUrl: "https://auth.openai.test/authorize?state=safe", expiresAt: iso(10) };
    let polls = 0;
    let reads = 0;
    cy.intercept("GET", "**/api/account-usage*", (request) => {
      reads += 1;
      const usage = usageFixture();
      if (reads > 1) { Object.assign(usage.providers[1].accounts[0], { status: "ready", message: null, updatedAt: iso(0), windows: [{ id: "c-5h", cadence: "5h", label: "Session limit", category: "usage", remainingPercent: 100, resetAt: iso(300), reported: true }] }); usage.summary.reconnect = 0; usage.summary.ready = 2; }
      request.reply(usage);
    }).as("usage");
    cy.intercept("POST", "**/api/account-usage/0123456789abcdefabcd/reconnect", { statusCode: 201, body: session }).as("start");
    cy.intercept("GET", "**/api/account-usage/reconnect/reconnect-1", (request) => {
      polls += 1;
      request.reply(polls < 2 ? session : polls === 2 ? { ...session, status: "processing", message: "Exchanging the login code" } : { ...session, status: "success", message: "Account reconnected", authUrl: null });
    }).as("poll");
    cy.intercept("DELETE", "**/api/account-usage/reconnect/reconnect-1", { statusCode: 200, body: { ...session, status: "cancelled" } }).as("cancel");
    visitUsage();
    cy.wait("@usage");
    account("codex@example.test").findByRole("button", { name: "Reconnect account" }).click();
    cy.wait("@start");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).within(() => {
      cy.contains("Reconnect Codex").should("be.visible");
      cy.contains("codex@example.test").should("be.visible");
      cy.findByRole("link", { name: /Open OpenAI login/ }).should("have.attr", "href", session.authUrl).and("have.attr", "target", "_blank");
      cy.contains("Complete the provider login").should("be.visible");
      cy.findByRole("button", { name: "Finish reconnect" }).should("be.disabled");
    });
    cy.wait("@poll");
    cy.wait("@poll");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("contain.text", "Exchanging the login code");
    cy.wait("@poll");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("contain.text", "Account reconnected").and("contain.text", "The licence usage has been refreshed.");
    cy.wait("@usage").its("request.url").should("include", "refresh=1");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).findByRole("button", { name: "Done" }).click();
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("not.exist");
    cy.get("@cancel.all").should("have.length", 0);
    account("codex@example.test").find(".usage-status").should("have.text", "Available");
    cy.get(".usage-summary").should("contain.text", "2").and("contain.text", "need attention");
  });

  it("finishes reconnect from a pasted callback URL and cancels the session when the sheet closes early", () => {
    cy.viewport(390, 844);
    scenario();
    const session = { sessionId: "reconnect-2", provider: "codex", status: "waiting", message: "Complete the provider login", authUrl: "https://auth.openai.test/authorize?state=safe", expiresAt: iso(10) };
    cy.intercept("GET", "**/api/account-usage*", usageFixture()).as("usage");
    cy.intercept("POST", "**/api/account-usage/0123456789abcdefabcd/reconnect", { statusCode: 201, body: session }).as("start");
    cy.intercept("GET", "**/api/account-usage/reconnect/reconnect-2", session).as("poll");
    cy.intercept("POST", "**/api/account-usage/reconnect/reconnect-2/callback", (request) => {
      if (request.body.callbackUrl.includes("state=wrong")) { request.reply({ statusCode: 400, body: { error: "The callback state does not match this login" } }); return; }
      request.reply({ ...session, status: "success", message: "Account reconnected", authUrl: null });
    }).as("callback");
    cy.intercept("DELETE", "**/api/account-usage/reconnect/reconnect-2", { statusCode: 200, body: { ...session, status: "cancelled", message: "Login cancelled" } }).as("cancel");
    visitUsage();
    cy.wait("@usage");
    account("codex@example.test").findByRole("button", { name: "Reconnect account" }).click();
    cy.wait("@start");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).within(() => {
      cy.findByLabelText("Localhost callback URL").type("http://localhost:1455/?code=abc&state=wrong");
      cy.findByRole("button", { name: "Finish reconnect" }).click();
    });
    cy.wait("@callback").its("request.body").should("deep.equal", { callbackUrl: "http://localhost:1455/?code=abc&state=wrong" });
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).within(() => {
      cy.get(".reconnect-error").should("contain.text", "The callback state does not match this login");
      cy.findByLabelText("Localhost callback URL").should("have.value", "http://localhost:1455/?code=abc&state=wrong").clear().type("http://localhost:1455/?code=abc&state=safe");
      cy.findByRole("button", { name: "Finish reconnect" }).click();
    });
    cy.wait("@callback").its("request.body.callbackUrl").should("eq", "http://localhost:1455/?code=abc&state=safe");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("contain.text", "Account reconnected");
    cy.wait("@usage").its("request.url").should("include", "refresh=1");
    cy.findAllByRole("button", { name: "Close reconnect" }).first().click();
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("not.exist");
    cy.get("@cancel.all").should("have.length", 0);
    // Closing while the login is still waiting cancels that session on the Mac.
    account("codex@example.test").findByRole("button", { name: "Reconnect account" }).click();
    cy.wait("@start");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("contain.text", "Complete the provider login");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).findByRole("button", { name: "Close reconnect" }).click();
    cy.wait("@cancel").its("request.method").should("eq", "DELETE");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("not.exist");
  });

  it("shows why a reconnect could not start and leaves the account untouched", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/account-usage*", usageFixture()).as("usage");
    cy.intercept("POST", "**/api/account-usage/0123456789abcdefabcd/reconnect", { statusCode: 503, body: { error: "CCS login is unavailable while another reconnect is running" } }).as("start");
    visitUsage();
    cy.wait("@usage");
    account("codex@example.test").findByRole("button", { name: "Reconnect account" }).click();
    cy.wait("@start");
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).within(() => {
      cy.get(".reconnect-error").should("contain.text", "CCS login is unavailable while another reconnect is running");
      cy.findByRole("link", { name: /login/ }).should("not.exist");
      cy.findByRole("button", { name: "Close reconnect" }).click();
    });
    cy.findByRole("dialog", { name: "Reconnect OpenAI Codex" }).should("not.exist");
    account("codex@example.test").find(".usage-status").should("have.text", "Reconnect");
  });
});
