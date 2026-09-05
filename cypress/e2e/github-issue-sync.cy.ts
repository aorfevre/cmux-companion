// The starred-project GitHub sync, end to end through the real UI against
// deterministic fixtures. It walks the whole path a person sees: star a
// project, press GitHub Sync, read the issue cards in the leftmost column,
// press Start a goal, and find the goal in Writing Spec.
//
// The suite is local-only. No `gh` runs, no cmux runs, and no request leaves
// the fixtures: a catch-all intercept answers 501 for every un-fixtured call,
// so a missing fixture fails the test instead of reaching the installed
// companion through the Vite proxy.

const now = "2026-09-03T12:00:00.000Z";

// The board's server guard accepts an 18-character repository id, so the
// fixtures use ids of exactly that shape.
const STARRED_ID = "repoStarredE2E0001";
const PLAIN_ID = "repoPlainE2E000001";
const SECOND_ID = "repoSecondE2E00001";

// The literal copy of server/github-issue-board.mjs. The spec repeats the
// strings on purpose: it must fail when the visible wording changes, not
// follow the change through a shared import.
const EMPTY_HINT = "No GitHub issues yet. Star a repository, then choose GitHub Sync to pull its open issues.";
const NO_FAVORITES = "No starred repositories. Star a repository first; GitHub Sync reads starred repositories only.";
const NO_FAVORITES_STATUS = "no_starred_repositories";

type Repository = Record<string, unknown> & { id: string; name: string };

function repository(id: string, name: string, favorite: boolean): Repository {
  return {
    id, name, root: "karven", path: `/Users/test/Developers/karven/${name}`,
    favorite, archived: false, pullRequestsAvailable: true,
    summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
    worktrees: [{
      id: `worktree-${id}`, repoId: id, path: `/Users/test/Developers/karven/${name}`, name, branch: "main",
      isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1,
      pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" },
    }],
    releases: [],
  };
}

// One starred repository, one nobody starred, and a second starred one for the
// partial-failure scenario.
const starred = repository(STARRED_ID, "trust-layer", true);
const plain = repository(PLAIN_ID, "recorder", false);
const second = repository(SECOND_ID, "ledger-core", true);

type IssueCard = {
  repositoryId: string; repositoryName: string; number: number; title: string;
  labels: string[]; url: string; updatedAt: string; syncedAt: string; planId: string | null;
};

function issue(source: Repository, number: number, title: string, labels: string[] = []): IssueCard {
  return {
    repositoryId: source.id, repositoryName: source.name, number, title, labels,
    url: `https://github.test/acme/${source.name}/issues/${number}`,
    updatedAt: now, syncedAt: now, planId: null,
  };
}

const caretIssue = issue(starred, 12, "Restore the caret", ["editor", "bug"]);
const scrollIssue = issue(starred, 31, "Keep the scroll position", ["editor"]);
// The issue of the repository nobody starred. It must never reach the sync
// response, and it must never render anywhere on the board.
const unstarredIssue = issue(plain, 99, "Never synced issue", ["ignored"]);
const ledgerIssue = issue(second, 7, "Reconcile the ledger", ["finance"]);

// A synced issue that already carries a plan id. The card reads its started
// state from this field alone.
function started(card: IssueCard, planId: string): IssueCard {
  return { ...card, planId };
}

// One plan summary, in the shape GET /api/worktree-plans returns for a goal
// the planner has only just started. `boardState` places it in Writing Spec.
function writingSpecPlan(card: IssueCard, planId: string) {
  return {
    planId, repositoryId: card.repositoryId, repositoryName: card.repositoryName,
    goal: `Resolve GitHub issue #${card.number}: ${card.title}`,
    status: "draft", stage: "questions", round: 0, taskCount: 0, launchedCount: 0, readyCount: 0,
    agentSplit: { claude: 0, codex: 0 }, workspaceIds: [] as string[], deliveryStatus: "pending",
    boardState: "writing_spec", createdAt: now, updatedAt: now, launchedAt: null,
    sourceType: "github_issues", issueNumbers: [card.number], issueUrls: [card.url],
  };
}

// The mutable fixture state. Every route reads it through a handler, so a test
// can advance the server's answers with `cy.then` and then ask the board to
// re-read them.
type Board = { repositories: Repository[]; issues: IssueCard[]; plans: Record<string, unknown>[] };

function installBoard(state: Board) {
  const dashboard = () => ({
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: state.repositories.length, worktrees: state.repositories.length, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0, pullRequests: 0 },
    repositories: state.repositories, orphanSessions: [],
  });

  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any un-fixtured request, including a future mutation, fails
  // closed instead of escaping to the installed companion.
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
  cy.intercept("GET", "**/api/worktree-dashboard*", (request) => request.reply(dashboard())).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: state.plans })).as("plans");
  // The durable column. The board reads it on every mount, so it is what makes
  // a reload show the last sync without running a new one.
  cy.intercept("GET", "**/api/github-issues", (request) => request.reply({ syncedAt: state.issues.length ? now : null, issues: state.issues })).as("issues");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
}

// The board re-reads the plan list behind Refresh GitHub. Advancing the
// fixture and then pressing it is how a test observes the next server answer.
function refreshBoard() {
  cy.findByRole("button", { name: "Refresh GitHub" }).click();
  cy.wait("@plans");
}

describe("GitHub Sync covers the starred projects end to end", () => {
  it("syncs starred repositories only and renders one card per open issue", () => {
    const state: Board = { repositories: [starred, plain], issues: [], plans: [] };
    installBoard(state);
    // The server answers for the starred repository alone. The unstarred
    // repository is absent from both the repository report and the issues.
    cy.intercept("POST", "**/api/github-issues/sync", (request) => {
      state.issues = [caretIssue, scrollIssue];
      request.reply({
        syncedAt: now, status: "ok", message: null,
        repositories: [{ repositoryId: starred.id, name: starred.name, status: "ok", issueCount: 2, truncated: false, error: null }],
        issues: state.issues,
      });
    }).as("sync");
    visitBoard();

    cy.findByRole("region", { name: "GitHub Issues" }).should("contain.text", EMPTY_HINT);
    cy.findByRole("button", { name: "GitHub Sync" }).click();

    cy.wait("@sync").then((interception) => {
      expect(interception.request.method).to.equal("POST");
      expect(interception.request.url).to.match(/\/api\/github-issues\/sync$/);
      const repositories = (interception.response?.body?.repositories || []) as { repositoryId: string }[];
      // Only the starred repository was ever read.
      expect(repositories.map((entry) => entry.repositoryId)).to.deep.equal([starred.id]);
    });

    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      cy.findByLabelText("2 issues in GitHub Issues").should("exist");
      cy.contains(caretIssue.title).should("be.visible");
      cy.contains(scrollIssue.title).should("be.visible");
      cy.contains("trust-layer").should("be.visible");
      cy.contains("#12").should("be.visible");
      cy.contains("#31").should("be.visible");
      cy.contains("editor").should("be.visible");
      cy.contains("bug").should("be.visible");
      cy.findByRole("link", { name: "Open #12 on GitHub" }).should("have.attr", "href", caretIssue.url);
      // One card per synced issue, and no more.
      cy.findAllByRole("button", { name: /^Start a goal for #/ }).should("have.length", 2);
    });

    // The unstarred repository contributes nothing, anywhere on the board.
    cy.findByRole("region", { name: "Goals board" }).should("not.contain.text", unstarredIssue.title);
    cy.contains(unstarredIssue.title).should("not.exist");
    cy.contains(plain.name).should("not.exist");
  });

  it("places the GitHub Issues column before Writing Spec in the board's DOM order", () => {
    const state: Board = { repositories: [starred, plain], issues: [caretIssue], plans: [] };
    installBoard(state);
    visitBoard();

    cy.findByRole("region", { name: "GitHub Issues" }).should("contain.text", caretIssue.title);
    cy.findByRole("region", { name: "Goals board" }).then(([board]) => {
      const labels = [...board.querySelectorAll("section.goal-board-column > header > h3")]
        .map((heading) => (heading.textContent || "").trim());
      // Leftmost means first in the board's own child order.
      expect(labels[0]).to.equal("GitHub Issues");
      expect(labels.indexOf("GitHub Issues")).to.be.lessThan(labels.indexOf("Writing Spec"));
      expect(labels).to.include("Writing Spec");
    });
  });

  it("starts exactly one goal from one card and moves that goal into Writing Spec", () => {
    const planId = "plan-issue-12";
    const state: Board = { repositories: [starred, plain], issues: [caretIssue, scrollIssue], plans: [] };
    installBoard(state);
    let goalCalls = 0;
    // The route answers with the stored issue and its new plan. It does not
    // publish the plan yet: the test advances the plan list itself, so the
    // assertion reads the server's answer rather than an optimistic guess.
    cy.intercept("POST", `**/api/github-issues/${starred.id}/${caretIssue.number}/goal`, (request) => {
      goalCalls += 1;
      state.issues = [started(caretIssue, planId), scrollIssue];
      request.reply({ issue: state.issues[0], plan: { planId }, created: true });
    }).as("startGoal");
    visitBoard();

    cy.findByRole("button", { name: `Start a goal for #${caretIssue.number} ${caretIssue.title}` }).click();
    cy.wait("@startGoal").then((interception) => {
      expect(interception.request.method).to.equal("POST");
      // The right repository id and the right issue number, and nothing else.
      expect(interception.request.url).to.match(new RegExp(`/api/github-issues/${starred.id}/${caretIssue.number}/goal$`));
    });

    // The plan the route created now reaches the board through its own route.
    cy.then(() => { state.plans = [writingSpecPlan(caretIssue, planId)]; });
    refreshBoard();

    cy.findByRole("region", { name: "Writing Spec" })
      .should("contain.text", `Resolve GitHub issue #${caretIssue.number}: ${caretIssue.title}`);

    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      // The started issue left the column: its goal card carries it now.
      cy.findByRole("button", { name: `Start a goal for #${caretIssue.number} ${caretIssue.title}` }).should("not.exist");
      cy.contains(caretIssue.title).should("not.exist");
      // The other card is untouched and still startable.
      cy.findByRole("button", { name: `Start a goal for #${scrollIssue.number} ${scrollIssue.title}` }).should("exist");
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
    });
    // Exactly one goal was created for that one issue.
    cy.then(() => expect(goalCalls).to.equal(1));
  });

  it("repopulates the column from the stored issues after a reload, with no fresh sync", () => {
    const planId = "plan-issue-12";
    const state: Board = { repositories: [starred, plain], issues: [started(caretIssue, planId), scrollIssue], plans: [writingSpecPlan(caretIssue, planId)] };
    installBoard(state);
    let syncCalls = 0;
    cy.intercept("POST", "**/api/github-issues/sync", (request) => {
      syncCalls += 1;
      request.reply({ syncedAt: now, status: "ok", message: null, repositories: [], issues: state.issues });
    }).as("sync");
    visitBoard();

    cy.findByRole("region", { name: "GitHub Issues" }).should("contain.text", scrollIssue.title);

    // A plain reload. Nothing presses GitHub Sync.
    cy.reload();
    cy.wait(["@dashboard", "@plans", "@health", "@issues"]);
    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      // Only the issue that still needs a goal is here, and the header agrees.
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
      cy.contains(scrollIssue.title).should("be.visible");
      // The started state survives the reload, because it is stored.
      cy.contains(caretIssue.title).should("not.exist");
      cy.findByRole("button", { name: `Start a goal for #${caretIssue.number} ${caretIssue.title}` }).should("not.exist");
    });
    cy.findByRole("region", { name: "Writing Spec" }).should("contain.text", `Resolve GitHub issue #${caretIssue.number}: ${caretIssue.title}`);
    // The column came from GET alone. No sync ran.
    cy.then(() => expect(syncCalls).to.equal(0));
  });

  it("renders the healthy repository's cards and reports the repository that failed", () => {
    const state: Board = { repositories: [starred, second], issues: [], plans: [] };
    installBoard(state);
    const failure = "gh: could not read the issue list for this repository";
    cy.intercept("POST", "**/api/github-issues/sync", (request) => {
      // One starred repository answered, the other failed. The failure never
      // aborts the sync, so the healthy repository still produces cards.
      state.issues = [ledgerIssue];
      request.reply({
        syncedAt: now, status: "ok", message: null,
        repositories: [
          { repositoryId: second.id, name: second.name, status: "ok", issueCount: 1, truncated: false, error: null },
          { repositoryId: starred.id, name: starred.name, status: "failed", issueCount: 0, truncated: false, error: failure },
        ],
        issues: state.issues,
      });
    }).as("sync");
    visitBoard();

    cy.findByRole("button", { name: "GitHub Sync" }).click();
    cy.wait("@sync");

    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      cy.findByLabelText("1 issue in GitHub Issues").should("exist");
      cy.contains(ledgerIssue.title).should("be.visible");
      cy.contains(second.name).should("be.visible");
      cy.findByRole("button", { name: `Start a goal for #${ledgerIssue.number} ${ledgerIssue.title}` }).should("exist");
    });

    // The failure is surfaced, named by repository and reason.
    cy.contains(`GitHub Sync could not read 1 starred repository: ${starred.name} (${failure})`).should("be.visible");
  });

  it("states the reason when no repository is starred instead of doing nothing visible", () => {
    const state: Board = { repositories: [plain], issues: [], plans: [] };
    installBoard(state);
    cy.intercept("POST", "**/api/github-issues/sync", {
      syncedAt: now, status: NO_FAVORITES_STATUS, message: NO_FAVORITES, repositories: [], issues: [],
    }).as("sync");
    visitBoard();

    cy.findByRole("region", { name: "GitHub Issues" }).should("contain.text", EMPTY_HINT);
    cy.findByRole("button", { name: "GitHub Sync" }).click();
    cy.wait("@sync");

    cy.contains(NO_FAVORITES).should("be.visible");
    // The empty column keeps explaining how to fill it.
    cy.findByRole("region", { name: "GitHub Issues" }).within(() => {
      cy.findByLabelText("0 issues in GitHub Issues").should("exist");
      cy.contains(EMPTY_HINT).should("be.visible");
      cy.findByRole("button", { name: /^Start a goal for #/ }).should("not.exist");
    });
  });
});

export {};
