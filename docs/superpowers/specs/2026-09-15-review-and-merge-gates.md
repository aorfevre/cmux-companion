# Review and merge gates

Amended 2026-10-14 following the user's instruction to remove CodeRabbit from
the PR process. This removes the named provider's review, approval and status
requirements; existing CI, human review and GitHub protection remain.

## Outcome
Every goal pull request is created as a draft. Companion promotes it only after the existing exact-head completion, independent review, verification and human publication approval gates. Repository auto-merge queues only human-reviewed, passing, non-draft PRs behind GitHub branch protection, without a CodeRabbit dependency.

## User journey
1. A goal completes implementation, integration, independent review and all approved checks; all workers are stopped.
2. The user approves publication of that exact commit. Companion creates a draft, observes its identity and head, then marks it ready for review. A crash or uncertain request leaves the draft for reconciliation; it never creates a second PR.
3. A human reviewer approves the current PR commit. CodeRabbit automatic reviews, status reporting and review-request comments are disabled.
4. Automation enables GitHub native auto-merge only when main protection requires current CI, an approval and resolved conversations. Drafts, missing evidence, stale reviews, failing checks and unavailable protection are ineligible.

## Non-goals
No early remote publication before existing human approval. No bypass of GitHub protection, provider permissions or existing goal evidence. No automatic deployment or repository visibility change. No account-wide app uninstall, deletion of historical reviews or changes to unrelated repository integrations.

## Acceptance criteria
- GitHub creation payload sets draft=true. Verification: CLI boundary test.
- Promotion verifies the same goal marker, repository, branches and head; aborted or moved publication does not promote. Verification: publication lifecycle tests.
- Lost creation/promotion responses reconcile without duplicate PR creation or premature delivered status. Verification: publication recovery tests.
- CodeRabbit automatic reviews and status reporting are disabled and automation never requests its review. Verification: workflow/configuration regression checks.
- Auto-merge uses only trusted default-branch automation and requires protected main, successful macos/verify evidence, a current-head human approval and no unresolved threads; no CodeRabbit status or approval is required. Verification: eligibility tests.

## Success measure
All publication recovery cases retain one PR, and every automated merge remains subject to GitHub's protected-branch checks and review requirements.
