const now = "2026-09-08T09:00:00.000Z";
const alpha = { id: "terminal-alpha", title: "Alpha shell", current_directory: "/Users/dev/karven/billing" };
const beta = { id: "terminal-beta", title: "Beta agent", current_directory: "/Users/dev/karven/billing", is_focused: true };
const gamma = { id: "terminal-gamma", title: "Gamma logs", current_directory: "/Users/dev/karven/billing" };
const billing = { id: "workspace-billing", title: "Billing rewrite", current_directory: "/Users/dev/karven/billing", has_unread: true, last_activity_at: 1_788_000_000, preview: "Waiting for your answer", terminals: [alpha, beta, gamma], status: { effective: "idle", signals: { any_agent_needs_input: true } } };
const docs = { id: "workspace-docs", title: "Docs sweep", current_directory: "/Users/dev/karven/docs", has_unread: false, last_activity_at: 1_788_000_000, preview: "Rewriting README", terminals: [{ id: "terminal-docs", title: "Docs agent", is_focused: true }], status: { effective: "working", signals: { any_agent_running: true } } };
const grid = {
  mode: "grid",
  surface_id: beta.id,
  render_grid: {
    format: "cmux.render-grid.v1", columns: 40, rows: 3, scrollback_rows: 1,
    styles: [{ id: 0 }, { id: 1, bold: true, foreground: "#c9ff50" }],
    scrollback_spans: [{ row: 0, column: 0, cell_width: 14, style_id: 0, text: "Older output" }],
    row_spans: [{ row: 0, column: 0, cell_width: 10, style_id: 1, text: "$ npm test" }, { row: 1, column: 0, cell_width: 16, style_id: 0, text: "All tests passed" }],
    cursor: { row: 2, column: 0, visible: true, blinking: false, style: "block" },
  },
};

type QueueItem = { id: string; workspaceId: string; surfaceId: string; text: string; createdAt: string; updatedAt: string; attempts: number; lastError: null };

function fixtures() {
  const queue: QueueItem[] = [];
  let sequence = 0;
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "Sessions Mac", workspace_count: 2 }, workspaces: [billing, docs], error: null, refreshedAt: now }).as("bootstrap");
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false });
  cy.intercept("GET", "**/api/goal-sessions/workspace/*", { plan: null });
  cy.intercept("GET", "**/api/terminals/terminal-beta/replay*", grid).as("betaReplay");
  cy.intercept("GET", "**/api/terminals/terminal-alpha/replay*", { mode: "text", surface_id: alpha.id, text: "alpha$ git status\nnothing to commit" }).as("alphaReplay");
  cy.intercept("GET", "**/api/terminals/terminal-gamma/replay*", { mode: "text", surface_id: gamma.id, text: "tail -f server.log" }).as("gammaReplay");
  cy.intercept("GET", "**/api/prompt-queue?*", (request) => {
    request.reply({ items: queue.filter((item) => item.workspaceId === request.query.workspaceId && item.surfaceId === request.query.surfaceId) });
  }).as("queueList");
  cy.intercept("POST", "**/api/prompt-queue", (request) => {
    sequence += 1;
    const item = { id: `queue-${sequence}`, workspaceId: String(request.body.workspaceId), surfaceId: String(request.body.surfaceId), text: String(request.body.text), createdAt: now, updatedAt: now, attempts: 0, lastError: null };
    queue.push(item);
    request.reply({ statusCode: 201, body: item });
  }).as("enqueue");
  cy.intercept("PATCH", "**/api/prompt-queue/*", (request) => {
    const item = queue.find((entry) => request.url.endsWith(`/${entry.id}`));
    if (item) item.text = String(request.body.text);
    request.reply(item || { statusCode: 404, body: { error: "Unknown queue item" } });
  }).as("update");
  cy.intercept("POST", "**/api/prompt-queue/*/move", (request) => {
    const index = queue.findIndex((entry) => request.url.includes(`/${entry.id}/`));
    const target = index + Number(request.body.direction);
    if (index >= 0 && target >= 0 && target < queue.length) [queue[index], queue[target]] = [queue[target], queue[index]];
    request.reply(queue[target]);
  }).as("move");
  cy.intercept("POST", "**/api/prompt-queue/*/send", (request) => {
    const index = queue.findIndex((entry) => request.url.includes(`/${entry.id}/`));
    const [sent] = index >= 0 ? queue.splice(index, 1) : [null];
    request.reply({ sent: true, item: sent });
  }).as("send");
  cy.intercept("DELETE", "**/api/prompt-queue/*", (request) => {
    const index = queue.findIndex((entry) => request.url.endsWith(`/${entry.id}`));
    if (index >= 0) queue.splice(index, 1);
    request.reply({ removed: true });
  }).as("remove");
  cy.intercept("POST", "**/api/terminals/*/input", { ok: true }).as("input");
  cy.intercept("POST", "**/api/terminals/*/key", { ok: true }).as("key");
  return queue;
}

function visitSessions(readOnly = false) {
  cy.visit("/?view=sessions&mode=sessions", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-read-only", String(readOnly)); } });
  cy.wait("@bootstrap");
}

function openBilling() {
  cy.findByRole("button", { name: /Billing rewrite/ }).click();
  cy.location("search").should("eq", "?workspace=workspace-billing");
  cy.wait("@betaReplay");
}

for (const [width, height] of [[390, 844], [1440, 900]]) {
  describe(`Sessions and workspace detail at ${width}px`, () => {
    beforeEach(() => cy.viewport(width, height));

    it("lists sessions with their state, opens the focused terminal and renders the replay grid", () => {
      fixtures();
      visitSessions();
      cy.findByRole("heading", { name: "Sessions", level: 2 }).should("be.visible");
      cy.contains(".hero h1", "1 session need you.").should("be.visible");
      cy.get(".summary-row").should("contain.text", "2sessions").and("contain.text", "1needs you").and("contain.text", "1working");
      cy.findByRole("button", { name: /Billing rewrite/ }).should("contain.text", "~/karven/billing").and("contain.text", "Needs you").and("contain.text", "3 terminals").and("contain.text", "Waiting for your answer");
      cy.findByRole("button", { name: /Docs sweep/ }).should("contain.text", "Working").and("contain.text", "1 terminal");
      openBilling();
      cy.get("@alphaReplay.all").should("have.length", 0);
      cy.findByRole("log", { name: "Terminal output" }).should("be.visible").within(() => {
        cy.get(".terminal-grid-row").should("have.length", 4);
        cy.contains("Older output").should("be.visible");
        cy.contains("$ npm test").should("have.css", "font-weight", "700");
        cy.contains("All tests passed").should("be.visible");
      });
      cy.contains(".detail-header strong", "Billing rewrite").should("be.visible");
      cy.contains(".detail-header span", "~/karven/billing").should("be.visible");
    });

    it("switches terminals from the session menu and closes back to the sessions list", () => {
      fixtures();
      visitSessions();
      openBilling();
      cy.findByRole("button", { name: "Session menu" }).click();
      cy.findByRole("dialog", { name: "Session menu" }).within(() => {
        cy.findByRole("button", { name: "2. Beta agent" }).should("have.class", "active");
        cy.findByRole("button", { name: "1. Alpha shell" }).click();
      });
      cy.wait("@alphaReplay");
      cy.findByRole("dialog", { name: "Session menu" }).should("not.exist");
      cy.get(".terminal-fallback").should("contain.text", "alpha$ git status").and("contain.text", "nothing to commit");
      cy.findByRole("log", { name: "Terminal output" }).should("not.exist");
      cy.findByRole("button", { name: "Session menu" }).click();
      cy.findByRole("button", { name: "3. Gamma logs" }).click();
      cy.wait("@gammaReplay");
      cy.get(".terminal-fallback").should("contain.text", "tail -f server.log");
      cy.findByRole("button", { name: /Back/ }).click();
      cy.location("search").should("eq", "?view=sessions");
      cy.findByRole("heading", { name: "Sessions", level: 2 }).should("be.visible");
      cy.findByRole("button", { name: /Billing rewrite/ }).should("be.visible");
    });
  });
}

describe("Workspace input", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("sends a prompt to the selected terminal and clears the draft", () => {
    fixtures();
    visitSessions();
    openBilling();
    cy.findByRole("button", { name: "Send now" }).should("be.disabled");
    cy.findByRole("textbox", { name: "Terminal input" }).type("  Run the billing tests  ");
    cy.findByRole("button", { name: "Send now" }).should("be.enabled").click();
    cy.wait("@input").then(({ request }) => {
      expect(request.url).to.match(/\/api\/terminals\/terminal-beta\/input$/);
      expect(request.body).to.deep.equal({ text: "Run the billing tests", enter: true });
    });
    cy.findByRole("textbox", { name: "Terminal input" }).should("have.value", "");
    cy.get("@enqueue.all").should("have.length", 0);
  });

  it("keeps the draft and reports the error when the terminal rejects input", () => {
    fixtures();
    cy.intercept("POST", "**/api/terminals/terminal-beta/input", { statusCode: 502, body: { error: "cmux did not accept the prompt" } }).as("rejected");
    visitSessions();
    openBilling();
    cy.findByRole("textbox", { name: "Terminal input" }).type("Retry me later");
    cy.findByRole("button", { name: "Send now" }).click();
    cy.wait("@rejected");
    cy.findByRole("status").should("contain.text", "cmux did not accept the prompt");
    cy.findByRole("textbox", { name: "Terminal input" }).should("have.value", "Retry me later");
    cy.findByRole("button", { name: "Dismiss notification" }).click();
    cy.findByRole("status").should("not.exist");
  });

  it("sends special keys from the session menu", () => {
    fixtures();
    visitSessions();
    openBilling();
    cy.findByRole("button", { name: "Session menu" }).click();
    cy.findByRole("dialog", { name: "Session menu" }).findByRole("button", { name: "Ctrl-C" }).click();
    cy.wait("@key").then(({ request }) => {
      expect(request.url).to.match(/\/api\/terminals\/terminal-beta\/key$/);
      expect(request.body).to.deep.equal({ key: "ctrl+c" });
    });
    cy.findByRole("dialog", { name: "Session menu" }).findByRole("button", { name: "Esc" }).click();
    cy.wait("@key").its("request.body").should("deep.equal", { key: "escape" });
  });

  it("blocks every input path while read-only protection is on and unlocks from the menu", () => {
    fixtures();
    visitSessions(true);
    openBilling();
    cy.findByRole("textbox", { name: "Terminal input" }).should("be.disabled").and("have.attr", "placeholder", "Use ••• to enable input");
    cy.findByRole("button", { name: "Send now" }).should("be.disabled");
    cy.findByRole("button", { name: "Queue message" }).should("be.disabled");
    cy.findByRole("button", { name: "Attach an image" }).should("be.disabled");
    cy.findByRole("button", { name: "Open large writing area" }).should("be.disabled");
    cy.findByRole("button", { name: "Session menu" }).click();
    cy.findByRole("dialog", { name: "Session menu" }).within(() => {
      cy.findByRole("button", { name: "Enter" }).should("be.disabled");
      cy.findByRole("button", { name: "／ Shortcuts" }).should("be.disabled");
      cy.findByRole("button", { name: "Enable input" }).click();
      cy.findByRole("button", { name: "Input enabled" }).should("have.class", "active");
      cy.findByRole("button", { name: "Enter" }).should("be.enabled");
    });
    cy.window().its("localStorage").invoke("getItem", "cmux-companion-read-only").should("eq", "false");
    cy.findByRole("dialog", { name: "Session menu" }).find("header button").click();
    cy.findByRole("dialog", { name: "Session menu" }).should("not.exist");
    cy.findByRole("textbox", { name: "Terminal input" }).should("be.enabled").and("have.attr", "placeholder", "Message…");
    cy.get("@input.all").should("have.length", 0);
    cy.get("@key.all").should("have.length", 0);
  });
});

describe("Prompt queue", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("queues a draft for the selected terminal and shows the waiting count", () => {
    fixtures();
    visitSessions();
    openBilling();
    cy.findByRole("textbox", { name: "Terminal input" }).type("Add invoice totals");
    cy.findByRole("button", { name: "Queue message" }).click();
    cy.wait("@enqueue").its("request.body").should("deep.equal", { workspaceId: "workspace-billing", surfaceId: "terminal-beta", text: "Add invoice totals" });
    cy.findByRole("status").should("contain.text", "Prompt queued for the next agent stop");
    cy.findByRole("textbox", { name: "Terminal input" }).should("have.value", "");
    cy.findByRole("button", { name: "Prompt queue, 1 waiting" }).should("contain.text", "1");
    cy.get("@input.all").should("have.length", 0);
  });

  it("edits, reorders, sends and removes queued prompts from the sheet", () => {
    const queue = fixtures();
    visitSessions();
    openBilling();
    cy.findByRole("textbox", { name: "Terminal input" }).type("First prompt");
    cy.findByRole("button", { name: "Queue message" }).click();
    cy.wait("@enqueue");
    cy.findByRole("textbox", { name: "Terminal input" }).type("Second prompt");
    cy.findByRole("button", { name: "Prompt queue, 1 waiting" }).click();
    cy.wait("@enqueue");
    cy.findByRole("button", { name: "Prompt queue, 2 waiting" }).click();
    cy.findByRole("dialog", { name: "Prompt queue" }).as("sheet").should("contain.text", "2 waiting · one sent after each agent stop");
    cy.findByRole("textbox", { name: "Queued prompt 1" }).should("have.value", "First prompt");
    cy.findByRole("textbox", { name: "Queued prompt 2" }).should("have.value", "Second prompt");
    cy.findAllByRole("button", { name: "Move prompt earlier" }).first().should("be.disabled");
    cy.findAllByRole("button", { name: "Move prompt later" }).last().should("be.disabled");
    cy.findAllByRole("button", { name: "Move prompt later" }).first().click();
    cy.wait("@move").then(({ request }) => {
      expect(request.url).to.match(/\/api\/prompt-queue\/queue-1\/move$/);
      expect(request.body).to.deep.equal({ direction: 1 });
    });
    cy.findByRole("textbox", { name: "Queued prompt 1" }).should("have.value", "Second prompt");
    cy.findByRole("textbox", { name: "Queued prompt 2" }).should("have.value", "First prompt");
    cy.findByRole("textbox", { name: "Queued prompt 1" }).clear().type("Second prompt, refined").blur();
    cy.wait("@update").then(({ request }) => {
      expect(request.url).to.match(/\/api\/prompt-queue\/queue-2$/);
      expect(request.body).to.deep.equal({ text: "Second prompt, refined" });
    });
    cy.get("@sheet").findAllByRole("button", { name: "Send now" }).first().click();
    cy.wait("@send").its("request.url").should("match", /\/api\/prompt-queue\/queue-2\/send$/);
    cy.findByRole("status").should("contain.text", "Queued prompt sent");
    cy.get("@sheet").should("contain.text", "1 waiting");
    cy.findByRole("textbox", { name: "Queued prompt 1" }).should("have.value", "First prompt");
    cy.findByRole("textbox", { name: "Queued prompt 2" }).should("not.exist");
    cy.get("@sheet").findByRole("button", { name: "Remove" }).click();
    cy.wait("@remove").its("request.url").should("match", /\/api\/prompt-queue\/queue-1$/);
    cy.get("@sheet").should("contain.text", "Nothing queued");
    cy.then(() => expect(queue).to.deep.equal([]));
    cy.findByRole("button", { name: "Close prompt queue" }).click();
    cy.findByRole("dialog", { name: "Prompt queue" }).should("not.exist");
    cy.findByRole("button", { name: "Queue message" }).should("be.visible");
    cy.get("@input.all").should("have.length", 0);
  });

  it("keeps the draft when queueing fails", () => {
    fixtures();
    cy.intercept("POST", "**/api/prompt-queue", { statusCode: 503, body: { error: "Prompt queue is unavailable" } }).as("failedQueue");
    visitSessions();
    openBilling();
    cy.findByRole("textbox", { name: "Terminal input" }).type("Keep this draft");
    cy.findByRole("button", { name: "Queue message" }).click();
    cy.wait("@failedQueue");
    cy.findByRole("status").should("contain.text", "Prompt queue is unavailable");
    cy.findByRole("textbox", { name: "Terminal input" }).should("have.value", "Keep this draft");
    cy.findByRole("button", { name: "Queue message" }).should("be.visible");
  });
});

export {};
