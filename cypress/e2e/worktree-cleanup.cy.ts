// Worktree cleanup from Settings: the automation policy (every field is one
// PATCH), a run with mixed outcomes and Git prune, a failed run that keeps the
// preview, release retention configure/run/failure, and the fact that these
// panels are not gated by read-only protection. goal-board-accuracy.cy.ts
// already covers the happy path of one removal and the enable checkbox.
import { DEFAULT_MODEL_ROLES } from "../../server/model-options.mjs";

const now = "2026-09-08T12:00:00.000Z";
const GB = 1024 ** 3;

type Policy = { enabled: boolean; intervalHours: number; graceDays: number; pruneEnabled: boolean; pruneGraceDays: number };
type RunResult = { at: string; estimatedReclaimedBytes?: number; results: { path: string; outcome: string; reason?: string }[] };

function scenario() {
  const state = {
    policy: { enabled: false, intervalHours: 24, graceDays: 7, pruneEnabled: false, pruneGraceDays: 30 } as Policy,
    history: [] as RunResult[],
    releasePolicy: { enabled: false, intervalHours: 24 },
    releaseHistory: [] as RunResult[],
  };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: DEFAULT_MODEL_ROLES, defaults: DEFAULT_MODEL_ROLES, warning: null });
  cy.intercept("GET", "**/api/push/status*", { supported: false, subscribed: false });
  cy.intercept("GET", "**/api/worktree-cleanup", (request) => request.reply({ policy: state.policy, history: state.history })).as("status");
  cy.intercept("PATCH", "**/api/worktree-cleanup", (request) => { Object.assign(state.policy, request.body); request.reply({ policy: state.policy }); }).as("configure");
  cy.intercept("GET", "**/api/worktree-cleanup/releases", (request) => request.reply({ policy: state.releasePolicy, history: state.releaseHistory })).as("releaseStatus");
  cy.intercept("PATCH", "**/api/worktree-cleanup/releases", (request) => { Object.assign(state.releasePolicy, request.body); request.reply({ policy: state.releasePolicy }); }).as("releaseConfigure");
  return state;
}

const preview = {
  previewId: "preview-mixed", summary: { candidates: 3, protected: 1, estimatedBytes: 3 * GB }, errors: [{ path: "/Users/test/Developers/karven/broken", error: "git status timed out" }],
  entries: [
    { id: "merged", path: "/Users/test/Developers/karven/ledger-merged", branch: "goal/merged", classification: "development", eligible: true, reasons: ["Goal PR #40 is merged"], estimatedBytes: GB },
    { id: "graced", path: "/Users/test/Developers/karven/ledger-graced", branch: "feature/graced", classification: "development", eligible: true, reasons: ["Merged 9 days ago; grace period elapsed"], estimatedBytes: GB },
    { id: "moved", path: "/Users/test/Developers/karven/ledger-moved", branch: "feature/moved", classification: "development", eligible: true, reasons: ["Merged 12 days ago; grace period elapsed"], estimatedBytes: GB },
    { id: "active", path: "/Users/test/Developers/karven/ledger", branch: "main", classification: "primary", eligible: false, reasons: ["Primary worktree"], estimatedBytes: null },
  ],
  prune: [
    { common: "/Users/test/Developers/karven/ledger/.git", repositoryPath: "/Users/test/Developers/karven/ledger", paths: ["/Users/test/Developers/karven/ledger-gone"], eligible: true, reason: "Registration missing for 31 days" },
    { common: "/Users/test/Developers/karven/trust/.git", repositoryPath: "/Users/test/Developers/karven/trust", paths: ["/Users/test/Developers/karven/trust-recent"], eligible: false, reason: "Missing for 2 days, inside the prune grace" },
  ],
};

function openCleanup() {
  cy.visit("/?view=settings", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-read-only", "true"); } });
  cy.findByRole("heading", { name: /^Settings$/ }).should("be.visible");
  cy.findByRole("button", { name: "Worktree cleanup" }).click();
  cy.wait("@status");
}

function panel() { return cy.findByRole("region", { name: "Worktree cleanup" }); }

describe("worktree cleanup and release retention", () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    it(`sends each automation field as its own PATCH and reflects the saved policy at ${width}px`, () => {
      cy.viewport(width, height);
      const state = scenario();
      openCleanup();
      panel().should("contain.text", "Automatic deletion disabled");
      cy.findByLabelText("Grace period (days)").should("have.value", "7").clear().type("14").blur();
      cy.wait("@configure").its("request.body").should("deep.equal", { graceDays: 14 });
      cy.findByLabelText("Schedule (hours)").should("have.value", "24").clear().type("6").blur();
      cy.wait("@configure").its("request.body").should("deep.equal", { intervalHours: 6 });
      cy.findByRole("checkbox", { name: "Allow Git to prune expired missing registrations" }).check();
      cy.wait("@configure").its("request.body").should("deep.equal", { pruneEnabled: true });
      cy.findByLabelText("Prune grace (days)").should("have.value", "30").clear().type("45").blur();
      cy.wait("@configure").its("request.body").should("deep.equal", { pruneGraceDays: 45 });
      // Leaving a field unchanged sends nothing.
      cy.findByLabelText("Schedule (hours)").focus().blur();
      cy.get("@configure.all").should("have.length", 4);
      cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).check();
      cy.wait("@configure").its("request.body").should("deep.equal", { enabled: true });
      panel().should("contain.text", "Automatic deletion enabled");
      cy.then(() => expect(state.policy).to.deep.equal({ enabled: true, intervalHours: 6, graceDays: 14, pruneEnabled: true, pruneGraceDays: 45 }));
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  it("runs a cleanup with mixed outcomes and a Git prune, then shows the recorded history", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("POST", "**/api/worktree-cleanup/preview", preview).as("preview");
    cy.intercept("POST", "**/api/worktree-cleanup/run", (request) => {
      expect(request.body).to.deep.equal({ previewId: "preview-mixed", ids: ["merged", "graced", "moved"], prune: ["/Users/test/Developers/karven/ledger/.git"] });
      const result: RunResult = { at: now, estimatedReclaimedBytes: GB, results: [
        { path: preview.entries[0].path, outcome: "removed" },
        { path: preview.entries[1].path, outcome: "skipped", reason: "A cmux session opened this worktree since the preview" },
        { path: preview.entries[2].path, outcome: "failed", reason: "git worktree remove exited with 128" },
        { path: "/Users/test/Developers/karven/ledger-gone", outcome: "pruned" },
      ] };
      state.history.unshift(result);
      request.reply(result);
    }).as("run");
    openCleanup();
    cy.findByRole("button", { name: "Preview cleanup" }).click();
    cy.wait("@preview");
    panel().within(() => {
      cy.contains("3 eligible · 1 protected · approximately 3.00 GB reclaimable").should("be.visible");
      cy.contains("/Users/test/Developers/karven/broken: git status timed out").should("be.visible");
      cy.contains("tr", "main").should("contain.text", "Protected: Primary worktree").and("contain.text", "Unknown");
      cy.contains("tr", "goal/merged").should("contain.text", "Eligible: Goal PR #40 is merged").and("contain.text", "1.00 GB");
      cy.findByRole("button", { name: "Run cleanup" }).should("be.disabled");
      cy.contains("Stale registrations (Git prune)").should("be.visible");
      cy.findByRole("checkbox", { name: /trust: Missing for 2 days/ }).should("be.disabled");
      cy.findByRole("checkbox", { name: /ledger: Registration missing for 31 days/ }).check();
      cy.findByRole("button", { name: "Run cleanup" }).should("be.enabled");
      cy.findByRole("checkbox", { name: "Select /Users/test/Developers/karven/ledger-merged" }).check();
      cy.findByRole("checkbox", { name: "Select /Users/test/Developers/karven/ledger-graced" }).check();
      cy.findByRole("checkbox", { name: "Select /Users/test/Developers/karven/ledger-moved" }).check();
      cy.findByRole("button", { name: "Run cleanup" }).click();
    });
    cy.wait("@run");
    cy.wait("@status");
    panel().within(() => {
      cy.findByRole("status").should("have.text", "1 worktrees removed; 2 skipped or failed.");
      cy.findByRole("table").should("not.exist");
      cy.contains("Cleanup history (1)").click();
      cy.contains("estimated 1.00 GB reclaimed").should("be.visible");
      cy.contains("removed: /Users/test/Developers/karven/ledger-merged").should("be.visible");
      cy.contains("skipped: /Users/test/Developers/karven/ledger-graced — A cmux session opened this worktree since the preview").should("be.visible");
      cy.contains("failed: /Users/test/Developers/karven/ledger-moved — git worktree remove exited with 128").should("be.visible");
      cy.contains("pruned: /Users/test/Developers/karven/ledger-gone").should("be.visible");
    });
  });

  it("keeps the reviewed preview and selection when the run is rejected, and names a failed preview", () => {
    cy.viewport(390, 844);
    scenario();
    let previewFails = true;
    cy.intercept("POST", "**/api/worktree-cleanup/preview", (request) => {
      if (previewFails) request.reply({ statusCode: 503, body: { error: "Worktree inventory is unavailable while a scan runs" } });
      else request.reply(preview);
    }).as("preview");
    cy.intercept("POST", "**/api/worktree-cleanup/run", { statusCode: 409, body: { error: "The preview expired. Preview cleanup again before running it" } }).as("run");
    openCleanup();
    cy.findByRole("button", { name: "Preview cleanup" }).click();
    cy.wait("@preview");
    panel().findByRole("alert").should("have.text", "Worktree inventory is unavailable while a scan runs");
    panel().findByRole("table").should("not.exist");
    cy.then(() => { previewFails = false; });
    cy.findByRole("button", { name: "Preview cleanup" }).click();
    cy.wait("@preview");
    panel().within(() => {
      cy.findByRole("alert").should("not.exist");
      cy.findByRole("checkbox", { name: "Select /Users/test/Developers/karven/ledger-merged" }).check();
      cy.findByRole("button", { name: "Run cleanup" }).click();
    });
    cy.wait("@run");
    panel().within(() => {
      cy.findByRole("alert").should("have.text", "The preview expired. Preview cleanup again before running it");
      cy.findByRole("table").should("be.visible");
      cy.findByRole("checkbox", { name: "Select /Users/test/Developers/karven/ledger-merged" }).should("be.checked");
      cy.findByRole("button", { name: "Run cleanup" }).should("be.enabled");
    });
    cy.get("@status.all").should("have.length", 1);
  });

  it("reports a rejected policy change and keeps the last saved policy on screen", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("PATCH", "**/api/worktree-cleanup", { statusCode: 400, body: { error: "graceDays must be between 0 and 365" } }).as("configure");
    openCleanup();
    cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).check();
    cy.wait("@configure");
    panel().findByRole("alert").should("have.text", "graceDays must be between 0 and 365");
    cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).should("not.be.checked");
    panel().should("contain.text", "Automatic deletion disabled");
    cy.then(() => expect(state.policy.enabled).to.equal(false));
  });

  it("configures updater release retention, runs it, and reads back the recorded run", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("POST", "**/api/worktree-cleanup/releases/preview", { previewId: "releases-1", errors: [{ target: "updater", error: "Lock held by another process" }], entries: [
      { path: "/Users/test/Library/cmux/releases/companion/aaaaaaaaaaaa1111", target: "companion", sha: "aaaaaaaaaaaa1111", eligible: false, reasons: ["Current release"], estimatedBytes: null },
      { path: "/Users/test/Library/cmux/releases/companion/bbbbbbbbbbbb2222", target: "companion", sha: "bbbbbbbbbbbb2222", eligible: false, reasons: ["Rollback target"], estimatedBytes: null },
      { path: "/Users/test/Library/cmux/releases/companion/cccccccccccc3333", target: "companion", sha: "cccccccccccc3333", eligible: true, reasons: ["Older than the two retained previous releases"], estimatedBytes: 2 * GB },
      { path: "/Users/test/Library/cmux/releases/companion/dddddddddddd4444", target: "companion", sha: "dddddddddddd4444", eligible: true, reasons: ["Superseded failed candidate"], estimatedBytes: GB },
    ] }).as("releasePreview");
    cy.intercept("POST", "**/api/worktree-cleanup/releases/run", (request) => {
      expect(request.body).to.deep.equal({ previewId: "releases-1", ids: ["/Users/test/Library/cmux/releases/companion/cccccccccccc3333"] });
      state.releaseHistory.unshift({ at: now, results: [{ path: "/Users/test/Library/cmux/releases/companion/cccccccccccc3333", outcome: "removed" }] });
      request.reply({ at: now, results: state.releaseHistory[0].results });
    }).as("releaseRun");
    openCleanup();
    cy.contains("Managed release retention (updater)").click();
    cy.wait("@releaseStatus");
    cy.findByLabelText("Release cleanup interval (hours)").should("have.value", "24").clear().type("12").blur();
    cy.wait("@releaseConfigure").its("request.body").should("deep.equal", { intervalHours: 12 });
    cy.wait("@releaseStatus");
    cy.findByRole("checkbox", { name: "Enable automatic release deletion" }).check();
    cy.wait("@releaseConfigure").its("request.body").should("deep.equal", { enabled: true });
    cy.wait("@releaseStatus");
    cy.findByRole("checkbox", { name: "Enable automatic release deletion" }).should("be.checked");
    cy.findByRole("button", { name: "Preview release retention" }).click();
    cy.wait("@releasePreview");
    cy.contains("updater: Lock held by another process").should("be.visible");
    cy.findByRole("checkbox", { name: "Select release aaaaaaaaaaaa1111" }).should("be.disabled");
    cy.findByRole("checkbox", { name: "Select release bbbbbbbbbbbb2222" }).should("be.disabled");
    cy.contains("label", "companion cccccccccccc: Older than the two retained previous releases · 2.00 GB").should("be.visible");
    cy.findByRole("button", { name: "Run release cleanup" }).should("be.disabled");
    cy.findByRole("checkbox", { name: "Select release cccccccccccc3333" }).check();
    cy.findByRole("button", { name: "Run release cleanup" }).click();
    cy.wait("@releaseRun");
    cy.wait("@releaseStatus");
    cy.findByRole("checkbox", { name: "Select release cccccccccccc3333" }).should("not.exist");
    cy.contains("Release cleanup history (1)").click();
    cy.contains("removed: /Users/test/Library/cmux/releases/companion/cccccccccccc3333").should("be.visible");
    cy.then(() => expect(state.releasePolicy).to.deep.equal({ enabled: true, intervalHours: 12 }));
  });

  it("shows release retention failures inside its own panel without touching worktree cleanup", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/worktree-cleanup/releases", { statusCode: 503, body: { error: "Release retention needs the managed updater" } }).as("releaseStatus");
    openCleanup();
    cy.contains("Managed release retention (updater)").click();
    cy.wait("@releaseStatus");
    cy.contains("Managed release retention (updater)").parent("details").within(() => {
      cy.findByRole("alert").should("have.text", "Release retention needs the managed updater");
      cy.findByRole("checkbox", { name: "Enable automatic release deletion" }).should("not.exist");
    });
    cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).should("be.enabled");
    cy.findByRole("button", { name: "Preview cleanup" }).should("be.enabled");
  });
});
