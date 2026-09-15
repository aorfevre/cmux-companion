# Notification settings and background push implementation

Implements the human-reviewed notification amendment in
[the Mission Control spec](../specs/2026-09-15-mission-control-redesign.md#notification-settings-and-background-push--approved).
Owner: Codex, accountable for integration, checks and disposable-resource cleanup.

1. Add a private, additive notification SQLite store (schema 1) outside release
   paths: VAPID identity, subscription capabilities/preferences, enrollment cursor,
   idempotent outbox, leases, retry/expiry and bounded metadata retention. Keep
   notification persistence independent of core settings/workflow backup restoration;
   older versions leave it inert, and renewed delivery rechecks current state.
2. Implement Web Push encryption with the maintained web-push package and an
   explicitly restricted HTTPS transport: supported vendor hosts/paths, public
   connection addresses, no redirects, bounded requests and sanitized errors.
3. Add authenticated/origin-checked notification APIs and connect journal consumers
   plus one updater observer to both production compositions. Stop notification
   work before closing its store; delivery cannot own scheduler authority.
4. Add browser preferences, Settings → Notifications, subscription lifecycle/test/
   revocation controls, logout cleanup, and service-worker display/click handling.
   Retain update banners independently and explain device/platform limitations.
5. Add backend security/delivery/restart tests, UI lifecycle tests, service-worker
   tests and relevant disposable Cypress settings coverage. Document setup,
   private state, rollback, supported providers and manual device verification.
6. Run focused checks, npm run verify, npm run test:mac and relevant Chrome Cypress.
   Record passed/failed/unverified paths in PR #151. Actual desktop/iOS background
   delivery requires enrolled devices and stays unverified until performed.

No live provider/device enrollment, merge or release is implied by implementation.
