# Bundled Companion updater

The updater is part of the Companion source and uses its root npm manifest,
lockfile, Node version and test commands. It runs independently of the application
so it can recover a failed startup. See [installation and recovery](../docs/updates.md).
Original source attribution is recorded in [PROVENANCE.md](PROVENANCE.md); its
[MIT notice](LICENSE) is retained.

Discovery checks trusted GitHub `origin/main` and successful exact-commit runs of
`.github/workflows/verify.yml`. Checking never grants installation permission.
Settings offers per-commit confirmation and an installation-wide Automatic
installation switch that defaults off. Automatic requests use the same maintenance,
CI, build, backup and health protocol as manual requests.

`src/control.mjs` owns private SQLite approval, preference and maintenance state.
`src/transaction.mjs` owns the restartable activation protocol.
`src/engine.mjs` implements Git, build, launchd and health effects.
`scripts/bootstrap.mjs` retains the prior engine during an unsettled transaction.
`src/build-process.mjs` uses Companion's independent native watchdog for npm builds.
`src/data-recovery.mjs` validates unchanged schema code and consistent SQLite backups.

Tests in `tests/` preserve applicable upstream Git, health and retention behavior;
`../tests/updater-*.test.mjs` add packaging, controls, eligibility, API and recovery.
The retired two-repository polling and self-handoff tests have been replaced by
single-repository approval/transaction tests. No test invokes the installed service.

Normal verification from the root:

```sh
npm run verify
npm run test:coverage
npm run test:ui:coverage
CMUX_COMPANION_CYPRESS_PORT=3322 npm run test:e2e:local -- --settings --spec cypress/e2e/updates.cy.ts
```
