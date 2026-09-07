import "@testing-library/cypress/add-commands";

// The production worker caches unversioned Vite modules across local runs.
// Clear only this fixture origin and prevent registration so every spec tests
// the current checkout, including when switching between Electron and Chrome.
beforeEach(() => {
  const origin = new URL(String(Cypress.config("baseUrl"))).origin;
  cy.then(() => Cypress.automation("remote:debugger:protocol", {
    command: "Storage.clearDataForOrigin",
    params: { origin, storageTypes: "service_workers,cache_storage" },
  }));
  cy.intercept("GET", "**/sw.js", { statusCode: 404, body: "" });
});

// Reveal secondary controls through the same disclosure a person uses.
Cypress.Commands.add("openBoardTools", () => {
  cy.contains("summary", "Board tools").then(($summary) => {
    if (!$summary.parent().prop("open")) cy.wrap($summary).click();
  });
});

declare global {
  // Cypress custom commands augment its global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      openBoardTools(): Chainable<void>;
    }
  }
}
