# Contributing

Start with the [README](README.md) and shared [AGENTS.md](AGENTS.md) engineering
guide. These instructions apply to human and agent-assisted contributions.

Select Node with `nvm install && nvm use`, then run `npm ci`. Keep npm and the
checked-in lockfile. Use `npm run orchestration:dev -- --port 3211` for a disposable,
account-free service, and follow the printed paths plus the
[development guide](docs/orchestration-development.md) to connect the frontend.
Use free ports and stop only your own processes.

Before submitting a focused PR targeting `main`, run `npm run verify`. It enforces
90% backend and UI line coverage, lint, types, and the build. On macOS also run
`npm run test:mac`; CI requires this platform check before full verification can
succeed. For visible behavior run the relevant local Cypress journey. Describe
the problem, resulting behavior, test evidence, and remaining gaps in the PR.

For real disposable settings and updater journeys:

```sh
CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local -- --settings
```

Each selected spec runs with a fresh service, database, and worker lifecycle.
Comma-separated `--spec` selections preserve their order. Interactive `--open`
settings sessions allow one spec per invocation; select `updates.cy.ts` explicitly
to inspect that journey. See the [local checks](README.md#local-end-to-end-checks).

Do not use installed services or live accounts for routine verification. Native
providers, live cmux/Tailscale, installation, migration, and real GitHub publication
require explicit scope and the documented opt-ins. A source PR is not permission
to merge, deploy, or change someone else's installation.

Product decisions belong in a design spec; implementation plans must follow it.
See AGENTS.md for the spec review contract. Bug fixes should preserve the existing
security and ownership invariants and include regressions for the failure.

This is a macOS application; Linux CI supports development, not a supported Linux
installation. Current native CLI contracts and unsupported paths are listed in
the README. Ask feature/support questions through ordinary issues, but report
vulnerabilities using [SECURITY.md](SECURITY.md).
