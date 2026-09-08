const entry = (id: string, eligible: boolean) => ({ id, path: `/Users/fixture/Developers/karven/repository-${id}`, repository: "Fixture repository", branch: `feature/${id}`, classification: "development", eligible, reasons: [eligible ? "Exact goal PR merged" : "An open session or process uses this worktree"], estimatedBytes: eligible ? 1024 ** 3 : null });
const preview = { previewId: "preview-one", generatedAt: "2026-09-08T08:00:00Z", roots: ["/Users/fixture/Developers/karven"], repositoryCount: 1, entries: [entry("finished", true), entry("active", false)], errors: [], summary: { candidates: 1, protected: 1, estimatedBytes: 1024 ** 3 } };
for (const width of [390, 1280]) describe(`worktree overview at ${width}px`, () => {
  beforeEach(() => {
    cy.viewport(width, 900);
    cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing fixture" } });
    cy.intercept("GET", "**/api/auth/status", { paired: true });
    cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "Fixture Mac" }, workspaces: [] });
    cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
    cy.intercept("GET", "**/api/repos", { repos: [] });
  });
  it("opens a bookmarkable screen, reviews safe collection, and refreshes counts", () => {
    let collected = false;
    cy.intercept("POST", "**/api/worktree-cleanup/preview", (request) => request.reply(collected ? { ...preview, previewId: "preview-two", entries: [entry("active", false)], summary: { candidates: 0, protected: 1, estimatedBytes: 0 } } : preview)).as("scan");
    cy.intercept("POST", "**/api/worktree-cleanup/run", (request) => {
      expect(request.body).to.deep.equal({ previewId: "preview-one", ids: ["finished"], prune: [] });
      collected = true; request.reply({ results: [{ path: preview.entries[0].path, outcome: "removed" }] });
    }).as("collect");
    cy.visit("/?view=worktrees");
    cy.wait("@scan");
    cy.findByRole("heading", { name: /^Worktrees$/ }).should("be.visible");
    cy.findByRole("navigation", { name: "Main navigation" }).findByRole("button", { name: "Worktrees" }).should("have.class", "active").click();
    cy.location("search").should("equal", "?view=worktrees");
    cy.findByText("2 of 2 checkouts shown").should("be.visible");
    cy.contains("An open session or process uses this worktree").should("be.visible");
    cy.screenshot(`worktree-overview-${width}`, { capture: "fullPage" });
    cy.get("@collect.all").should("have.length", 0);
    cy.findByRole("button", { name: "Run garbage collection (1)" }).click();
    cy.contains("Search and filters do not limit collection").should("be.visible");
    cy.findByRole("button", { name: "Confirm garbage collection" }).click();
    cy.wait("@collect"); cy.wait("@scan");
    cy.findByText("1 removed · 0 skipped · 0 failed").should("be.visible");
    cy.findByRole("button", { name: "Run garbage collection (0)" }).should("be.disabled");
    cy.findByText("1 of 1 checkouts shown").should("be.visible");
    cy.get("@collect.all").should("have.length", 1);
    cy.reload(); cy.wait("@scan");
    cy.findByText("1 of 1 checkouts shown").should("be.visible");
  });
});
