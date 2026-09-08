const now = "2026-09-08T09:00:00.000Z";
const billing = { id: "workspace-billing", title: "Billing rewrite", current_directory: "/Users/dev/karven/billing", has_unread: true, terminals: [{ id: "terminal-billing", title: "Billing agent", is_focused: true }] };
const docs = { id: "workspace-docs", title: "Docs sweep", current_directory: "/Users/dev/karven/docs", terminals: [{ id: "terminal-docs", title: "Docs agent" }] };
const docsRepo = { id: "repo-docs", name: "Docs", root: "karven", path: "/Users/dev/karven/docs", branch: "main", ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1_788_000_000, scripts: [] };

type Item = Record<string, unknown> & { id: string; type: "request" | "notification" };
const question: Item = { id: "req-question", requestId: "req-question", type: "request", kind: "question", workspaceId: billing.id, surfaceId: "terminal-billing", title: "Agent question", subtitle: "Billing agent", body: "Which database should invoices use?", toolName: null, toolInput: null, questionOptions: ["Postgres", "SQLite", "Write reply…"] };
const permission: Item = { id: "req-permission", requestId: "req-permission", type: "request", kind: "permissionRequest", workspaceId: billing.id, title: "Permission requested", body: "", toolName: "Bash", toolInput: { command: "rm -rf dist" }, questionOptions: [] };
const plan: Item = { id: "req-plan", requestId: "req-plan", type: "request", kind: "exitPlan", workspaceId: docs.id, title: "Plan ready for review", body: "Rewrite the README in three passes.", toolName: null, toolInput: null, questionOptions: [] };
const notification: Item = { id: "notif-report", type: "notification", kind: "notification", workspaceId: docs.id, title: "Docs check finished", subtitle: null, body: "The summary is in docs/REPORT.md" };

function fixtures(initial: Item[] = [question, permission, plan, notification]) {
  let items = [...initial];
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "Inbox Mac" }, workspaces: [billing, docs], error: null, refreshedAt: now }).as("bootstrap");
  cy.intercept("GET", "**/api/repos", { repos: [docsRepo] }).as("repos");
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/prompt-queue?*", { items: [] });
  cy.intercept("GET", "**/api/goal-sessions/workspace/*", { plan: null });
  cy.intercept("GET", "**/api/terminals/*/replay*", { mode: "text", text: "Billing agent is waiting" }).as("replay");
  cy.intercept("GET", "**/api/inbox", (request) => {
    const actionable = items.filter((item) => item.type === "request");
    request.reply({ items, actionableCount: actionable.length, unreadCount: items.length - actionable.length });
  }).as("inbox");
  cy.intercept("POST", "**/api/inbox/*/reply", (request) => {
    items = items.filter((item) => !request.url.includes(`/api/inbox/${item.id}/reply`));
    request.reply({ ok: true, result: {} });
  }).as("reply");
  cy.intercept("POST", "**/api/notifications/*/read", (request) => {
    items = items.filter((item) => !request.url.includes(`/api/notifications/${item.id}/read`));
    request.reply({ ok: true });
  }).as("read");
  return { remove: (id: string) => { items = items.filter((item) => item.id !== id); } };
}

function visitInbox(search = "?view=inbox") {
  cy.visit(`/${search}`);
  cy.wait("@inbox");
  cy.wait("@repos");
}

for (const [width, height] of [[390, 844], [1440, 900]]) {
  describe(`Inbox at ${width}px`, () => {
    beforeEach(() => cy.viewport(width, height));

    it("renders each kind with its actions and answers a question with an option", () => {
      fixtures();
      visitInbox();
      cy.findByRole("heading", { name: "Inbox", level: 1 }).should("be.visible");
      cy.get(".inbox-card").should("have.length", 4);
      cy.contains(".inbox-card", "Agent question").within(() => {
        cy.get(".inbox-kind").should("have.text", "Question");
        cy.contains("Billing agent").should("be.visible");
        cy.contains("Which database should invoices use?").should("be.visible");
        cy.findByRole("button", { name: "Billing rewrite ›" }).should("be.visible");
        cy.findByRole("button", { name: "Write reply…" }).should("be.visible");
      });
      cy.contains(".inbox-card", "Permission requested").within(() => {
        cy.get(".inbox-kind").should("have.text", "Permission");
        cy.get(".tool-preview").should("contain.text", "Bash").and("contain.text", "\"command\": \"rm -rf dist\"");
        cy.findByRole("button", { name: "Approve once" }).should("be.visible");
        cy.findByRole("button", { name: "Deny" }).should("be.visible");
      });
      cy.contains(".inbox-card", "Plan ready for review").within(() => {
        cy.get(".inbox-kind").should("have.text", "Plan");
        cy.findByRole("button", { name: "Auto accept" }).should("be.visible");
      });
      cy.contains(".inbox-card", "Docs check finished").within(() => {
        cy.get(".inbox-kind").should("have.text", "Update");
        cy.findByRole("button", { name: "Mark read" }).should("be.visible");
      });
      cy.contains(".inbox-card", "Agent question").findByRole("button", { name: "Postgres" }).click();
      cy.wait("@reply").then(({ request }) => {
        expect(request.url).to.match(/\/api\/inbox\/req-question\/reply$/);
        expect(request.body).to.deep.equal({ kind: "question", selections: ["Postgres"] });
      });
      cy.wait("@inbox");
      cy.contains(".inbox-card", "Agent question").should("not.exist");
      cy.get(".inbox-card").should("have.length", 3);
    });
  });
}

describe("Inbox decisions", () => {
  beforeEach(() => cy.viewport(390, 844));

  it("sends a free-text answer through the prompt and skips an empty one", () => {
    fixtures([question]);
    visitInbox();
    cy.window().then((win) => { cy.stub(win, "prompt").as("prompt").onFirstCall().returns("   ").onSecondCall().returns("  Use MySQL  "); });
    cy.findByRole("button", { name: "Write reply…" }).click();
    cy.get("@prompt").should("have.been.calledOnceWith", "Reply to the agent");
    cy.get("@reply.all").should("have.length", 0);
    cy.findByRole("button", { name: "Write reply…" }).click();
    cy.wait("@reply").its("request.body").should("deep.equal", { kind: "question", selections: ["Use MySQL"] });
    cy.contains("All clear").should("be.visible");
  });

  it("approves a permission once and denies a plan with feedback", () => {
    fixtures([permission, plan]);
    visitInbox();
    cy.window().then((win) => { cy.stub(win, "prompt").returns("Too broad, split it"); });
    cy.findByRole("button", { name: "Approve once" }).click();
    cy.wait("@reply").then(({ request }) => {
      expect(request.url).to.match(/\/api\/inbox\/req-permission\/reply$/);
      expect(request.body).to.deep.equal({ kind: "permissionRequest", mode: "once" });
    });
    cy.contains(".inbox-card", "Plan ready for review").findByRole("button", { name: "Deny" }).click();
    cy.wait("@reply").then(({ request }) => {
      expect(request.url).to.match(/\/api\/inbox\/req-plan\/reply$/);
      expect(request.body).to.deep.equal({ kind: "exitPlan", mode: "deny", feedback: "Too broad, split it" });
    });
    cy.contains("All clear").should("be.visible");
  });

  it("keeps the item and reports the error when a reply fails", () => {
    fixtures([permission]);
    cy.intercept("POST", "**/api/inbox/req-permission/reply", { statusCode: 409, body: { error: "This request already completed on your Mac" } }).as("failedReply");
    visitInbox();
    cy.findByRole("button", { name: "Deny" }).click();
    cy.wait("@failedReply").its("request.body").should("deep.equal", { kind: "permissionRequest", mode: "deny" });
    cy.findByRole("status").should("contain.text", "This request already completed on your Mac");
    cy.contains(".inbox-card", "Permission requested").should("be.visible");
    cy.findByRole("button", { name: "Deny" }).should("be.enabled");
  });

  it("marks a notification read and refreshes the list", () => {
    fixtures([notification, question]);
    visitInbox();
    cy.findByRole("button", { name: "Mark read" }).click();
    cy.wait("@read").its("request.url").should("match", /\/api\/notifications\/notif-report\/read$/);
    cy.wait("@inbox");
    cy.contains(".inbox-card", "Docs check finished").should("not.exist");
    cy.contains(".inbox-card", "Agent question").should("be.visible");
  });

  it("reports a failed mark-read without dropping the notification", () => {
    fixtures([notification]);
    cy.intercept("POST", "**/api/notifications/notif-report/read", { statusCode: 500, body: { error: "cmux rejected the update" } }).as("failedRead");
    visitInbox();
    cy.findByRole("button", { name: "Mark read" }).click();
    cy.wait("@failedRead");
    cy.findByRole("status").should("contain.text", "cmux rejected the update");
    cy.contains(".inbox-card", "Docs check finished").should("be.visible");
  });

  it("opens the linked session from a card", () => {
    fixtures([question]);
    visitInbox();
    cy.findByRole("button", { name: "Billing rewrite ›" }).click();
    cy.location("search").should("eq", "?workspace=workspace-billing");
    cy.wait("@replay").its("request.url").should("include", "/api/terminals/terminal-billing/replay");
    cy.contains(".detail-header strong", "Billing rewrite").should("be.visible");
    cy.get(".terminal-fallback").should("contain.text", "Billing agent is waiting");
  });

  it("opens a context document in the Markdown viewer and comes back", () => {
    fixtures([notification]);
    cy.intercept("GET", "**/api/repos/repo-docs/markdown*", (request) => {
      expect(request.query.file).to.equal("docs/REPORT.md");
      request.reply({ repo: { id: docsRepo.id, name: docsRepo.name, path: docsRepo.path }, path: "docs/REPORT.md", name: "REPORT.md", content: "# Docs report\n\nEverything **passed**.\n\n## Follow-ups\n\n- Tidy the glossary\n" });
    }).as("markdown");
    visitInbox();
    cy.findByRole("button", { name: "◇ REPORT.md" }).should("be.enabled").click();
    cy.location("search").should("eq", "?repo=repo-docs&file=docs%2FREPORT.md");
    cy.wait("@markdown");
    cy.contains(".document-header strong", "REPORT.md").should("be.visible");
    cy.contains(".document-header span", "Docs · docs/REPORT.md").should("be.visible");
    cy.findByRole("heading", { name: "Docs report" }).should("be.visible");
    cy.get(".markdown-body strong").should("have.text", "passed");
    cy.findByRole("button", { name: "Raw" }).click();
    cy.get(".document-raw").should("contain.text", "Everything **passed**.");
    cy.findByRole("button", { name: "Read" }).click();
    cy.findByRole("button", { name: "‹ Back" }).click();
    cy.location("search").should("eq", "?view=sessions");
    cy.findByRole("heading", { name: "Inbox", level: 1 }).should("be.visible");
    cy.contains(".inbox-card", "Docs check finished").should("be.visible");
  });

  it("explains an unreadable context document and offers a way back", () => {
    fixtures([notification]);
    cy.intercept("GET", "**/api/repos/repo-docs/markdown*", { statusCode: 404, body: { error: "That file is not in the repository" } }).as("missing");
    visitInbox();
    cy.findByRole("button", { name: "◇ REPORT.md" }).click();
    cy.wait("@missing");
    cy.contains("Could not open document").should("be.visible");
    cy.contains("That file is not in the repository").should("be.visible");
    cy.findByRole("button", { name: "Go back" }).click();
    cy.findByRole("heading", { name: "Inbox", level: 1 }).should("be.visible");
  });

  it("focuses one action from a notification link and returns to the full inbox after answering", () => {
    fixtures();
    visitInbox("?view=inbox&action=req-question");
    cy.findByRole("heading", { name: "Session action", level: 1 }).should("be.visible");
    cy.contains("NEEDS YOUR DECISION").should("be.visible");
    cy.get(".inbox-card").should("have.length", 1).and("have.class", "focused-action-card");
    cy.findByRole("button", { name: "SQLite" }).click();
    cy.wait("@reply").its("request.body").should("deep.equal", { kind: "question", selections: ["SQLite"] });
    cy.location("search").should("eq", "?view=inbox");
    cy.findByRole("heading", { name: "Inbox", level: 1 }).should("be.visible");
    cy.get(".inbox-card").should("have.length", 3);
  });

  it("tells you when a focused action was already resolved elsewhere", () => {
    fixtures([permission]);
    visitInbox("?view=inbox&action=req-gone");
    cy.contains("Action already resolved").should("be.visible");
    cy.contains("This request is no longer pending. It may have been handled on your Mac.").should("be.visible");
    cy.findByRole("button", { name: "Open inbox" }).click();
    cy.location("search").should("eq", "?view=inbox");
    cy.get(".inbox-card").should("have.length", 1);
  });
});

export {};
