# Codecov coverage reporting

The Verify workflow already generates backend `coverage/backend.lcov` and UI
`coverage/ui/lcov.info` reports. When Codecov is enabled, it saves both in a
short-lived artifact and uploads them together from a separate job. That job
installs no npm dependencies and runs no project scripts. Its Actions, including
the Codecov uploader, are pinned to upstream commits. Upload discovery is disabled
so only the two reports are sent; uploader integrity verification remains enabled.

The existing backend and UI 90% line-coverage gates remain authoritative. Codecov
project and patch statuses initially provide informational feedback, with a single
PR comment when coverage changes and both head/base reports exist. Coverage scope
comes from the checked-in Node/Vitest configuration; no source exclusions or
thresholds were weakened. Codecov measures covered lines, not test quality.

## Activation

1. Enable `aorfevre/cmux-companion` in Codecov and install/authorize its GitHub App
   for this repository so it can show checks and PR comments. Confirm the account
   plan supports the repository's current private visibility.
2. Enable OIDC uploads for the repository if required by its Codecov settings.
   No `CODECOV_TOKEN` is stored or passed by this workflow.
3. Set GitHub Actions repository variable `CODECOV_ENABLED` to `true` after setup.
   Until then, uploads and coverage artifacts are skipped; tests still run.
4. Run Verify on `main` through the next main push to establish the baseline,
   then confirm both reports and a subsequent PR comparison in Codecov.

When enabled, main pushes run full verification instead of using the verified-tree
shortcut. This costs another test run but produces a real baseline for the main
commit; the pipeline does not relabel a PR report as a main report. All verification
evidence and installed-updater eligibility checks otherwise remain unchanged.

Same-repository trusted PRs and main pushes authenticate with GitHub OIDC in the
upload job; the test job has no OIDC permission. Fork and Dependabot PRs on public
repositories use Codecov's tokenless upload support, which must be enabled in the
Codecov organization settings. Private fork/Dependabot uploads are deliberately
skipped because their token restrictions differ; their complete tests and local
coverage gates still run. A skipped upload is not a reported Codecov result.
No PR-target workflow, long-lived token or privileged rerun of PR code is used.

Upload errors fail the separate Codecov job once enabled; test success is still
reported by Verify. Do not require Codecov statuses for all PRs until real main,
normal PR and Dependabot/fork upload paths have been confirmed. This integration
does not implement automatic admission of failing PRs into cmux repair jobs.
