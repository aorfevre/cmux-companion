# Notification settings and background push delivery

Implements the [approved contract](../superpowers/specs/2026-09-15-mission-control-redesign.md#notification-settings-and-background-push--approved)
and its [implementation plan](../superpowers/plans/2026-09-15-background-push.md).
The user reviewed spec commit `075ed6c` and approved both designs before the plan
commit. Implementation is reviewed through PR #151, targeting main.

## Resulting behavior

Settings → Notifications independently controls in-app update banners and
opt-in per-device Web Push. Users can enroll, select attention/completion/update
classes, keep discreet copy (default), test delivery, disable this subscription
or confirm revocation of every subscription on the Mac. Permission, registration,
provider acceptance and errors remain distinct. Unpairing attempts push cleanup
without preventing logout when cleanup fails.

The service sends encrypted push using a persistent private VAPID identity and
a separate schema-1 SQLite store. A committed journal consumer and one updater
observer enqueue bounded, idempotent delivery records. Leases/retries, enrollment
baselines, milestone deduplication, expiry, latest-attention coalescing and current
state checks prevent routine replay/stale delivery. A retried startup failure can
notify again without repeatedly notifying for one failed attempt.

Outbound transport only permits documented Google/Mozilla/Apple push endpoints,
valid public connection addresses, valid subscription curve/auth keys, no
redirects/pooling and a 15-second deadline. Subscription management is paired and
same-origin checked, with per-subscription capabilities, limits and sanitized
responses. No workflow authority or notification action can approve/install/run
anything. Notification keys, endpoints and bodies never enter public API responses
or logs; request logger redaction includes the management-proof header.

An unsupported notification schema or bad contact configuration exposes an
unavailable setup state while the core service can start. Restart and core
rollback leave the independent notification store/identity intact. A replaced
journal or pairing-token rotation revokes old subscriptions. Notifications do not
participate in agent admission or updater installation approval.

The service worker displays push with no open page and validates click targets
before focusing/opening same-origin content. The [operator/device guide](../notifications.md)
explains iOS Home Screen requirements, vendor metadata, Tailscale navigation,
private persistence, disable/logout recovery and manual real-device validation.

## Verification evidence

| Layer | Local evidence |
| --- | --- |
| Auth, origins, endpoint/DNS/curve validation, encryption and sanitized errors | Backend adversarial tests passed with fake DNS/HTTPS; ciphertext excludes fixture plaintext. |
| Store privacy, capabilities, bounds, leases, retries, expiry, replay and revocation | Backend tests passed against disposable SQLite files, including reopen/pairing rotation and competing claims. |
| Actual journal and lifecycle | A real orchestration runtime delivers a committed contract event through the consumer, preserves VAPID/subscriptions across restart, and does not replay an accepted milestone after restoring a core DB snapshot. An unsupported notification schema leaves core HTTP usable. |
| Closed-page service worker | Event harness verifies display with zero window clients, malformed input, existing-client focus and hostile URL refusal. |
| Settings / browser lifecycle | 30 focused UI tests passed across notification/settings/update files, including permission, enrollment failure cleanup, storage failure, logout partial failure, preferences and revocation. |
| Backend/UI coverage stage | Full local coverage run passed: 858 backend passes, one platform skip; 162 UI passes; backend/UI lines 97.24% / 95.11%. A later bounded startup-retry regression was additionally run in the final Mac suite. |
| macOS boundary suite | Passed: 88 tests, no skips. Extended `test:mac` includes notification security, journal/rollback and service-worker tests. |
| Lint / types / build | Passed after correcting the issues recorded below. |
| Chrome Cypress | Notification and updater specs passed in separately owned disposable harnesses. Notification enrollment/test/revocation uses a real service and fake delivery adapter; update automatic policy remains unchanged. |
| Responsive visual review | Mobile 390px and desktop 1200px notification screenshots inspected; no horizontal overflow. |
| Full-lockfile advisory audit | Zero vulnerabilities after adding `web-push` and `ipaddr.js`. |
| Final hosted verification | See PR checks for the exact pushed implementation commit; hosted CI runs the complete `verify` and extended macOS suite. |

The local backend skip covers invalid UTF-8 filenames, which macOS cannot create.
The two new direct dependencies are MIT-licensed; their lockfile includes
transitive MIT/BSD/Apache notices. The separate publication inventory is explicitly
bound to the earlier lockfile and must be refreshed for any later binary bundle.

## Failures and interventions

- The initial TypeScript run rejected an inferred optional header value and a
  Cypress query option. Notification headers now explicitly return a string map;
  Cypress uses anchored accessible-name matches supported by its types.
- The initial full UI run and diagnostic run were stopped after excessive memory
  use while formatting an obsolete assertion comparing the new Notifications
  button's DOM object with null. The settings regression now navigates to the
  approved page and verifies its control, rather than asserting its removal.
  All 18 settings tests and the full UI suite subsequently passed.
- A focused coverage diagnostic passed its selected tests but failed the global
  90% threshold, as expected when running only one file against all app source.
  The final full UI coverage run passes with the threshold unchanged.
- Full verification reached lint and reported one empty test-cleanup catch block.
  Its intentional already-closed-handle case is now documented; lint, types and
  production build were then run successfully. No tests/coverage were disabled.
- The first 1440px desktop screenshot was cropped by the headless browser window.
  The final visual journey uses 1200px, checks actual document width, and retains
  screenshots before another Cypress child can clear its output directory.

Raw logs and final screenshots are retained under ignored `outputs/background-push/`.
Ports 33421–33423 were owned disposable checks; harnesses closed their processes
and removed their stores. No installed service, real push subscription, VAPID
rotation, repository setting, merge or release was performed for this feature.

## Unverified external acceptance

Actual push-provider acceptance and OS display on a desktop browser and an iOS
Home Screen PWA have **not** been exercised. Fake DNS/transport and Cypress
subscription mocks prove application boundaries, not vendor availability or OS
background behavior. The approved success measure remains unverified until
explicitly enrolled devices receive a test and attention event with the page
closed and tap through to the correct private destination.

The Mac must be awake/online; browser permissions, Focus and force-quit behavior
can prevent delivery. Ambiguous network failures can produce duplicates even
with durable deduplication; provider acceptance cannot be presented as a receipt
from the screen. This PR supplies implementation evidence, not a claim of live
installation or guaranteed delivery.
