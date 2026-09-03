// The GitHub Issues column, driven through the real UI against deterministic
// fixtures. It proves the four acceptance criteria that a person can see:
// the sync reads starred repositories only, the column is leftmost, one card
// starts exactly one goal, and an unstarred estate says so plainly.

const now = "2026-09-03T12:00:00.000Z";

// One starred repository and one that is not. Only the starred one may ever
// contribute a card.
const starred = {
  id: "repositoryStarred01", name: "trust-layer", root: "karven", path: "/Users/test/Developers/karven/trust-layer",
  favorite: true, pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-starred", repoId: "repositoryStarred01", path: "/Users/test/Developers/karven/trust-layer", name: "trust-layer", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};
const plain = { ...starred, id: "repositoryPlain00001", name: "recorder", root: "rekord", path: "/Users/test/Developers/rekord/recorder", favorite: false, worktrees: [], releases: [] };

const starredIssue = {
  repositoryId: starred.id, repositoryName: starred.name, number: 12, title: "Restore the caret",
  labels: ["editor", "bug"], url: "https://github.test/acme/trust-layer/issues/12", updatedAt: now, syncedAt: now, planId: null,
};
// The issue of the repository nobody starred. The sync must never return it,
// and the column must never render it.
const plainIssue = { ...starredIssue, repositoryId: plain.id, repositoryName: plain.name, number: 99, title: "Never synced issue" };

type Column = { issues: Record<string, unknown>[]; plans: Record<string, unknown>[] };

function installBoard(state: Column) {
  const dashboard = {
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 2, worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: [starred, plain], orphanSessions: [],
  };
  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any unfixtured call fails closed.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/goals/health", { checkedAt: now, sessionsAvailable: true, goals: [], summary: { goals: 0, tasks: 0, stuck: 0, needsYou: 0, working: 0, deadTasks: 0, idleTasks: 0, failedTasks: 0 } }).as("health");
  cy.intercept("GET", "**/api/worktree-dashboard*", dashboard).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: state.plans })).as("plans");
  cy.intercept("GET", "**/api/github-issues", (request) => request.reply({ syncedAt: null, issues: state.issues })).as("issues");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

describe("GitHub Sync and the GitHub Issues column", () => {
  it("syncs starred repositories only and renders their issues in the leftmost column", () => {
    const state: Column = { issues: [], plans: [] };
    installBoard(state);
    // The server answers with the starred repository only. The fixture asserts
    // that the reported repository set never contains the unstarred one.
    cy.intercept("POST", "**/api/github-issues/sync", (request) => {
      state.issues = [starredIssue];
      request.reply({
        syncedAt: now, status: "ok", message: null,
        repositories: [{ repositoryId: starred.id, name: starred.name, status: "ok", issueCount: 1, truncated: false, error: null }],
        issues: state.issues,
      });
    }).as("sync");
    visitBoard();

    cy.findByRole("button", { name: "GitHub Sync" }).click();
    cy.wait("@sync").then((interception) => {
      const repositories = (interception.response?.body?.repositories || []) as { repositoryId: string }[];
      expect(repositories.map((repository) => repository.repositoryId)).to.deep.equal([starred.id]);
    });

    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      cy.contains("trust-layer");
      cy.contains("#12");
      cy.contains("Restore the caret");
      cy.contains("editor");
      cy.findByRole("link", { name: "Open #12 on GitHub" }).should("have.attr", "href", starredIssue.url);
      // The unstarred repository's issue never appears.
      cy.contains(plainIssue.title).should("not.exist");
      cy.contains(plain.name).should("not.exist");
    });

    // The column is left of Writing Spec in the board's own DOM order.
    cy.findByRole("region", { name: "Goals board" }).find("section.goal-board-column > header > h3")
      .then((headings) => {
        const labels = [...headings].map((heading) => heading.textContent);
        expect(labels[0]).to.equal("GitHub Issues");
        expect(labels.indexOf("GitHub Issues")).to.be.lessThan(labels.indexOf("Writing Spec"));
      });
  });

  it("starts exactly one goal from one card and moves it into Writing Spec", () => {
    const state: Column = { issues: [starredIssue], plans: [] };
    installBoard(state);
    let goalCalls = 0;
    cy.intercept("POST", `**/api/github-issues/${starred.id}/12/goal`, (request) => {
      goalCalls += 1;
      state.issues = [{ ...starredIssue, planId: "plan-issue-12" }];
      state.plans = [{
        planId: "plan-issue-12", repositoryId: starred.id, repositoryName: starred.name,
        goal: "Resolve GitHub issue #12: Restore the caret", status: "draft", stage: "questions", round: 0,
        taskCount: 0, createdAt: now, updatedAt: now, launchedAt: null, boardState: "writing_spec",
        sourceType: "github_issues", issueNumbers: [12], issueUrls: [starredIssue.url],
      }];
      request.reply({ issue: state.issues[0], plan: { planId: "plan-issue-12" }, created: true });
    }).as("startGoal");
    visitBoard();

    cy.findByRole("button", { name: "Start a goal for #12 Restore the caret" }).click();
    cy.wait("@startGoal").its("request.url").should("match", new RegExp(`/api/github-issues/${starred.id}/12/goal$`));

    cy.findByRole("region", { name: "Writing Spec" }).should("contain.text", "Resolve GitHub issue #12: Restore the caret");
    // The card no longer offers to start the same issue a second time.
    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      cy.findByRole("button", { name: /^Start a goal/ }).should("not.exist");
      cy.findByRole("link", { name: "Goal started for #12" }).should("exist");
    });
    cy.then(() => expect(goalCalls).to.equal(1));
  });

  it("states the reason when no repository is starred, and explains the empty column", () => {
    const state: Column = { issues: [], plans: [] };
    installBoard(state);
    cy.intercept("POST", "**/api/github-issues/sync", {
      syncedAt: now, status: "no_starred_repositories",
      message: "No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.",
      repositories: [], issues: [],
    }).as("sync");
    visitBoard();

    cy.findByRole("region", { name: "GitHub Issues" })
      .should("contain.text", "No GitHub issues yet. Star a repository, then choose GitHub Sync to pull its open issues.");

    cy.findByRole("button", { name: "GitHub Sync" }).click();
    cy.wait("@sync");
    cy.contains("No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.").should("be.visible");
  });
});

export {};
