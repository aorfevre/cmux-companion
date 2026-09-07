# Local frontend comparison

This experiment renders the same React application through a plain Vite SPA.
It is isolated from the deployed vinext/Sites build, has no backend proxy and
cannot control the installed Companion by itself. It preserves the app's
metadata, PWA assets and styles for comparison.

From the repository root:

```bash
node scripts/compare-frontend-stacks.mjs
node scripts/run-local-cypress.mjs --spa-experiment
```

The comparison rebuilds the ordinary frontend and writes SPA assets to ignored
`outputs/local-spa`, stamps both service workers, and starts/stops each frontend
on its own ephemeral loopback port to measure HTTP readiness. It does not start
the Mac bridge. The Cypress command uses port 3221 and the same local API fixtures
as the ordinary frontend suite; it refuses CI. Do not run the two Cypress variants
simultaneously.

This is an architectural experiment, not a deployment path. Retaining vinext in
production until the installer/updater contract has equivalent validation is an
explicit outcome, even when the SPA's local build and UI tests are faster.
See [implementation evidence](../../docs/reviews/implementation-status.md) for
measurements, test results and the decision.
