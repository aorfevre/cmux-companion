# Review and merge gates

## Outcome
Every goal pull request is created as a draft. Companion promotes it only after the existing exact-head completion, independent review, verification and human publication approval gates. CodeRabbit reviews ready PRs. Repository auto-merge queues only reviewed, passing, non-draft PRs behind GitHub branch protection.

## User journey
1. A goal completes implementation, integration, independent review and all approved checks; all workers are stopped.
2. The user approves publication of that exact commit. Companion creates a draft, observes its identity and head, then marks it ready for review. A crash or uncertain request leaves the draft for reconciliation; it never creates a second PR.
3. CodeRabbit automatically reviews the ready PR and later commits. It summarizes changes and approves only after its comments are resolved and checks pass.
4. Automation enables GitHub native auto-merge only when main protection requires current CI, an approval and resolved conversations. Drafts, missing evidence, stale reviews, failing checks and unavailable protection are ineligible.

## Non-goals
No early remote publication before existing human approval. No bypass of GitHub protection, paid-account restrictions, provider permissions or existing goal evidence. No automatic deployment or repository visibility change. No automatic acceptance of CodeRabbit suggestions.

## Acceptance criteria
- GitHub creation payload sets draft=true. Verification: CLI boundary test.
- Promotion verifies the same goal marker, repository, branches and head; aborted or moved publication does not promote. Verification: publication lifecycle tests.
- Lost creation/promotion responses reconcile without duplicate PR creation or premature delivered status. Verification: publication recovery tests.
- CodeRabbit skips drafts, reviews incremental commits, may request changes and emits summaries using repository/path guidance. Verification: configuration schema validation.
- Auto-merge uses only trusted default-branch automation and requires protected main, successful macos/verify evidence, latest-head CodeRabbit approval and no unresolved threads. Verification: eligibility tests.

## Success measure
All publication recovery cases retain one PR, and every automated merge remains subject to GitHub's protected-branch checks and review requirements.
