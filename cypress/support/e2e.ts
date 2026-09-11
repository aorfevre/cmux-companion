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
