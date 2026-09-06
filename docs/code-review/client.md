# Client and PWA code review

## Summary

T7 validation update (2026-09-06): findings were checked against post-refactor commit `c89984a`; original executed probes below remain attributed to their area review. Current consolidated dispositions and verification are in [the final review](README.md). Historical branch-isolation limitations below describe the original investigation, not missing assembled reports.

Review version: 1.0, 2026-09-05. Source baseline: `444adaa059496acd27f24e75208e90bddf5cce38`. Scope: T4, client and PWA; documentation only. Severity means High: potentially wrong agent input/context; Medium: a broken workflow or access barrier; Low: localized presentation or maintenance cost. Findings below distinguish code-traced scenarios from executed reproductions; passing existing tests does not disprove an uncovered scenario.

The strongest foundations are shared lifecycle derivation, in-flight GET sharing, explicit cleanup previews, and safe text rendering. The highest-value work is, in order: prevent stale terminal/queue responses and failed-save sends (CLIENT-001/002); keep feedback visible and make sheets operable by keyboard (CLIENT-003/005); repair Markdown and offline-shell failures (CLIENT-007/008); enforce closed-goal UI state and reconnect ordering (CLIENT-004/009); then consolidate preferences, requests, attachments, and CSS (CLIENT-006/010/011). Avoid a wholesale board rewrite: its existing behavioral coverage is valuable.

Executed validation on the unchanged application: 95/95 Vitest UI tests passed, 11/11 focused Node tests passed, and 44/44 deterministic Cypress tests passed across 11 specs. Direct Node probes reproduced malformed Markdown decoding, external Markdown misclassification, and an HTTP 503 poisoning the offline shell. All manifest icon references exist. No live agent, real GitHub mutation, or installed-device PWA test was run.

## Coverage

Every path below was read in full, including the four stylesheets and the `.mjs` helpers. The coverage block is an exact, sorted match for `git ls-files 'app/**' 'public/sw.js' 'public/manifest.webmanifest'` (26 paths); no file receives a finding merely to fill coverage. Binary icon pixels are excluded. Both `public/icon-192.png` and `public/icon-512.png` exist; all three manifest icon entries resolve to them, including the maskable entry. Existence does not establish maskable safe-zone quality.

<!-- COVERAGE:START -->
```text
app/account-usage.tsx
app/api-request.ts
app/apps-view.tsx
app/context-banner.css
app/context-links.mjs
app/deployment-health.tsx
app/features.css
app/github-issue-planner.tsx
app/globals.css
app/highlight.css
app/image-attachments.tsx
app/layout.tsx
app/markdown-viewer.tsx
app/page.tsx
app/prompt-markdown.tsx
app/release-retention.tsx
app/slash-shortcuts.mjs
app/spec-artifacts.tsx
app/terminal-follow.mjs
app/terminal-grid.mjs
app/terminal-grid.tsx
app/worktree-cleanup.tsx
app/worktree-dashboard.tsx
app/worktree-planner.tsx
public/manifest.webmanifest
public/sw.js
```
<!-- COVERAGE:END -->

Coverage trace:

| Surface | Implementation reviewed | Relevant coverage located |
| --- | --- | --- |
| Shell, terminal, queue, inbox, launch, preferences | Home combines auth, WebSocket reconnect, polling, selection, mutations and rendering; detail views share its state | UI imports at `tests/ui-features.test.tsx:9`; terminal/composer/queue cases at `tests/ui-features.test.tsx:495`, `tests/ui-features.test.tsx:504`, `tests/ui-features.test.tsx:526`; focused decision at `tests/ui-features.test.tsx:596`; helper tests in the validation list below |
| Board, recovery, cleanup, retention | Dashboard combines multiple polling schedules, filtering, persistent column choices, mutation handlers and cards; cleanup uses preview IDs | `cypress/e2e/goal-board-accuracy.cy.ts:86`, `cypress/e2e/goal-board-accuracy.cy.ts:139`, `cypress/e2e/task-branch-retry.cy.ts:18`, `cypress/e2e/board-collapsed-columns.cy.ts:139`, `cypress/e2e/dashboard-overload.cy.ts:57` |
| Goal and issue planning, images, Markdown, artifacts | Planner SSE plus polling, review and task recovery; issue analysis trace; shared image hook and disclosures | `tests/ui-features.test.tsx:19`, `tests/ui-features.test.tsx:1241`, `tests/ui-features.test.tsx:745`, `tests/ui-features.test.tsx:838`, `cypress/e2e/spec-challenge.cy.ts:117`, `cypress/e2e/goal-spec-options.cy.ts:182`, `cypress/e2e/goal-launch-fire-and-forget.cy.ts:73` |
| Issue column and search | Shared issue identity and visibility rules, separate sync action and slow read poll | `cypress/e2e/github-issue-column.cy.ts:59`, `cypress/e2e/github-issue-sync.cy.ts:236`, `cypress/e2e/board-search-filter.cy.ts:113`, `tests/ui-features.test.tsx:2172` |
| Usage, reconnect, deployments, previews | Independent fetch paths, reconnect session state, annotation canvas, usage countdown | `tests/ui-features.test.tsx:111`, `tests/ui-features.test.tsx:160`, `tests/ui-features.test.tsx:571`, `tests/ui-features.test.tsx:2253` |
| CSS, document layout, PWA | Global/feature cascade, highlight and context styles, metadata/viewport, manifest, install/activate/fetch/push/click worker handlers | `tests/responsive-layout.test.mjs:5`, `cypress/e2e/board-collapsed-columns.cy.ts:153`; worker deliberately disabled by `cypress/support/e2e.ts:6` |

Validation commands/results:

- `npm ci --no-audit --no-fund`: passed; installed missing dependencies without tracked changes. The initial UI invocation failed because Vitest was absent; the subsequent run below passed.
- `npm run test:ui`: 2 files, 95 tests passed.
- `node --test tests/context-links.test.mjs tests/terminal-follow.test.mjs tests/terminal-grid.test.mjs tests/slash-shortcuts.test.mjs tests/responsive-layout.test.mjs`: 11 tests passed. The responsive test inspects CSS text, not computed browser geometry.
- `npm run test:e2e:local`: 11 specs, 44 tests passed, local Electron. These use deterministic API fixtures, not real cmux or GitHub.
- Direct Node import of the context resolvers: `bad%name.md` and `image%ZZ.png` throw `URIError`; `https://example.com/guide.md` resolves to `https:/example.com/guide.md` from `README.md`.
- Worker VM probe: seed `/` with a healthy response, dispatch a navigation returning HTTP 503, drain microtasks, make network fetch reject, then navigate again. Result: cached status 503 and maintenance body. A separate `/api/bootstrap` event did not call `respondWith`.
- Exact coverage comparison, manifest asset-existence checks, and backticked citation path/line checks: passed. Citations were also read against their asserted implementation or test behavior.

Combined-delivery limitation: this branch owns only this report. The four peer reports were absent when inspected; the five-report existence check and three-server-report union must run after assembly. T6 owns the requested parser/Git-runner refactor, new unit/E2E coverage and refactor pass. No source or test changes were made here, and no ownership exception was needed.

## What is good

- **Shared requests already solve a real overlap problem.** `app/api-request.ts:5` shares identical unfinished no-init reads, clears the map before mutations, and removes settled promises only if still current. Tests at `tests/ui-api-request.test.tsx:5`, `tests/ui-api-request.test.tsx:21`, and `tests/ui-api-request.test.tsx:36` exercise overlap, mutation separation and retry. Cypress delays a dashboard read beyond its polling interval and asserts only one request at `cypress/e2e/dashboard-overload.cy.ts:57`. This is request sharing, not response-order protection across resources.
- **Lifecycle and recovery rules have useful shared boundaries.** The board imports its columns/derivation at `app/worktree-dashboard.tsx:10`; the sheet imports readiness counting at `app/worktree-planner.tsx:9`. Recovery busy state is keyed per operation at `app/worktree-dashboard.tsx:508`. The real DOM focus and competing-action disabling assertions at `cypress/e2e/task-branch-retry.cy.ts:46` support this strength; `tests/ui-features.test.tsx:1786` rejects a stale persisted workspace as live focus evidence.
- **Column preferences have a deliberate migration.** `app/worktree-dashboard.tsx:79` validates stored object shape, accepts only known IDs and booleans, catches unavailable storage, and applies the version-2 Blocked default. Writes use the same key and schema at `app/worktree-dashboard.tsx:776`. `cypress/e2e/board-collapsed-columns.cy.ts:139` checks the old preference migration and persistence without resetting other columns.
- **Cleanup is reviewable and separated from scheduling.** `app/worktree-cleanup.tsx:45` requests an explicit preview, disables protected selections, and submits the preview ID with selected IDs at `app/worktree-cleanup.tsx:53`. The corresponding UI assertions at `cypress/e2e/goal-board-accuracy.cy.ts:117` verify protected rows, empty-selection disabling, history, and automation staying off. Release retention is separately rendered at `app/release-retention.tsx:16` and exercised at `cypress/e2e/goal-board-accuracy.cy.ts:139`. These prove client behavior against fixtures, not backend deletion safety.
- **Model prose is mostly rendered through safe, useful structures.** `app/prompt-markdown.tsx:18` uses ReactMarkdown without raw HTML support and limits actionable links to HTTP(S); exact raw prompts remain available at `app/prompt-markdown.tsx:33`. `app/spec-artifacts.tsx:126` owns SVG geometry/marker IDs and renders labels as React text. `tests/ui-features.test.tsx:745` covers cyclic/disconnected diagrams and hostile text without injected elements; `tests/ui-features.test.tsx:838` checks rendered/raw prompt round trips. Document highlighting is implemented at `app/markdown-viewer.tsx:43` and verified at `tests/ui-features.test.tsx:553`.
- **Terminal rendering and follow behavior have focused helpers.** Grid bounds and spans are normalized at `app/terminal-grid.mjs:26`, colors are restricted at `app/terminal-grid.mjs:86`, and follow decisions are separate at `app/terminal-follow.mjs:7`. `tests/terminal-grid.test.mjs:5` and `tests/terminal-follow.test.mjs:10` test those contracts; `tests/ui-features.test.tsx:504` checks one mobile composer and native-prompt hiding. This does not establish complete terminal-emulator fidelity.
- **Several asynchronous views clean up resources explicitly.** Home clears socket retry/debounce timers and closes its socket at `app/page.tsx:94`; planner progress closes EventSource at `app/worktree-planner.tsx:95`; document reads ignore inactive responses at `app/markdown-viewer.tsx:24`. The issue progress test checks stream closure at `tests/ui-features.test.tsx:55`. Usage distinguishes absent windows from zero at `app/account-usage.tsx:150`, tested at `tests/ui-features.test.tsx:111`; deployment feedback has a polite status region at `app/deployment-health.tsx:77`.

## Findings

### CLIENT-001 — High — Async state ownership — late terminal/queue reads cross selection boundaries

**Location:** `app/page.tsx:97` (terminal), `app/page.tsx:78` (queue).

**Scenario/consequence:** Start a slow replay for terminal A, select B, let B render, then resolve A. A's output replaces B's view while subsequent input still targets B. An old queue response can likewise populate B's queue with A's items. This can cause a user to act on the wrong session context.

**Evidence:** Both loaders write shared Home state unconditionally after await. Selection clears the visible terminal at `app/page.tsx:137`, but the effect cleanup at `app/page.tsx:98` only clears timers. Request sharing compares paths and cannot reject A's response. The 8-second event/poll refresh at `app/page.tsx:91` also invokes the selection-bound queue loader; changing its identity recreates the socket. This is a verified code trace, not a live incident reproduction. Existing terminal tests mount `TerminalPanel` directly (`tests/ui-features.test.tsx:504`), bypassing Home's loaders.

**Action:** Key replay and queue data by workspace/surface and reject responses whose selection generation is obsolete. Keep the event connection independent of selected queue identity via a current callback reference. Preserve intentional polling fallback and test A→B→A, delayed reads, close/unpair, and event/poll overlap. Apply the same ownership review to planner reloads: `app/worktree-planner.tsx:294` can still call `receive` after New goal resets state at `app/worktree-planner.tsx:335`.

### CLIENT-002 — High — Mutation sequencing — Send now proceeds after saving an edited queued prompt fails

**Location:** `app/page.tsx:305`, `app/page.tsx:125`.

**Scenario/consequence:** Edit a queued instruction and press Send now. If PATCH fails, the subsequent send still runs and can transmit the old stored instruction.

**Evidence:** `PromptQueueRow` awaits `onUpdate` and then unconditionally awaits `onSend`. Home's `queueAction` catches the update error and resolves normally. The blur save can also overlap the click save. The existing queue case supplies always-successful callbacks at `tests/ui-features.test.tsx:526`, so it does not cover the failure boundary. Code-traced; no real terminal input was sent during review.

**Action:** Return an explicit mutation result or propagate rejection to the row and stop sending on failed save. Serialize blur/click saves and disable editing during a dependent send. Add a failed-PATCH regression asserting no send request, retained edited text, and visible error.

### CLIENT-003 — Medium — Error handling/live feedback — terminal notices have no mounted output

**Location:** `app/page.tsx:137`, `app/page.tsx:139`.

**Scenario/consequence:** Sending input, uploading an image, loading health, or changing a queued prompt fails while the terminal detail is open. Home records a notice, but the user sees no reason and may retry the action.

**Evidence:** `sendPrompt` reports failure through `setNotice` at `app/page.tsx:123`; Home returns `WorkspaceDetail` before the sole Home toast in the main app-shell return. `WorkspaceDetail` passes `onNotice` to health operations but renders no notice text. The document early return similarly cannot display Home's “Open a session … first” notice. Toast buttons at `app/page.tsx:139` and `app/markdown-viewer.tsx:39` also lack status/alert semantics. This is directly established by the return branches.

**Action:** Render a persistent feedback host across detail/document/shell navigation, with suitable status or alert semantics and a separate named dismiss control. Test rejected sends/uploads and failed document Ask agent from Home, not only leaf callback calls.

### CLIENT-004 — Medium — Lifecycle/UI contract — closed goals retain task recovery actions

**Location:** `app/worktree-planner.tsx:615`, `app/worktree-planner.tsx:129`.

**Scenario/consequence:** Open an aborted launched goal whose task remains launched/pending. Despite the record-only banner, the task offers Continue and Restart or skip; a failed acquisition task can offer Retry on new branch.

**Evidence:** The terminal branch passes active recovery callbacks into `DeliveryTasks`. That component checks task launch/delivery state, with no terminal-goal flag. Handlers at `app/worktree-planner.tsx:453` and `app/worktree-planner.tsx:472` only require a draft. Existing closed-goal coverage uses an integrated merged task or an aborted draft with no tasks (`tests/ui-features.test.tsx:1915`, `tests/ui-features.test.tsx:1937`). The backend does refuse recovery via `server/worktree-planner.mjs:1122` and `server/worktree-planner.mjs:868`; this is misleading actionable UI, **not** a demonstrated terminal-goal mutation bypass.

**Action:** Give delivery rows an explicit read-only mode and guard handlers against terminal state. Test aborted launched goals with pending and failed tasks, confirming that no recovery control or request exists while historical evidence remains readable.

### CLIENT-005 — Medium — Accessibility — modal semantics lack focus and keyboard behavior

**Location:** `app/worktree-planner.tsx:528`, `app/page.tsx:227`, `app/account-usage.tsx:136`.

**Scenario/consequence:** Keyboard users open a sheet while focus remains on the underlying trigger; Tab can continue into background controls, and Escape does not close the sheet. Declaring `aria-modal` alone does not implement modal interaction.

**Evidence:** These custom dialogs have no shared focus management, focus trap, inert background, Escape listener, or return-focus handling. The same structure appears in `app/apps-view.tsx:109` and `app/worktree-dashboard.tsx:962`. The annotation test even clicks the background History tab while the dialog remains mounted (`tests/ui-features.test.tsx:588`). Project/status tabs use `role="tab"` without arrow-key/roving-tabindex behavior at `app/worktree-dashboard.tsx:798`. Some close buttons are only “×” (`app/page.tsx:227`). Mobile column toggles are explicitly 18×18 CSS pixels at `app/features.css:319`; rendered target spacing/conformance was not measured.

**Action:** Introduce one tested dialog primitive with initial focus, containment, background inertness, explicit close policy and focus restoration. Preserve the goal sheet's intentional non-dismissable backdrop. Use plain toggle/navigation buttons where full tab semantics are unnecessary, otherwise implement the keyboard pattern. Name symbol-only controls and enlarge small touch hit areas. Add keyboard-only Cypress flows; do not infer accessibility compliance from role queries alone.

### CLIENT-006 — Medium — Persistence resilience — shell preference access can throw during render

**Location:** `app/page.tsx:61`, `app/page.tsx:66`, `app/page.tsx:216`.

**Scenario/consequence:** A browser context refusing localStorage access can fail Home's first render; a font/read-only preference write can fail an interaction. An out-of-range stored terminal font is accepted initially even though adjustments clamp it.

**Evidence:** Home preference initializers directly call `localStorage.getItem`; setters at `app/page.tsx:128` and `app/page.tsx:218` write without try/catch. There is only a server-render guard, not a storage-access guard. The board already handles this case at `app/worktree-dashboard.tsx:79`. Read and write key spellings are consistent; no actual key migration mismatch was found. Code-traced exceptional environment, not a claim that ordinary private browsing always throws.

**Action:** Reuse a small safe preference reader/writer with validated enums, bounded numbers and defaults. Keep the board's versioned migration. Exercise throwing storage, malformed values, explicit URL overrides and valid stored values in Home tests.

### CLIENT-007 — Medium — Input robustness/navigation — Markdown resolver throws and captures external links

**Location:** `app/context-links.mjs:42`, `app/context-links.mjs:55`, `app/markdown-viewer.tsx:45`.

**Scenario/consequence:** A document containing a malformed percent escape can throw from a render callback. A web link ending in `.md` is interpreted as a repository file and produces a failed local document request instead of opening the web page.

**Evidence:** Executed direct imports produced `URIError` for `bad%name.md` and `image%ZZ.png`; the external URL `https://example.com/guide.md` became `https:/example.com/guide.md`. Decoding is unguarded and schemes are not excluded before path resolution. The viewer invokes the resolver before its HTTP(S) link branch. `tests/context-links.test.mjs:16` covers traversal and valid relative paths, and `tests/ui-features.test.tsx:553` follows a valid relative link; neither exercises these cases.

**Action:** Classify URI schemes before repository resolution, catch decoding failures and avoid double decoding assets. Keep traversal refusal. Test malformed escapes, absolute HTTP(S) Markdown/image URLs, encoded percent characters, fragments, query strings, and ordinary relative links. Render invalid links inertly rather than failing the document.

### CLIENT-008 — Medium — PWA reliability — failed navigation poisons offline shell; cache update policy is incomplete

**Location:** `public/sw.js:25`, `public/sw.js:35`.

**Scenario/consequence:** During maintenance a navigation returns HTTP 503. That error replaces cached `/`; a subsequent network failure serves the error as the offline shell. Stable asset URLs remain cache-first indefinitely within version v7.

**Evidence:** The navigation handler clones and caches every response without checking status/content type. The executed worker VM sequence described in Coverage returned the cached 503. Asset handling has an `ok` check but no revalidation; the install list contains only HTML, manifest and icons (`public/sw.js:1`), so offline JS/CSS availability depends on prior fetches. Writes are not attached to `event.waitUntil` at `public/sw.js:27` and `public/sw.js:37`. Installation immediately calls skipWaiting, activation deletes every differently named origin cache and claims clients (`public/sw.js:4`, `public/sw.js:9`); Home has no controller-change/update UI at `app/page.tsx:80`. The local Cypress support explicitly documents stale unversioned Vite modules and disables the worker (`cypress/support/e2e.ts:3`).

**Action:** Cache only successful expected shell responses, bind writes to event lifetime, namespace deletions, and define a build-aware shell/asset update strategy with an explicit reload policy for open drafts. Test 503→offline, first/second offline launch, old worker plus new assets, activation with open tabs, unrelated caches, and draft preservation. Do not claim a production mixed-version failure without a production-build browser test.

### CLIENT-009 — Medium — Reconnect concurrency — late polls can regress a successful login

**Location:** `app/account-usage.tsx:104`, `app/account-usage.tsx:81`.

**Scenario/consequence:** A waiting-status poll is in flight when the callback POST succeeds. The success view appears, then the older waiting response arrives and restores the login view/polling. Closing during a poll can also leave a late adoption callback after the sheet closes.

**Evidence:** The interval starts independent fetches every 1.5 seconds; cleanup clears only the interval. Every successful poll and callback invokes `adopt`, which unconditionally sets session state. `successHandled` prevents a duplicate refresh, not state regression. The abort controller at `app/account-usage.tsx:90` covers only the initial POST. `tests/ui-features.test.tsx:160` covers successful callback submission with immediate fixture responses, not reversed completion order. Code-traced, not a real OAuth experiment.

**Action:** Serialize polls, reject obsolete session/generation responses, and make terminal statuses monotonic. Cancel/ignore outstanding polls on close and handle cancellation failure. Add deferred-response tests for poll/callback overlap, slow polls, close before creation completes, failed DELETE, expiry and terminal status adoption.

### CLIENT-010 — Low — Maintainability — remaining request and attachment paths bypass existing shared code

**Location:** `app/apps-view.tsx:15`, `app/account-usage.tsx:26`, `app/deployment-health.tsx:59`, `app/page.tsx:121`.

**Scenario/consequence:** A change to request errors, coalescing or attachment validation must be repeated across multiple loaders/uploaders. The terminal path already accepts any `image/*` while the shared hook permits four exact MIME types, and uses object URLs while the shared hook uses data URLs.

**Evidence:** Apps repeats fetch/JSON/status handling in load, mutate and capture (`app/apps-view.tsx:20`, `app/apps-view.tsx:29`), outside `app/api-request.ts:5`. Terminal duplicates `imageDataUrl`/prompt composition at `app/page.tsx:42` and upload/count/error handling at `app/page.tsx:121`, despite corresponding helpers at `app/image-attachments.tsx:16` and `app/image-attachments.tsx:35`. The shared request is additionally re-exported through the image UI module at `app/image-attachments.tsx:14`. GET callers with distinct query strings still need explicit ordering even after consolidation.

**Action:** Migrate compatible JSON requests to direct imports of the request module, preserving specific messages and AbortSignal behavior. Unify attachment validation/lifecycle without changing prompt format or four-image limits. Extract small board column chrome/recovery controls only where contracts match: issue and goal columns repeat header/toggle/count markup at `app/worktree-dashboard.tsx:831` and `app/worktree-dashboard.tsx:846`, but their actions and empty states differ. Preserve existing API, upload, and Cypress overload regressions throughout a later refactor.

### CLIENT-011 — Low — CSS correctness/cascade — Added artifact badge has no matching style

**Location:** `app/features.css:276`, `app/spec-artifacts.tsx:179`.

**Scenario/consequence:** A screen artifact marking an element as Added gets the neutral badge style, unlike Changed and Removed, because the CSS targets `change-new` while markup emits `change-added`.

**Evidence:** The class mismatch is literal; `tests/ui-features.test.tsx:745` verifies the Added text but not its computed style. The stylesheet also retains repeated base/override rules, for example the planner textarea sizes at `app/features.css:106` and `app/features.css:643`, and both stylesheets define empty-card styling (`app/globals.css:7`, `app/features.css:11`). Later rules intentionally adjust type scale; duplication alone is not proof of a visual failure. Broad global checkbox pseudo-elements at `app/globals.css:16` also interact with narrower feature inputs and deserve computed-style checks before cleanup.

**Action:** Align the Added class, then format and consolidate per-component styles while preserving final cascade order and responsive breakpoints. Use tokens or scoped primitives for truly shared badges/cards; avoid removing overrides based only on duplicate selectors. Verify Added/Changed/Removed badges, checkbox geometry, focus rings, mobile hit areas and wide planner layout in the browser.

## Test gaps

These are proposed follow-up checks, not newly added tests. T4 changes no behavior, so the repository's requirement to add Cypress coverage for new UI behavior does not require test edits here; the existing deterministic suite was nevertheless run.

| Priority | Missing scenario | Closest current evidence / boundary |
| --- | --- | --- |
| High | Home terminal/queue switching with deferred responses; rejected edited-queue save must prevent send | Leaf terminal tests and request-sharing tests cover separate contracts (`tests/ui-features.test.tsx:504`, `tests/ui-api-request.test.tsx:21`). Mount Home and interleave actual fixture requests. |
| Medium | Closed launched goals with pending/failed tasks | Current terminal-goal fixtures use integrated tasks or no tasks (`tests/ui-features.test.tsx:1914`). Extend both UI and Cypress coverage. |
| Medium | Initial focus, Tab/Shift-Tab containment, Escape policy, focus restoration, accessible error announcements, touch areas | One attention-rail focus assertion exists (`cypress/e2e/task-branch-retry.cy.ts:46`); it is not modal coverage. Include reconnect, planner, queue, follow-up and annotation sheets. |
| Medium | Throwing storage, malformed preferences, terminal font bounds, URL-vs-storage precedence | Column migration is tested (`cypress/e2e/board-collapsed-columns.cy.ts:139`); Home preference initializers are not. |
| Medium | Reconnect delayed polls, callback races, early close/cancel errors; WebSocket backoff cleanup and stable connection during selection changes | Issue/planner SSE tests and happy reconnect case do not cover Home WebSocket or OAuth ordering (`tests/ui-features.test.tsx:19`, `tests/ui-features.test.tsx:160`). Use fake transports, not real credentials. |
| Medium | Real service-worker install/update/offline/push-click lifecycle; malformed Markdown links and document navigation edge cases | Cypress disables `/sw.js` (`cypress/support/e2e.ts:12`); push-service backend tests do not execute the browser worker. Add an isolated worker-enabled local suite with deterministic notifications/network responses. |
| Low | Annotation output coordinates and upload/send failure; pending image uploads during switching/reset; all shared MIME/count boundaries | Apps coverage opens the editor but does not draw/save (`tests/ui-features.test.tsx:571`); goal attachment coverage handles add/remove (`tests/ui-features.test.tsx:1241`). |
| Low | Final CSS cascade, checkbox geometry, Added badge color, reduced motion and headings/TOC with inline formatting or duplicate headings | CSS regex test is structural (`tests/responsive-layout.test.mjs:5`); column-width Cypress checks are narrowly scoped (`cypress/e2e/board-collapsed-columns.cy.ts:153`). |

Rejected or unverified claims:

- **Rejected:** “Polling always duplicates simultaneous dashboard fetches.” Identical no-init requests are shared and the slow-read Cypress test passes. Different resources/query strings, raw-fetch components, and late results after mutations remain separate concerns.
- **Rejected:** “Closed-goal recovery controls bypass backend protection.” The UI does expose them for uncovered task states, but `server/worktree-planner.mjs:1122` rejects terminal plans.
- **Rejected:** “Column storage keys or the Blocked migration are inconsistent.” The key is shared and the migration passes browser coverage. Home's unguarded access is a different issue.
- **Rejected:** “Every account cadence must be shown.” The quota test explicitly excludes monthly usage windows at `tests/ui-features.test.tsx:142`; the narrower product display is intentional in current tests, not a verified regression.
- **Unverified:** Production cache-version mismatch, offline installability on iOS, notification delivery/click behavior on a real device, maskable icon pixel quality, whole-app WCAG compliance, memory-leak magnitude and board performance at production scale. Static concerns and mocked tests cannot establish those outcomes.
- **Not claimed:** Full server safety, complete test/tooling review, the canonical Git refactor, or completion of the other four reports. Those belong to the combined goal; this report contributes the T4 portion of AC-1.
