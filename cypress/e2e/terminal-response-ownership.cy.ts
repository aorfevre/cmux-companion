const workspaceId = "11111111-2222-4333-8444-555555555555";
const firstId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const secondId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

for (const staleFailure of [false, true]) it(`keeps terminal B when terminal A's delayed ${staleFailure ? "error" : "replay"} arrives`, () => {
  cy.intercept("/api/**", { statusCode: 501, body: { error: "Unexpected fixture API" } });
  cy.intercept("GET", "/api/auth/status", { paired: true });
  cy.intercept("GET", "/api/bootstrap", {
    connected: true, host: { mac_display_name: "Fixture Mac" }, refreshedAt: new Date().toISOString(), error: null,
    workspaces: [{ id: workspaceId, title: "Ownership fixture", terminals: [{ id: firstId, title: "Terminal A" }, { id: secondId, title: "Terminal B" }] }],
  });
  cy.intercept("GET", "/api/repos", { repos: [] });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  cy.intercept("GET", `/api/terminals/${firstId}/replay?*`, request => {
    requested = true;
    return held.then(() => request.reply(staleFailure ? { statusCode: 503, body: { error: "STALE A ERROR" } } : { body: { mode: "text", text: "STALE A OUTPUT" } }));
  }).as("oldReplay");
  cy.intercept("GET", `/api/terminals/${secondId}/replay?*`, { mode: "text", text: "CURRENT B OUTPUT" }).as("currentReplay");
  cy.visit(`/?workspace=${workspaceId}&surface=${firstId}&mode=sessions`);
  cy.wrap(null).should(() => expect(requested).to.equal(true));
  cy.findByRole("button", { name: "Session menu" }).click();
  cy.findByRole("button", { name: "2. Terminal B" }).click();
  cy.wait("@currentReplay");
  cy.contains("CURRENT B OUTPUT").should("be.visible");
  cy.then(() => release());
  cy.wait("@oldReplay");
  cy.contains("CURRENT B OUTPUT").should("be.visible");
  cy.contains("STALE A OUTPUT").should("not.exist");
  cy.contains("STALE A ERROR").should("not.exist");
  cy.findByRole("button", { name: "Queue message" }).should("not.exist");
  cy.findByRole("button", { name: "Prompt queue, 1 waiting" }).should("not.exist");
});
