// Local apps: private Tailscale previews in every state, their actions, the
// focused-preview deep link, history clearing and the annotate-and-fix flow.
// Every API answer is a local fixture; nothing reaches Tailscale or cmux.
export {};

const now = "2026-09-08T12:00:00.000Z";
// A 4x4 opaque PNG: enough for the annotation canvas to load and re-encode it.
const capturePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGOQ07D5j4wZSBcAABzZGBGnaWryAAAAAElFTkSuQmCC";

type PreviewFixture = { id: string; workspaceId: string; repoId: string | null; name: string; targetPort: number; publicPort: number | null; sourceUrl: string; url: string | null; status: "detected" | "active" | "stopped"; updatedAt: string };

const workspace = { id: "ws-dashboard", title: "Dashboard session", current_directory: "/Users/test/Developers/projects/dashboard", terminals: [{ id: "term-main", title: "Main", is_focused: true }, { id: "term-side", title: "Side" }] };

function previews(): PreviewFixture[] {
  return [
    { id: "preview-active", workspaceId: workspace.id, repoId: "repoDashboard0001", name: "Dashboard", targetPort: 3000, publicPort: 8443, sourceUrl: "http://localhost:3000", url: "https://e2e-mac.tail1234.ts.net:8443/", status: "active", updatedAt: now },
    { id: "preview-detected", workspaceId: "ws-api", repoId: null, name: "API", targetPort: 4000, publicPort: null, sourceUrl: "http://localhost:4000", url: null, status: "detected", updatedAt: now },
    { id: "preview-stopped", workspaceId: "ws-docs", repoId: null, name: "Docs", targetPort: 5173, publicPort: null, sourceUrl: "http://localhost:5173", url: null, status: "stopped", updatedAt: now },
  ];
}

function scenario() {
  const state = { previews: previews() };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [workspace], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/previews", (request) => request.reply({ previews: state.previews, tailnetOnly: true, portRange: { start: 8443, end: 8499 } })).as("previews");
  return state;
}

function card(name: string) { return cy.contains(".preview-card", name); }

describe("local apps", () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    it(`summarises every preview state and filters testable from history at ${width}px`, () => {
      cy.viewport(width, height);
      scenario();
      cy.visit("/?view=apps");
      cy.wait("@previews");
      cy.findByRole("heading", { name: "Local apps" }).should("be.visible");
      cy.get(".apps-status-summary .ready").should("contain.text", "1").and("contain.text", "Ready to test");
      cy.get(".apps-status-summary .detected").should("contain.text", "1").and("contain.text", "Setup needed");
      cy.findByRole("tablist", { name: "App availability" }).within(() => {
        cy.findByRole("tab", { name: /^Testable/ }).should("have.attr", "aria-selected", "true").and("contain.text", "2");
        cy.findByRole("tab", { name: /^History/ }).should("contain.text", "1");
      });
      card("Dashboard").should("contain.text", "Ready to open").findByRole("link", { name: /Open app/ }).should("have.attr", "href", "https://e2e-mac.tail1234.ts.net:8443/");
      card("API").should("contain.text", "Running · setup needed").findByRole("button", { name: "Create private link" }).should("be.enabled");
      cy.contains(".preview-card", "Docs").should("not.exist");
      cy.findByRole("button", { name: "Clear history" }).should("not.exist");
      cy.findByRole("tab", { name: /^History/ }).click();
      card("Docs").should("contain.text", "Offline").and("contain.text", "cannot be tested");
      cy.contains(".preview-card", "Dashboard").should("not.exist");
      cy.findByRole("button", { name: "Clear history" }).should("be.visible");
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  it("enables a detected app, then stops and restarts the active link with one request each", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("POST", "**/api/previews/preview-detected/enable", (request) => {
      const preview = state.previews.find((item) => item.id === "preview-detected")!;
      Object.assign(preview, { status: "active", publicPort: 8444, url: "https://e2e-mac.tail1234.ts.net:8444/" });
      request.reply({ ...preview });
    }).as("enable");
    cy.intercept("POST", "**/api/previews/preview-active/stop", (request) => {
      const preview = state.previews.find((item) => item.id === "preview-active")!;
      Object.assign(preview, { status: "detected", publicPort: null, url: null });
      request.reply({ ...preview });
    }).as("stop");
    cy.intercept("POST", "**/api/previews/preview-active/restart", (request) => {
      const preview = state.previews.find((item) => item.id === "preview-active")!;
      request.reply({ ...preview });
    }).as("restart");
    cy.visit("/?view=apps");
    cy.wait("@previews");
    card("API").findByRole("button", { name: "Create private link" }).click();
    cy.wait("@enable").its("request.body").should("deep.equal", {});
    cy.wait("@previews");
    cy.get(".toast").should("contain.text", "Private preview is ready");
    card("API").findByRole("link", { name: /Open app/ }).should("have.attr", "href", "https://e2e-mac.tail1234.ts.net:8444/");
    cy.get(".apps-status-summary .ready").should("contain.text", "2");
    card("Dashboard").within(() => { cy.contains("summary", "More").click(); cy.findByRole("button", { name: "Restart link" }).click(); });
    cy.wait("@restart");
    cy.get(".toast").should("contain.text", "Private preview link restarted");
    card("Dashboard").within(() => { cy.findByRole("button", { name: "Stop link" }).click(); });
    cy.wait("@stop");
    cy.wait("@previews");
    cy.get(".toast").should("contain.text", "Private preview stopped");
    card("Dashboard").should("contain.text", "Running · setup needed").findByRole("button", { name: "Create private link" }).should("be.visible");
  });

  it("removes a detected app from the list and reports an action that the companion rejects", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("DELETE", "**/api/previews/preview-detected", (request) => {
      state.previews = state.previews.filter((item) => item.id !== "preview-detected");
      request.reply({ removed: true });
    }).as("remove");
    cy.intercept("POST", "**/api/previews/preview-active/restart", { statusCode: 502, body: { error: "tailscale serve is not running" } }).as("restart");
    cy.visit("/?view=apps");
    cy.wait("@previews");
    card("Dashboard").within(() => { cy.contains("summary", "More").click(); cy.findByRole("button", { name: "Restart link" }).click(); });
    cy.wait("@restart");
    cy.get(".toast").should("contain.text", "tailscale serve is not running");
    card("Dashboard").findByRole("link", { name: /Open app/ }).should("be.visible");
    card("API").within(() => { cy.contains("summary", "More").click(); cy.findByRole("button", { name: "Remove from list" }).click(); });
    cy.wait("@remove");
    cy.wait("@previews");
    cy.get(".toast").should("contain.text", "Preview removed");
    cy.contains(".preview-card", "API").should("not.exist");
    cy.findByRole("tab", { name: /^Testable/ }).should("contain.text", "1");
  });

  it("focuses a stopped preview from its link by switching to history and highlighting the card", () => {
    cy.viewport(390, 844);
    scenario();
    cy.visit("/?view=apps&preview=preview-stopped");
    cy.wait("@previews");
    cy.findByRole("tab", { name: /^History/ }).should("have.attr", "aria-selected", "true");
    cy.get(".preview-card.focused").should("have.length", 1).and("contain.text", "Docs");
    cy.visit("/?view=apps&preview=preview-active");
    cy.wait("@previews");
    cy.findByRole("tab", { name: /^Testable/ }).should("have.attr", "aria-selected", "true");
    cy.get(".preview-card.focused").should("have.length", 1).and("contain.text", "Dashboard");
  });

  it("asks before clearing history, deletes every stopped app once confirmed and reports a partial failure", () => {
    cy.viewport(390, 844);
    const state = scenario();
    state.previews.push({ id: "preview-stopped-two", workspaceId: "ws-blog", repoId: null, name: "Blog", targetPort: 8080, publicPort: null, sourceUrl: "http://localhost:8080", url: null, status: "stopped", updatedAt: now });
    let confirmAnswer = false;
    let expectedQuestion = "Remove 2 stopped apps from history?";
    let failSecond = true;
    cy.on("window:confirm", (message) => { expect(message).to.equal(expectedQuestion); return confirmAnswer; });
    cy.intercept("DELETE", "**/api/previews/preview-stopped", (request) => { state.previews = state.previews.filter((item) => item.id !== "preview-stopped"); request.reply({ removed: true }); }).as("removeDocs");
    cy.intercept("DELETE", "**/api/previews/preview-stopped-two", (request) => {
      if (failSecond) { request.reply({ statusCode: 500, body: { error: "Preview store is locked" } }); return; }
      state.previews = state.previews.filter((item) => item.id !== "preview-stopped-two"); request.reply({ removed: true });
    }).as("removeBlog");
    cy.visit("/?view=apps");
    cy.wait("@previews");
    cy.findByRole("tab", { name: /^History/ }).click();
    cy.findByRole("button", { name: "Clear history" }).click();
    cy.get("@removeDocs.all").should("have.length", 0);
    card("Docs").should("be.visible");
    cy.then(() => { confirmAnswer = true; });
    cy.findByRole("button", { name: "Clear history" }).click();
    cy.wait("@removeDocs");
    cy.wait("@removeBlog");
    cy.get(".toast").should("contain.text", "Could not clear all stopped apps");
    card("Blog").should("be.visible");
    // The list is not reloaded after a failed pass, so Docs is still shown
    // until the next refresh; only then does the question count one app.
    card("Docs").should("be.visible");
    cy.findByRole("button", { name: "Refresh" }).click();
    cy.wait("@previews");
    cy.contains(".preview-card", "Docs").should("not.exist");
    cy.then(() => { failSecond = false; expectedQuestion = "Remove 1 stopped app from history?"; });
    cy.findByRole("button", { name: "Clear history" }).click();
    cy.wait("@removeBlog");
    cy.wait("@previews");
    cy.get(".toast").should("contain.text", "Stopped app history cleared");
    cy.findByText("No stopped apps").should("be.visible");
    cy.findByRole("button", { name: "Clear history" }).should("not.exist");
  });

  it("reports an unavailable preview service and recovers on refresh", () => {
    cy.viewport(390, 844);
    scenario();
    let failing = true;
    cy.intercept("GET", "**/api/previews", (request) => {
      if (failing) request.reply({ statusCode: 503, body: { error: "Private previews are unavailable" } });
      else request.reply({ previews: previews(), tailnetOnly: true, portRange: { start: 8443, end: 8499 } });
    }).as("previews");
    cy.visit("/?view=apps");
    cy.wait("@previews");
    cy.get(".apps-warning").should("contain.text", "Private previews are unavailable");
    cy.findByText("No local apps detected").should("not.exist");
    cy.then(() => { failing = false; });
    cy.findByRole("button", { name: "Refresh" }).click();
    cy.wait("@previews");
    cy.get(".apps-warning").should("not.exist");
    card("Dashboard").should("be.visible");
  });

  it("captures the app, sends the annotated fix to the focused terminal and queues it when asked", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("POST", "**/api/previews/preview-active/capture", { statusCode: 201, body: { dataUrl: capturePng, viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000" } }).as("capture");
    cy.intercept("POST", "**/api/attachments/images", (request) => {
      expect(request.body.name).to.equal("fix-dashboard.png");
      expect(request.body.dataUrl).to.match(/^data:image\/png;base64,/);
      request.reply({ statusCode: 201, body: { image: { path: "/attachments/fix-dashboard.png", name: "fix-dashboard.png", bytes: 1024 } } });
    }).as("attachment");
    cy.intercept("POST", "**/api/terminals/term-main/input", { ok: true }).as("input");
    cy.intercept("POST", "**/api/prompt-queue", { statusCode: 201, body: { item: { id: "queue-1" } } }).as("queue");
    cy.visit("/?view=apps");
    cy.wait("@previews");
    card("Dashboard").findByRole("button", { name: "◎ Fix this" }).click();
    cy.wait("@capture").its("request.body").should("deep.equal", { width: 390, height: 844 });
    cy.findByRole("dialog", { name: "Annotate preview" }).within(() => {
      cy.findByRole("img", { name: "Dashboard mobile preview" }).should("have.attr", "src", capturePng);
      cy.findByRole("button", { name: "Undo" }).should("be.disabled");
      cy.findByLabelText("What should change?").type("The header overlaps the menu");
      cy.findByRole("button", { name: "Send now" }).click();
    });
    cy.wait("@attachment");
    cy.wait("@input").its("request.body").should((body: { text: string; enter: boolean }) => {
      expect(body.enter).to.equal(true);
      expect(body.text).to.include("Feedback: The header overlaps the menu");
      expect(body.text).to.include("Preview: http://localhost:3000");
      expect(body.text).to.include("Mobile viewport: 390×844");
      expect(body.text).to.include("- /attachments/fix-dashboard.png");
    });
    cy.findByRole("dialog", { name: "Annotate preview" }).should("not.exist");
    cy.get(".toast").should("contain.text", "Visual fix sent to the agent");
    cy.get("@queue.all").should("have.length", 0);
    card("Dashboard").findByRole("button", { name: "◎ Fix this" }).click();
    cy.wait("@capture");
    cy.findByRole("dialog", { name: "Annotate preview" }).findByRole("button", { name: "Queue fix" }).click();
    cy.wait("@attachment");
    cy.wait("@queue").its("request.body").should((body: { workspaceId: string; surfaceId: string; text: string }) => {
      expect(body.workspaceId).to.equal("ws-dashboard");
      expect(body.surfaceId).to.equal("term-main");
      expect(body.text).to.include("Inspect the marked area and correct the visual or interaction problem.");
    });
    cy.get(".toast").should("contain.text", "Visual fix queued for the agent");
    cy.get("@input.all").should("have.length", 1);
  });

  it("keeps the annotation open with its note when the fix cannot be delivered", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("POST", "**/api/previews/preview-detected/capture", { statusCode: 500, body: { error: "Preview capture needs Google Chrome" } }).as("captureFails");
    cy.intercept("POST", "**/api/previews/preview-active/capture", { statusCode: 201, body: { dataUrl: capturePng, viewport: { width: 390, height: 844 }, sourceUrl: "http://localhost:3000" } }).as("capture");
    cy.intercept("POST", "**/api/attachments/images", { statusCode: 413, body: { error: "The annotated image is too large" } }).as("attachment");
    cy.visit("/?view=apps");
    cy.wait("@previews");
    card("API").findByRole("button", { name: "◎ Fix this" }).click();
    cy.wait("@captureFails");
    cy.get(".toast").should("contain.text", "Preview capture needs Google Chrome");
    cy.findByRole("dialog", { name: "Annotate preview" }).should("not.exist");
    card("Dashboard").findByRole("button", { name: "◎ Fix this" }).click();
    cy.wait("@capture");
    cy.findByRole("dialog", { name: "Annotate preview" }).within(() => {
      cy.findByLabelText("What should change?").type("Contrast is too low");
      cy.findByRole("button", { name: "Send now" }).click();
    });
    cy.wait("@attachment");
    cy.get(".toast").should("contain.text", "The annotated image is too large");
    cy.findByRole("dialog", { name: "Annotate preview" }).findByLabelText("What should change?").should("have.value", "Contrast is too low");
    cy.findByRole("dialog", { name: "Annotate preview" }).findByRole("button", { name: "Cancel" }).click();
    cy.findByRole("dialog", { name: "Annotate preview" }).should("not.exist");
  });

  it("opens the app's cmux session when it is still open and says so when it is not", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/terminals/*/replay*", { mode: "text", text: "Dashboard dev server ready" });
    cy.intercept("POST", "**/api/terminals/*/viewport", {});
    cy.intercept("GET", "**/api/goal-sessions/workspace/*", { plan: null });
    cy.visit("/?view=apps");
    cy.wait("@previews");
    card("API").findByRole("button", { name: "Open session" }).click();
    cy.get(".toast").should("contain.text", "That cmux session is no longer open");
    card("Dashboard").findByRole("button", { name: "Open session" }).click();
    cy.location("search").should("eq", "?workspace=ws-dashboard");
    cy.contains(".detail-header", "Dashboard session").should("be.visible");
    cy.contains("Dashboard dev server ready").should("be.visible");
  });
});
