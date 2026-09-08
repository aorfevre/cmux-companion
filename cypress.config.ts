import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: process.env.CMUX_COMPANION_CYPRESS_BASE_URL || "http://localhost:3221",
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    video: false,
    screenshotOnRunFailure: true,
    setupNodeEvents(_on, config) {
      if (process.env.CI || process.env.CMUX_COMPANION_LOCAL_E2E !== "1") {
        throw new Error("Cypress is local-only. Run npm run test:e2e:local outside CI.");
      }
      return config;
    },
  },
});
