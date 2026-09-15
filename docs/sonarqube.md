# SonarQube Cloud

Project: https://sonarcloud.io/summary/overall?id=aorfevre_cmux-companion&branch=main

SonarQube uses a separate Verify job after the existing tests pass. It analyzes
application, server, worker, updater and script source, classifies test directories
separately, and imports the backend/UI LCOV artifact from that test run. The scanner
job installs no npm dependencies and runs no project scripts. Pinned Actions check
out full Git history and download only the current run's coverage artifact. The
Sonar token is supplied only to configuration validation and the official scanner.

## Account activation

The project is not anonymously readable (the API returned 404), so neither its
organization key, visibility nor plan capabilities have been verified. A free
account alone does not establish which private-project or PR-analysis features
are available. The project URL identifies its key and EU host, not its organization.

1. In the existing project, choose CI-based GitHub Actions analysis. Disable
   Automatic Analysis before activating CI analysis so the two modes do not conflict.
2. Confirm the organization key and store it as Actions variable
   `SONAR_ORGANIZATION` on `aorfevre/cmux-companion`.
3. Create a token with analysis permission for this project and save it as the
   repository Actions secret `SONAR_TOKEN`. Never put it in source, logs or chat.
4. Set `SONAR_ENABLED=true` after the project and token are configured. A subsequent
   main push runs analysis. With SonarQube enabled, main runs full
   verification to generate genuine current-commit coverage instead of reusing a
   previous PR's verification receipt.
5. Confirm the main scan imports both reports, establishes a baseline, and passes
   the project's quality gate. Set `SONAR_PR_ANALYSIS_ENABLED=true` only if the
   account supports PR analysis, then verify a same-repository PR scan and decoration.

The scanner waits up to five minutes for the quality gate. Failed analysis, failed
quality gates and missing configuration fail the Sonar job. The existing local 90%
backend/UI line-coverage gates are unchanged. Sonar's analysis scope includes more
source than those coverage gates, so its percentage need not match theirs. Assess
its quality gate on new code before making it mandatory; do not weaken existing
local checks to match an external report.

Fork and Dependabot scans are skipped because their workflows do not receive this
secret. Their tests, local coverage gates, CodeRabbit and eligible CodeQL scans
continue independently. No privileged PR-target workflow or untrusted-code rerun
is used to work around this restriction. Skipped Sonar jobs are not passed scans;
do not claim this implements a universal Sonar merge gate for every PR author.

No Sonar organization, account plan, visibility, Automatic Analysis setting or
secret is modified by this code change. Until activation is confirmed, uploads,
quality gates and PR decoration remain unverified. A failed-PR-to-cmux repair loop
is separate orchestration work.
