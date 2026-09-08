// The repository list behind Board tools: favorite and archive a repository,
// remove a worktree (plain, blocked, and the detached-checkout discard path),
// pull request badges, the GitHub freshness line, orphan sessions and opening
// a workspace from a card. The Goals board's read-only guard is covered too.
export {};

const now = "2026-09-08T12:00:00.000Z";
const nowSeconds = Math.round(Date.parse(now) / 1000);

type Session = { id: string; title: string; preview: string; directory: string | null; terminalCount: number; lastActivityAt: number; provider: string; state: { label: string; tone: "attention" | "working" | "done" | "ready" } };
type Worktree = { id: string; repoId: string; path: string; name: string; branch: string; isPrimary: boolean; detached: boolean; locked: string | null; ahead: number; behind: number; changedFiles: number; dirty: boolean; lastActivity: number; pullRequest: Record<string, unknown> | null; sessions: Session[]; state: { label: string; tone: "attention" | "working" | "done" | "ready" } };
type Repository = { id: string; name: string; root: string; path: string; favorite: boolean; archived: boolean; pullRequestsAvailable: boolean; summary: { worktrees: number; releases: number; sessions: number; needsYou: number; working: number; dirty: number }; worktrees: Worktree[]; releases: never[] };

const ledgerSession: Session = { id: "ws-ledger-feature", title: "ledger: feature/exports", preview: "Running the export tests", directory: "/Users/test/Developers/karven/ledger-exports", terminalCount: 1, lastActivityAt: nowSeconds - 120, provider: "claude", state: { label: "Working", tone: "working" } };
const orphan: Session = { id: "ws-scratch", title: "scratch notes", preview: "Waiting for input", directory: "/Users/test/Developers/karven/scratch", terminalCount: 1, lastActivityAt: nowSeconds - 30, provider: "codex", state: { label: "Needs you", tone: "attention" } };

function worktree(repoId: string, id: string, branch: string, extra: Partial<Worktree> = {}): Worktree {
  return { id, repoId, path: `/Users/test/Developers/karven/${id}`, name: id, branch, isPrimary: false, detached: false, locked: null, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: nowSeconds - 3_600, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" }, ...extra };
}

function repositories(): Repository[] {
  const ledger: Repository = { id: "repoLedger00000001", name: "ledger", root: "karven", path: "/Users/test/Developers/karven/ledger", favorite: false, archived: false, pullRequestsAvailable: true,
    summary: { worktrees: 4, releases: 0, sessions: 1, needsYou: 0, working: 1, dirty: 1 }, releases: [],
    worktrees: [
      worktree("repoLedger00000001", "ledger", "main", { isPrimary: true }),
      worktree("repoLedger00000001", "ledger-exports", "feature/exports", { ahead: 3, sessions: [ledgerSession], state: { label: "Working", tone: "working" }, pullRequest: { number: 12, title: "Add CSV exports", url: "https://github.com/karven/ledger/pull/12", isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeState: "CLEAN", checks: { passed: 2, failed: 1, pending: 0, total: 3 } } }),
      worktree("repoLedger00000001", "ledger-done", "feature/done", { behind: 2, pullRequest: { number: 11, title: "Tidy the ledger index", url: "https://github.com/karven/ledger/pull/11", isDraft: false, reviewDecision: "APPROVED", mergeState: "CLEAN", checks: { passed: 4, failed: 0, pending: 0, total: 4 } } }),
      worktree("repoLedger00000001", "ledger-build", "HEAD", { detached: true, dirty: true, changedFiles: 2 }),
    ] };
  const trust: Repository = { id: "repoTrust000000001", name: "trust-layer", root: "karven", path: "/Users/test/Developers/karven/trust-layer", favorite: false, archived: false, pullRequestsAvailable: true,
    summary: { worktrees: 2, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, releases: [],
    worktrees: [
      worktree("repoTrust000000001", "trust-layer", "main", { isPrimary: true }),
      worktree("repoTrust000000001", "trust-locked", "feature/locked", { locked: "release in progress", pullRequest: { number: 7, title: "Pin the signing key", url: "https://github.com/karven/trust-layer/pull/7", isDraft: true, reviewDecision: "", mergeState: "UNKNOWN", checks: { passed: 1, failed: 0, pending: 2, total: 3 } } }),
    ] };
  const archived: Repository = { id: "repoOld0000000001", name: "old-website", root: "karven", path: "/Users/test/Developers/karven/old-website", favorite: false, archived: true, pullRequestsAvailable: false,
    summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 }, releases: [], worktrees: [worktree("repoOld0000000001", "old-website", "main", { isPrimary: true })] };
  return [ledger, trust, archived];
}

function scenario() {
  const state = { repositories: repositories(), github: { checkedAt: null as string | null, status: "not-loaded" as "not-loaded" | "ready" | "partial" }, orphanSessions: [orphan] };
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, refreshedAt: now, workspaces: [
    { id: ledgerSession.id, title: ledgerSession.title, current_directory: ledgerSession.directory, terminals: [{ id: "term-ledger", title: "Claude", is_focused: true }] },
    { id: orphan.id, title: orphan.title, current_directory: orphan.directory, terminals: [{ id: "term-scratch", title: "Codex", is_focused: true }] },
  ] });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/github-issues*", { syncedAt: null, issues: [] });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, available: false, reason: "Local fixture", nextReset: null });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0 } });
  cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [], kept: [], failed: [] });
  cy.intercept("GET", "**/api/worktree-plans*", { plans: [] });
  cy.intercept("GET", "**/api/terminals/*/replay*", { mode: "text", text: "Fixture terminal output" });
  cy.intercept("POST", "**/api/terminals/*/viewport", {});
  cy.intercept("GET", "**/api/goal-sessions/workspace/*", { plan: null });
  cy.intercept("GET", "**/api/worktree-dashboard*", (request) => {
    const repos = state.repositories;
    request.reply({ generatedAt: now, github: state.github, orphanSessions: state.orphanSessions, repositories: repos,
      summary: { repositories: repos.length, worktrees: repos.reduce((sum, repo) => sum + repo.worktrees.length, 0), releases: 0, sessions: 2, needsYou: 1, working: 1, dirty: 1, pullRequests: 3 } });
  }).as("dashboard");
  return state;
}

function visitProjects(tab: "Active" | "Inactive" | "Archived", readOnly = false) {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", String(readOnly)); } });
  cy.wait("@dashboard");
  cy.openBoardTools();
  cy.findByRole("tab", { name: new RegExp(`^${tab}`) }).click();
}

function repositoryCard(name: string) { return cy.contains("details.worktree-repository", name); }
function worktreeCard(branch: string) { return cy.contains(".worktree-card", branch); }

describe("worktree dashboard actions", () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    it(`shows pull request badges, the manual GitHub line and per-tab counts at ${width}px`, () => {
      cy.viewport(width, height);
      const state = scenario();
      visitProjects("Active");
      cy.findByRole("tablist", { name: "Project status" }).within(() => {
        cy.findByRole("tab", { name: /^Active/ }).should("contain.text", "1");
        cy.findByRole("tab", { name: /^Inactive/ }).should("contain.text", "1");
        cy.findByRole("tab", { name: /^Archived/ }).should("contain.text", "1");
      });
      cy.contains("1 shown · 3 total · GitHub refresh is manual").should("be.visible");
      cy.get(".summary-row").should("contain.text", "4").and("contain.text", "worktrees").and("contain.text", "working");
      repositoryCard("ledger").should("contain.text", "4 worktrees · 1 session");
      worktreeCard("feature/exports").within(() => {
        cy.findByRole("link", { name: /PR #12/ }).should("have.attr", "href", "https://github.com/karven/ledger/pull/12").and("have.attr", "target", "_blank").and("have.class", "failed").and("contain.text", "Add CSV exports").and("contain.text", "1 failed");
        cy.contains("↑ 3").should("be.visible");
        cy.contains("1 active session").should("be.visible");
      });
      worktreeCard("feature/done").findByRole("link", { name: /PR #11/ }).should("have.class", "passing").and("contain.text", "4/4 checks");
      worktreeCard("main").should("contain.text", "Primary worktree").findByRole("button", { name: "Remove" }).should("not.exist");
      cy.then(() => { state.github = { checkedAt: now, status: "partial" }; });
      cy.findByRole("button", { name: "Refresh GitHub" }).click();
      cy.wait("@dashboard").its("request.url").should("include", "refresh=1").and("include", "github=1");
      cy.contains(/GitHub checked (just now|\d+[mhd] ago) · partial/).should("be.visible");
      cy.openBoardTools();
      cy.findByRole("tab", { name: /^Inactive/ }).click();
      worktreeCard("feature/locked").findByRole("link", { name: /PR #7/ }).should("have.class", "pending").and("contain.text", "2 pending");
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(width));
    });
  }

  it("favorites an inactive repository into Active and unfavorites it back, one PATCH each", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("PATCH", "**/api/worktree-dashboard/repositories/repoTrust000000001/favorite", (request) => {
      state.repositories[1].favorite = request.body.favorite;
      request.reply({ id: "repoTrust000000001", favorite: request.body.favorite });
    }).as("favorite");
    visitProjects("Inactive");
    repositoryCard("trust-layer").findByRole("button", { name: "Favorite trust-layer" }).should("have.attr", "aria-pressed", "false").click();
    cy.wait("@favorite").its("request.body").should("deep.equal", { favorite: true });
    cy.get(".toast").should("contain.text", "trust-layer favorited");
    cy.contains("details.worktree-repository", "trust-layer").should("not.exist");
    cy.findByRole("tab", { name: /^Inactive/ }).should("contain.text", "0");
    cy.openBoardTools();
    cy.findByRole("tab", { name: /^Active/ }).should("contain.text", "2").click();
    cy.get("details.worktree-repository").first().should("contain.text", "trust-layer");
    repositoryCard("trust-layer").findByRole("button", { name: "Unfavorite trust-layer" }).should("have.attr", "aria-pressed", "true").click();
    cy.wait("@favorite").its("request.body").should("deep.equal", { favorite: false });
    cy.get(".toast").should("contain.text", "trust-layer unfavorited");
    cy.contains("details.worktree-repository", "trust-layer").should("not.exist");
  });

  it("archives a repository, hides its goal actions, and restores it from the Archived tab", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("PATCH", "**/api/worktree-dashboard/repositories/repoTrust000000001/archive", (request) => {
      state.repositories[1].archived = request.body.archived;
      request.reply({ id: "repoTrust000000001", archived: request.body.archived });
    }).as("archive");
    visitProjects("Inactive");
    repositoryCard("trust-layer").findByRole("button", { name: "Plan a goal for trust-layer" }).should("be.visible");
    repositoryCard("trust-layer").findByRole("button", { name: "Archive trust-layer" }).click();
    cy.wait("@archive").its("request.body").should("deep.equal", { archived: true });
    cy.get(".toast").should("contain.text", "trust-layer archived");
    cy.findByText("No inactive Karven projects").should("be.visible");
    cy.openBoardTools();
    cy.findByRole("tab", { name: /^Archived/ }).should("contain.text", "2").click();
    repositoryCard("trust-layer").within(() => {
      cy.findByRole("button", { name: "Plan a goal for trust-layer" }).should("not.exist");
      cy.findByRole("button", { name: "Create worktree for trust-layer" }).should("not.exist");
      cy.findByRole("button", { name: "Unarchive trust-layer" }).click();
    });
    cy.wait("@archive").its("request.body").should("deep.equal", { archived: false });
    cy.get(".toast").should("contain.text", "trust-layer restored");
    cy.contains("details.worktree-repository", "trust-layer").should("not.exist");
    repositoryCard("old-website").should("be.visible");
  });

  it("reports a rejected favorite or archive without changing the list", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("PATCH", "**/api/worktree-dashboard/repositories/repoTrust000000001/favorite", { statusCode: 500, body: { error: "Repository cache is read-only" } }).as("favorite");
    cy.intercept("PATCH", "**/api/worktree-dashboard/repositories/repoTrust000000001/archive", { statusCode: 404, body: { error: "Unknown repository" } }).as("archive");
    visitProjects("Inactive");
    repositoryCard("trust-layer").findByRole("button", { name: "Favorite trust-layer" }).click();
    cy.wait("@favorite");
    cy.get(".toast").should("contain.text", "Repository cache is read-only");
    repositoryCard("trust-layer").findByRole("button", { name: "Favorite trust-layer" }).should("have.attr", "aria-pressed", "false");
    repositoryCard("trust-layer").findByRole("button", { name: "Archive trust-layer" }).click();
    cy.wait("@archive");
    cy.get(".toast").should("contain.text", "Unknown repository");
    repositoryCard("trust-layer").should("be.visible");
    cy.findByRole("tab", { name: /^Inactive/ }).should("contain.text", "1");
  });

  it("removes a clean worktree after confirmation and keeps it on a rejected removal", () => {
    cy.viewport(390, 844);
    const state = scenario();
    let fail = true;
    cy.intercept("DELETE", "**/api/worktree-dashboard/ledger-done", (request) => {
      if (fail) { request.reply({ statusCode: 409, body: { error: "The branch has commits that are not on main" } }); return; }
      state.repositories[0].worktrees = state.repositories[0].worktrees.filter((item) => item.id !== "ledger-done");
      state.repositories[0].summary.worktrees = 3;
      request.reply({ removed: true, branchPreserved: true });
    }).as("remove");
    visitProjects("Active");
    worktreeCard("feature/done").findByRole("button", { name: "Remove" }).click();
    worktreeCard("feature/done").should("contain.text", "Remove local worktree?").and("contain.text", "The Git branch is kept.");
    worktreeCard("feature/done").findByRole("button", { name: "Cancel" }).click();
    cy.get("@remove.all").should("have.length", 0);
    worktreeCard("feature/done").findByRole("button", { name: "Remove" }).click();
    worktreeCard("feature/done").findByRole("button", { name: "Confirm remove" }).click();
    cy.wait("@remove").its("request.url").should("not.include", "discardChanges");
    cy.get(".toast").should("contain.text", "The branch has commits that are not on main");
    worktreeCard("feature/done").within(() => {
      cy.get(".worktree-action-error").should("have.text", "The branch has commits that are not on main");
      cy.findByRole("button", { name: "Confirm remove" }).should("be.visible");
    });
    cy.then(() => { fail = false; });
    worktreeCard("feature/done").findByRole("button", { name: "Confirm remove" }).click();
    cy.wait("@remove");
    cy.wait("@dashboard").its("request.url").should("include", "refresh=1");
    cy.get(".toast").should("contain.text", "Removed worktree. Branch feature/done was kept.");
    cy.contains(".worktree-card", "feature/done").should("not.exist");
    repositoryCard("ledger").should("contain.text", "3 worktrees");
  });

  it("blocks removal while a session is open or the worktree is locked, and discards a detached checkout only after a second confirmation", () => {
    cy.viewport(390, 844);
    const state = scenario();
    cy.intercept("DELETE", "**/api/worktree-dashboard/ledger-build?discardChanges=1", (request) => {
      state.repositories[0].worktrees = state.repositories[0].worktrees.filter((item) => item.id !== "ledger-build");
      request.reply({ removed: true, branchPreserved: false });
    }).as("discard");
    visitProjects("Active");
    worktreeCard("feature/exports").within(() => {
      cy.findByRole("button", { name: "Remove" }).should("not.exist");
      cy.findByLabelText("Actions for feature/exports").click();
      cy.findByRole("button", { name: "Remove worktree" }).should("be.disabled");
      cy.contains("Close active sessions first").should("be.visible");
    });
    worktreeCard("HEAD").within(() => {
      cy.contains("2 changed").should("have.class", "dirty");
      cy.findByRole("button", { name: "Remove" }).should("not.exist");
      cy.findByRole("button", { name: "Remove…" }).click();
      cy.contains("Discard 2 uncommitted changes?").should("be.visible");
      cy.contains("This detached checkout has no branch.").should("be.visible");
      cy.findByRole("button", { name: "Discard and remove" }).click();
    });
    cy.wait("@discard");
    cy.wait("@dashboard");
    cy.get(".toast").should("contain.text", "Removed worktree and discarded its files. Branch HEAD was kept.");
    cy.contains(".worktree-card", "HEAD").should("not.exist");
    cy.openBoardTools();
    cy.findByRole("tab", { name: /^Inactive/ }).click();
    worktreeCard("feature/locked").within(() => {
      cy.contains("Locked").should("be.visible");
      cy.findByLabelText("Actions for feature/locked").click();
      cy.findByRole("button", { name: "Remove worktree" }).should("be.disabled");
      cy.contains("Unlock the worktree first").should("be.visible");
    });
  });

  it("lists orphan sessions under Active only, opens one, and closes one after confirmation", () => {
    cy.viewport(390, 844);
    const state = scenario();
    let answer = false;
    cy.on("window:confirm", (message) => { expect(message).to.equal("Close cmux session “scratch notes”?"); return answer; });
    cy.intercept("POST", "**/api/workspaces/ws-scratch/close", (request) => { state.orphanSessions = []; request.reply({ closed: true }); }).as("close");
    visitProjects("Active");
    cy.get(".orphan-workstreams").should("contain.text", "Other sessions").and("contain.text", "Not inside a catalogued Git worktree").and("contain.text", "scratch notes").and("contain.text", "Waiting for input");
    cy.openBoardTools();
    cy.findByRole("tab", { name: /^Inactive/ }).click();
    cy.get(".orphan-workstreams").should("not.exist");
    cy.openBoardTools();
    cy.findByRole("tab", { name: /^Active/ }).click();
    cy.get(".orphan-workstreams").findByRole("button", { name: "Close session scratch notes" }).click();
    cy.get("@close.all").should("have.length", 0);
    cy.get(".orphan-workstreams").should("contain.text", "scratch notes");
    cy.get(".orphan-workstreams").findByRole("button", { name: /^scratch notes/ }).click();
    cy.location("search").should("eq", "?workspace=ws-scratch");
    cy.contains(".detail-header", "scratch notes").should("be.visible");
    cy.findByRole("button", { name: /Back/ }).click();
    cy.wait("@dashboard");
    cy.openBoardTools();
    cy.findByRole("tab", { name: /^Active/ }).click();
    cy.then(() => { answer = true; });
    cy.get(".orphan-workstreams").findByRole("button", { name: "Close session scratch notes" }).click();
    cy.wait("@close");
    cy.wait("@dashboard");
    cy.get(".toast").should("contain.text", "Closed scratch notes");
    cy.get(".orphan-workstreams").should("not.exist");
  });

  it("opens a worktree's session from its card and says when that session has gone", () => {
    cy.viewport(390, 844);
    scenario();
    visitProjects("Active");
    worktreeCard("feature/exports").findByRole("button", { name: /^ledger: feature\/exports/ }).click();
    cy.location("search").should("eq", "?workspace=ws-ledger-feature");
    cy.contains(".detail-header", "ledger: feature/exports").should("be.visible");
    cy.contains("Fixture terminal output").should("be.visible");
    cy.findByRole("button", { name: /Back/ }).click();
    cy.location("search").should("eq", "?view=sessions");
    cy.findByRole("region", { name: "Goals board" }).should("be.visible");
    // The dashboard still lists the session, but cmux no longer has it open.
    cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, refreshedAt: now, workspaces: [] });
    visitProjects("Active");
    worktreeCard("feature/exports").findByRole("button", { name: /^ledger: feature\/exports/ }).click();
    cy.get(".toast").should("contain.text", "That cmux session is no longer open");
    cy.location("search").should("eq", "?mode=worktrees");
  });

  it("read-only protection disables the board's mutations while leaving reads available", () => {
    cy.viewport(390, 844);
    scenario();
    cy.intercept("GET", "**/api/goals/sessions/retirable*", { sessionsAvailable: true, closed: [{ workspaceId: "ws-old", kind: "task", reason: "Delivered" }], kept: [], failed: [] });
    cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); window.localStorage.setItem("cmux-companion-read-only", "true"); } });
    cy.wait("@dashboard");
    cy.contains("Read-only protection is on. Enable input in Settings to start, abort, relaunch or sync from this board.").should("be.visible");
    cy.openBoardTools();
    cy.findByRole("button", { name: "＋ Worktree" }).should("be.disabled");
    cy.findByRole("button", { name: "GitHub Sync" }).should("be.disabled");
    cy.findByRole("button", { name: "Close 1 finished session" }).should("be.disabled");
    cy.findByRole("button", { name: "Refresh GitHub" }).should("be.enabled");
    cy.findByRole("button", { name: "Burst" }).should("be.enabled");
  });
});
