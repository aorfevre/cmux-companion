# CodeQL security scanning

The `CodeQL` workflow scans JavaScript and TypeScript with the `security-extended`
query suite on pull requests to `main`, pushes to `main`, every Tuesday, and manual
workflow dispatch. It includes backend `.mjs`, frontend TS/TSX, worker, scripts,
installer and test source; only dependencies and generated output are excluded.
It complements CodeRabbit review and the separate npm dependency audit.

Analysis uses `build-mode: none`: it does not install npm packages, execute package
scripts or start Companion. Actions are pinned to upstream commits and maintained
by the existing GitHub Actions Dependabot configuration. The job grants only
contents/actions read and security-events write, uses the normal `pull_request`
event, and does not use personal credentials or a privileged PR-target workflow.
GitHub supports CodeQL result uploads from fork PRs through that event.

## Activation

At setup time the repository is private and GitHub's code-scanning API returns
HTTP 403 (code scanning not enabled). The workflow therefore skips analysis until:

- The repository is public, where CodeQL is available free; or
- GitHub Code Security is licensed and enabled for this private repository, and
  the repository Actions variable `CODEQL_ENABLED` is set to `true`.

Setting the variable does not grant a license or enable the GitHub service. Leave
it unset until eligibility is confirmed. Repository publication still requires the
separate privacy cleanup; adding this workflow does not change visibility.

Use **Advanced setup** with this checked-in workflow, not a simultaneous Default
setup. After merging and enabling eligibility, run **Actions → CodeQL → Run
workflow**, then confirm analysis and SARIF upload succeeded in **Security → Code
scanning**. Weekly and manual runs use the default-branch workflow.

A skipped analysis is not evidence that the repository is secure. Once a real
scan succeeds, configure a code-scanning merge protection rule for CodeQL alerts
and add the analysis check to branch protection as appropriate. CI success alone
means analysis ran successfully; findings must be assessed in Security. Existing
auto-merge should not be considered to enforce CodeQL alert thresholds until that
GitHub protection is active. Protection availability is a separate GitHub plan
constraint. No scan, license change, merge or deployment is implied by configuration.

## Shared PR pipeline

Human, goal-generated and Dependabot PRs use the same pipeline. Goal PRs start as
drafts and become ready only after the existing completion and publication gates.
For a ready PR, GitHub CI, CodeQL and CodeRabbit run independently. Before merge,
require successful current-head `macos`, `verify`, and `Analyze JavaScript and
TypeScript` checks, an actual current-head CodeRabbit approval, resolved review
conversations, and GitHub code-scanning protection against high/critical alerts.
A successful or skipped CodeRabbit status is not an approval; a skipped CodeQL job
is not a scan. Do not activate automatic merging until these protections are active.

A failing check or requested change leaves the PR open. A cmux agent can repair
its branch, push the fix, and send that new head through the complete pipeline
again. This CodeQL change does not implement an unattended GitHub-failure-to-cmux
handoff: automatically admitting repair work, bounding attempts, assigning an
owner, and stopping for human intervention remain separate orchestration work.
Dependabot only creates dependency PRs; it does not bypass these gates.
