// Burst decisions beyond approval: decline, rescan (with the poll that
// follows), a scan that fails and is retried, the list of past bursts (the
// sheet opens the newest), no starred repositories, and the failure paths on
// create and on a candidate action. burst-plan.cy.ts covers approve and
// read-only.
export {};

const now = "2026-09-08T12:00:00.000Z";
const REPO_A = "repoBurstE2E000001";
const REPO_B = "repoBurstE2E000002";

type Candidate = { repositoryId: string; repositoryName: string; goal: string | null; rationale: string | null; evidence: string[]; sizeEstimate: string | null; status: "scanning" | "proposed" | "failed" | "approved" | "declined"; reason: string | null; planId: string | null; updatedAt: string };
type Burst = { burstId: string; status: "scanning" | "ready" | "closed"; createdAt: string; updatedAt: string; capacitySnapshot: unknown; candidates: Candidate[] };

function repository(id: string, name: string) {
  return { id, name, root: "karven", path: `/Users/test/Developers/karven/${name}`, favorite: true, archived: false, pullRequestsAvailable: true,
    summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
    worktrees: [{ id: `wt-${id}`, repoId: id, path: `/Users/test/Developers/karven/${name}`, name, branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }], releases: [] };
}

function candidate(repositoryId: string, repositoryName: string, extra: Partial<Candidate> = {}): Candidate {
  return { repositoryId, repositoryName, goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "scanning", reason: null, planId: null, updatedAt: now, ...extra };
}

function readyBurst(burstId = "burst-ready"): Burst {
  return { burstId, status: "ready", createdAt: now, updatedAt: now, capacitySnapshot: null, candidates: [
    candidate(REPO_A, "trust-layer", { status: "proposed", goal: "Cover the plan store with tests", rationale: "35 server modules have no test file.", evidence: ["server/worktree-plan-store.mjs"], sizeEstimate: "medium" }),
    candidate(REPO_B, "ledger", { status: "failed", reason: "The scan needs the ccs CLI. Install it, then try again" }),
  ] };
}

function scenario() {
  const state = { bursts: [] as Burst[] };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false, reason: "Local fixture", nextReset: null });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready", checkedAt: now }, summary: { repositories: 2, worktrees: 2, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 }, repositories: [repository(REPO_A, "trust-layer"), repository(REPO_B, "ledger")], orphanSessions: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: {}, defaults: {}, warning: null });
  cy.intercept("GET", "**/api/bursts", (request) => request.reply({ bursts: state.bursts })).as("listBursts");
  cy.intercept("GET", "**/api/bursts/*", (request) => {
    const id = decodeURIComponent(request.url.split("/api/bursts/")[1]);
    const burst = state.bursts.find((item) => item.burstId === id);
    if (burst) request.reply(burst); else request.reply({ statusCode: 404, body: { error: "Unknown burst", code: "NOT_FOUND" } });
  }).as("readBurst");
  return state;
}

function openSheet(readOnly = false) {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", String(readOnly)); } });
  cy.openBoardTools();
  cy.findByRole("button", { name: "Burst" }).click();
  cy.wait("@listBursts");
}

function sheet() { return cy.findByRole("dialog", { name: "Burst plan" }); }

describe("burst decisions", () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    it(`opens the newest of several bursts and shows each candidate's evidence at ${width}px`, () => {
      cy.viewport(width, height);
      const state = scenario();
      const older: Burst = { burstId: "burst-older", status: "closed", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z", capacitySnapshot: null, candidates: [
        candidate(REPO_A, "trust-layer", { status: "declined", goal: "Old goal", rationale: "Stale." }),
      ] };
      const newest = readyBurst("burst-newest");
      newest.candidates.push(candidate("repoBurstE2E000003", "recorder", { status: "approved", goal: "Record the CLI session", rationale: "Recording is only half wired.", evidence: ["cli/record.mjs", "tests/record.test.mjs"], sizeEstimate: "small", planId: "plan-recorder" }));
      state.bursts = [newest, older];
      openSheet();
      cy.wait("@readBurst").its("request.url").should("include", "/api/bursts/burst-newest");
      sheet().within(() => {
        cy.findByRole("status").should("have.text", "Review each candidate below.");
        cy.get(".burst-candidate").should("have.length", 3);
        cy.contains(".burst-candidate", "trust-layer").within(() => {
          cy.contains("em", "Proposed").should("be.visible");
          cy.findByLabelText("Goal for trust-layer").should("have.value", "Cover the plan store with tests");
          cy.contains("35 server modules have no test file.").should("be.visible");
          cy.contains("code", "server/worktree-plan-store.mjs").should("be.visible");
          cy.contains("Estimated size: medium").should("be.visible");
        });
        cy.contains(".burst-candidate", "ledger").within(() => {
          cy.contains("em", "Scan failed").should("be.visible");
          cy.contains("The scan needs the ccs CLI. Install it, then try again").should("be.visible");
          cy.findByRole("button", { name: "Approve ledger" }).should("not.exist");
          cy.findByRole("button", { name: "Decline ledger" }).should("be.enabled");
          cy.findByRole("button", { name: "Rescan ledger" }).should("be.enabled");
        });
        cy.contains(".burst-candidate", "recorder").within(() => {
          cy.contains("em", "Goal started").should("be.visible");
          cy.contains(".burst-goal", "Record the CLI session").should("be.visible");
          cy.findByRole("button", { name: "Open goal for recorder" }).should("be.visible");
          cy.findByRole("button", { name: "Rescan recorder" }).should("not.exist");
        });
        cy.contains("Old goal").should("not.exist");
        cy.findByRole("button", { name: "Start a new burst" }).should("be.enabled");
      });
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  it("declines a proposed candidate and closes the burst once every candidate is decided", () => {
    cy.viewport(390, 844);
    const state = scenario();
    state.bursts = [readyBurst()];
    cy.intercept("POST", `**/api/bursts/burst-ready/candidates/${REPO_A}/decline`, (request) => {
      expect(request.body).to.deep.equal({});
      const burst = state.bursts[0];
      burst.candidates[0] = { ...burst.candidates[0], status: "declined" };
      request.reply(burst.candidates[0]);
    }).as("declineA");
    cy.intercept("POST", `**/api/bursts/burst-ready/candidates/${REPO_B}/decline`, (request) => {
      const burst = state.bursts[0];
      burst.candidates[1] = { ...burst.candidates[1], status: "declined" };
      burst.status = "closed";
      request.reply(burst.candidates[1]);
    }).as("declineB");
    openSheet();
    cy.wait("@readBurst");
    sheet().findByLabelText("Goal for trust-layer").clear().type("An edit that must not be sent");
    sheet().findByRole("button", { name: "Decline trust-layer" }).click();
    cy.wait("@declineA");
    sheet().contains(".burst-candidate", "trust-layer").within(() => {
      cy.contains("em", "Declined").should("be.visible");
      cy.contains(".burst-goal", "Cover the plan store with tests").should("be.visible");
      cy.findByLabelText("Goal for trust-layer").should("not.exist");
      cy.findByRole("button", { name: "Approve trust-layer" }).should("not.exist");
      cy.findByRole("button", { name: "Rescan trust-layer" }).should("be.enabled");
    });
    sheet().findByRole("button", { name: "Decline ledger" }).click();
    cy.wait("@declineB");
    sheet().contains(".burst-candidate", "ledger").contains("em", "Declined").should("be.visible");
    // The status line reads the burst the sheet holds; the server's closed
    // state arrives with the next read, here by closing and reopening the sheet.
    sheet().findByRole("button", { name: "Close" }).click();
    cy.openBoardTools();
    cy.findByRole("button", { name: "Burst" }).click();
    cy.wait("@readBurst");
    sheet().findByRole("status").should("have.text", "Every candidate is decided.");
  });

  it("rescans a failed candidate, polls while it scans, and replaces the goal with the new proposal", () => {
    cy.viewport(390, 844);
    const state = scenario();
    state.bursts = [readyBurst()];
    let reads = 0;
    cy.intercept("GET", "**/api/bursts/burst-ready", (request) => {
      reads += 1;
      const burst = state.bursts[0];
      if (burst.candidates[1].status === "scanning" && reads >= 3) {
        burst.candidates[1] = { ...burst.candidates[1], status: "proposed", goal: "Reconcile ledger balances nightly", rationale: "Balances drift without a nightly job.", evidence: ["server/ledger.mjs"], sizeEstimate: "large", reason: null };
        burst.status = "ready";
      }
      request.reply(burst);
    }).as("readBurst");
    cy.intercept("POST", `**/api/bursts/burst-ready/candidates/${REPO_B}/rescan`, (request) => {
      const burst = state.bursts[0];
      burst.candidates[1] = { ...burst.candidates[1], status: "scanning", reason: null };
      burst.status = "scanning";
      request.reply(burst.candidates[1]);
    }).as("rescan");
    openSheet();
    cy.wait("@readBurst");
    sheet().findByLabelText("Goal for trust-layer").clear().type("Keep my edit through the rescan");
    sheet().findByRole("button", { name: "Rescan ledger" }).click();
    cy.wait("@rescan").its("request.body").should("deep.equal", {});
    cy.wait("@readBurst");
    sheet().within(() => {
      cy.findByRole("status").should("contain.text", "Scanning starred repositories");
      cy.contains(".burst-candidate", "ledger").should("contain.text", "Reading the repository…");
      cy.contains(".burst-candidate", "ledger").findByRole("button", { name: "Rescan ledger" }).should("not.exist");
    });
    cy.wait("@readBurst", { requestTimeout: 15_000 });
    sheet().within(() => {
      cy.findByLabelText("Goal for ledger").should("have.value", "Reconcile ledger balances nightly");
      cy.contains("Balances drift without a nightly job.").should("be.visible");
      cy.contains("Estimated size: large").should("be.visible");
      cy.findByRole("button", { name: "Approve ledger" }).should("be.enabled");
      cy.findByLabelText("Goal for trust-layer").should("have.value", "Keep my edit through the rescan");
      cy.findByRole("status").should("have.text", "Review each candidate below.");
    });
  });

  it("explains a burst that cannot start and keeps the empty state, then reports no starred repositories", () => {
    cy.viewport(390, 844);
    scenario();
    let attempt = 0;
    cy.intercept("POST", "**/api/bursts", (request) => {
      attempt += 1;
      if (attempt === 1) request.reply({ statusCode: 503, body: { error: "Burst is unavailable" } });
      else request.reply({ status: "no_starred_repositories", message: "Star at least one repository to scan it in a burst.", burstId: null });
    }).as("createBurst");
    openSheet();
    sheet().within(() => {
      cy.contains("No burst yet").should("be.visible");
      cy.findByRole("button", { name: "Start a burst" }).click();
    });
    cy.wait("@createBurst");
    sheet().within(() => {
      cy.findByRole("alert").should("have.text", "Burst is unavailable");
      cy.contains("No burst yet").should("be.visible");
      cy.findByRole("button", { name: "Start a burst" }).should("be.enabled").click();
    });
    cy.wait("@createBurst");
    sheet().within(() => {
      cy.findByRole("alert").should("not.exist");
      cy.findByRole("status").should("have.text", "Star at least one repository to scan it in a burst.");
      cy.get(".burst-candidate").should("not.exist");
    });
    cy.get("@readBurst.all").should("have.length", 0);
  });

  it("keeps the typed goal and the candidate when approving or declining is rejected", () => {
    cy.viewport(390, 844);
    const state = scenario();
    state.bursts = [readyBurst()];
    cy.intercept("POST", `**/api/bursts/burst-ready/candidates/${REPO_A}/approve`, { statusCode: 409, body: { error: "Capacity is exhausted for every provider" } }).as("approve");
    cy.intercept("POST", `**/api/bursts/burst-ready/candidates/${REPO_B}/decline`, { statusCode: 404, body: { error: "Unknown burst" } }).as("decline");
    openSheet();
    cy.wait("@readBurst");
    sheet().findByLabelText("Goal for trust-layer").clear().type("Cover createPlan first");
    sheet().findByRole("button", { name: "Approve trust-layer" }).click();
    cy.wait("@approve").its("request.body").should("deep.equal", { goal: "Cover createPlan first" });
    sheet().within(() => {
      cy.findByRole("alert").should("have.text", "Capacity is exhausted for every provider");
      cy.findByLabelText("Goal for trust-layer").should("have.value", "Cover createPlan first");
      cy.findByRole("button", { name: "Approve trust-layer" }).should("be.enabled");
      cy.findByRole("button", { name: "Decline ledger" }).click();
    });
    cy.wait("@decline");
    sheet().within(() => {
      cy.findByRole("alert").should("have.text", "Unknown burst");
      cy.contains(".burst-candidate", "ledger").contains("em", "Scan failed").should("be.visible");
    });
    // An empty goal cannot be approved at all.
    sheet().findByLabelText("Goal for trust-layer").clear();
    sheet().findByRole("button", { name: "Approve trust-layer" }).should("be.disabled");
  });
});
