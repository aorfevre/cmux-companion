# Repository development instructions

These instructions apply to the entire repository and to every coding agent.

## Local Cypress validation

When developing a new feature or changing user-visible behavior, add or update
the relevant Cypress end-to-end coverage and run it locally to confirm the
feature works through the UI. Treat this validation as part of completing the
feature, not as an optional follow-up.

Keep Cypress execution local-only. Do not add these tests to CI/CD unless the
project maintainers explicitly change that policy. Use the deterministic local
suite by default:

```bash
npm run test:e2e:local
```

Use the opt-in live-agent suite only when the behavior specifically requires
real cmux, xcodex, xclaude, GitHub pull-request, or merge integration. Follow
the safety requirements documented in `README.md` before running it.

If a feature cannot reasonably be exercised in Cypress, document why and
perform the closest available local validation instead.
