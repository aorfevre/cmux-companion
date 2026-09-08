// Burst, end to end through the real UI against deterministic fixtures: the
// capacity banner appears, Start a burst creates one, the sheet polls until
// the scan settles, and Approve starts a goal session. No gh, no cmux, no ccs.
export {};

const now = "2026-09-08T12:00:00.000Z";
const REPO_A = "repoBurstE2E000001";
const REPO_B = "repoBurstE2E000002";

function repository(id: string, name: string) {
  return { id, name, root: "karven", path: `/Users/test/Developers/karven/${name}`, favorite: true, archived: false, pullRequestsAvailable: true,
    summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
    worktrees: [{ id: `wt-${id}`, repoId: id, path: `/Users/test/Developers/karven/${name}`, name, branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }], releases: [] };
}

const weekly = { cadence: "weekly", label: "Weekly", remainingPercent: 55, resetAt: "2026-09-09T06:00:00.000Z" };
const capacity = { available: true, next: "claude", reason: "Claude has the most reported headroom.", nextReset: weekly.resetAt, state: "eligible",
  providers: [{ id: "claude", label: "Claude", available: true, headroom: 55, bestPercent: 55, resetAt: weekly.resetAt, accounts: [{ id: "acc", label: "Work", status: "ready", paused: false, updatedAt: now, freshness: "fresh", eligibility: "eligible", headroom: 55, windows: [weekly], opportunity: weekly }] }] };

function scenario() {
  const state = { burst: null as null | Record<string, unknown>, polls: 0, starts: [] as unknown[] };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing local fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", capacity);
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { count: 0, sessions: [] });
  cy.intercept("GET", "**/api/worktree-dashboard*", { generatedAt: now, github: { status: "ready" }, summary: { repositories: 2, worktrees: 2, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, repositories: [repository(REPO_A, "trust-layer"), repository(REPO_B, "ledger")], orphanSessions: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/settings/models", { roles: {}, defaults: {}, warning: null });
  cy.intercept("GET", "**/api/bursts", (request) => request.reply({ bursts: state.burst ? [state.burst] : [] })).as("listBursts");
  cy.intercept("POST", "**/api/bursts", (request) => {
    state.burst = { burstId: "burst-e2e", status: "scanning", createdAt: now, updatedAt: now, capacitySnapshot: capacity,
      candidates: [
        { repositoryId: REPO_A, repositoryName: "trust-layer", goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "scanning", reason: null, planId: null, updatedAt: now },
        { repositoryId: REPO_B, repositoryName: "ledger", goal: null, rationale: null, evidence: [], sizeEstimate: null, status: "scanning", reason: null, planId: null, updatedAt: now },
      ] };
    request.reply({ statusCode: 201, body: state.burst });
  }).as("createBurst");
  cy.intercept("GET", "**/api/bursts/burst-e2e", (request) => {
    state.polls += 1;
    if (state.polls >= 2 && state.burst && state.burst.status === "scanning") {
      const candidates = state.burst.candidates as Record<string, unknown>[];
      candidates[0] = { ...candidates[0], status: "proposed", goal: "Cover the plan store with tests", rationale: "35 server modules have no test file.", evidence: ["server/worktree-plan-store.mjs"], sizeEstimate: "medium" };
      candidates[1] = { ...candidates[1], status: "failed", reason: "The scan needs the ccs CLI. Install it, then try again" };
      state.burst = { ...state.burst, status: "ready" };
    }
    request.reply(state.burst as Record<string, unknown>);
  }).as("readBurst");
  cy.intercept("POST", `**/api/bursts/burst-e2e/candidates/${REPO_A}/approve`, (request) => {
    state.starts.push(request.body);
    const candidates = state.burst!.candidates as Record<string, unknown>[];
    candidates[0] = { ...candidates[0], status: "approved", planId: "plan-e2e", goal: request.body.goal };
    request.reply(candidates[0]);
  }).as("approve");
  return state;
}

describe("burst plan", () => {
  it("starts from the capacity banner, reviews candidates and approves one", () => {
    const state = scenario();
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "false"); } });
    cy.findByRole("region", { name: "Burst opportunity" }).should("be.visible");
    cy.findByRole("button", { name: "Start a burst" }).click();
    cy.wait("@createBurst");
    cy.findByRole("dialog", { name: "Burst plan" }).should("be.visible");
    cy.contains("Scanning starred repositories").should("be.visible");
    cy.wait("@readBurst");
    cy.wait("@readBurst");
    cy.findByDisplayValue("Cover the plan store with tests").should("be.visible");
    cy.findByText("The scan needs the ccs CLI. Install it, then try again").should("be.visible");
    cy.findByLabelText("Goal for trust-layer").clear().type("Cover the plan store with tests, starting with createPlan");
    cy.findByRole("button", { name: "Approve trust-layer" }).click();
    cy.wait("@approve").then(() => expect(state.starts[0]).to.deep.equal({ goal: "Cover the plan store with tests, starting with createPlan" }));
    cy.findByRole("button", { name: "Open goal for trust-layer" }).should("be.visible");
    cy.findByRole("button", { name: "Rescan ledger" }).should("be.enabled");
  });

  it("read-only mode disables every burst decision", () => {
    const state = scenario();
    state.burst = { burstId: "burst-e2e", status: "ready", createdAt: now, updatedAt: now, capacitySnapshot: null,
      candidates: [{ repositoryId: REPO_A, repositoryName: "trust-layer", goal: "g", rationale: "r", evidence: [], sizeEstimate: "small", status: "proposed", reason: null, planId: null, updatedAt: now }] };
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "true"); } });
    cy.findByText("Board tools").click();
    cy.findByRole("button", { name: "Burst" }).click();
    cy.findByRole("button", { name: "Approve trust-layer" }).should("be.disabled");
    cy.findByRole("button", { name: "Decline trust-layer" }).should("be.disabled");
    cy.contains("Enable input in Settings").should("be.visible");
  });
});
