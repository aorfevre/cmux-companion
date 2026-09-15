# Notifications

Open **Settings → Notifications** on each paired browser or installed PWA.
In-app update notices start enabled. Background push starts disabled. Choose
**Enable background notifications** to request browser permission and register
that device with the Mac. Permission alone does not mean registration succeeded.

Choose Needs your attention (questions, approval and recovery), Goal complete
(confirmed merged goal), and Updates (eligible candidate, installation result).
**Hide project and goal names** starts enabled: notification text is generic.
Disabling it allows the goal title on the lock screen; question text, error details,
terminal output, repository paths and credentials never enter push payloads.
Changing preferences cannot retract already displayed or provider-accepted notices.

**Send test notification** uses the configured push path. The page reports queued,
last attempt and provider acceptance separately. “Accepted by push service” is not
proof that the operating system displayed it. Tests are limited to once a minute.
In-app banners and mandatory workflow/errors are independent of push preferences;
turning notifications off does not disable update checks or automatic installation.

## Devices and network

Your Mac must be awake, online and running Companion to originate notifications.
The browser's push service can display a notification while the page is closed,
subject to OS/browser support, permission, Focus and force-quit restrictions.
Delivery is best-effort. No notification can approve, retry, publish or install.
Tapping opens the latest authoritative state in the paired app.

Remote access still uses HTTPS over Tailscale. No public inbound port or relay is
required. A phone may receive a push without tailnet access; opening Companion
content requires Tailscale and valid pairing. Push sends outbound HTTPS to these
explicitly supported vendor endpoint families:

- Google: `fcm.googleapis.com/fcm/send/` and `/wp/`.
- Mozilla: `updates.push.services.mozilla.com/wpush/v2/`.
- Apple: `web.push.apple.com/`.

Other endpoints are rejected rather than permitting arbitrary server-side HTTP.
Each connection resolves only public addresses, with no redirects or pooled
connections. Push payloads are Web Push encrypted; the vendor still sees endpoint,
sender and timing metadata, and the receiving browser/OS can display their text.

On iPhone/iPad, use iOS/iPadOS 16.4+ and **Share → Add to Home Screen**, then enable
notifications from the installed app. Desktop support is feature-detected. If
permission is denied, change this site's notification setting in the browser and
check OS settings; repeatedly pressing Enable cannot override the denial.

## Private state and recovery

The Mac stores a VAPID identity, subscription endpoints/keys, hashed per-device
management proofs and delivery metadata in
`<CMUX_COMPANION_DATA_DIR>/notifications/notifications.sqlite` (private directory
0700, files 0600). The SQLite sidecars are private too. Endpoints, credentials and
payload bodies must not be copied into issues, logs or screenshots.

`CMUX_COMPANION_PUSH_CONTACT` optionally overrides the VAPID contact; use a valid
`mailto:maintainer@example.com` value. The default is the project's published
maintainer contact, `mailto:aorfevre@gmail.com`. Fork maintainers should override
it. It identifies the sender to the push vendor; Companion does not send email.
No hosted push-provider account or Firebase project is required.

Notification state uses an independent additive schema, version 1, outside
release trees. Upgrades/restarts preserve it. Old Companion versions leave this
separate store inert; core workflow/settings rollback does not rewind notification
receipts or VAPID keys. Pending attention is rechecked against restored workflow
state before sending. Resetting the journal or rotating the pairing token revokes
old subscriptions. An unsupported notification schema/configuration disables
notification setup rather than permitting unsafe writes or blocking core startup.

**Disable background notifications on this device** attempts server revocation
and browser unsubscription and reports partial failures. Unpairing attempts that
cleanup but still signs out if cleanup fails. Keep the failure message and revoke
from another paired device if necessary. The management proof is stored in this
browser; clearing site data may lose it. **Revoke all push subscriptions on this
Mac**, with confirmation, invalidates every device's server subscription; devices
must enable again. Pairing is shared installation trust, not separate user roles.

For an explicit VAPID rotation, stop only the owned Companion service, back up its
private notification directory, remove that directory from the active data path,
and restart. Every device must unsubscribe/re-enroll. Do not do this routinely or
copy the keys into a release. No live rotation was performed by this change.

The outbox retains bounded metadata for seven days, at most 100 pending notices
per device and 32 subscriptions. New enrollment does not replay earlier journal
events. Attention/candidate notices expire in one hour; completion/update results
expire in 24 hours. Transient failures retry with backoff, at most five claims;
404/410 revokes the endpoint. Ambiguous network failures may still cause duplicate
display; stable tags and durable deduplication reduce it. Queue limits can drop
new notices and expose a sanitized queue-full status.

## Verification

Routine tests use disposable stores, fake DNS/HTTPS/push adapters and mocked
browser subscriptions. The settings Cypress fixture never sends to a real vendor.
Run its journey with:

```sh
CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local -- \
  --settings --spec cypress/e2e/notifications.cy.ts
```

Before claiming real background delivery works, explicitly enroll a desktop
browser and an iOS Home Screen app on a supported private HTTPS installation.
For each, close the Companion page, trigger a harmless test and a disposable
Needs your attention event, record display latency/misses/duplicates, then tap
through to the correct paired destination. Confirm disable prevents later sends
and remove the owned test subscription. OS delivery remains unverified until
this device-specific check is performed; a mocked Cypress pass cannot prove it.
