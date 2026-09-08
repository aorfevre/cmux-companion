type Session = { id: string; title: string; effective: string };

const now = "2026-09-03T12:00:00.000Z";
const repository = {
  id: "repo-e2e", name: "cmux-e2e-cypress", root: "karven", path: "/Users/test/Developers/karven/cmux-e2e-cypress",
  pullRequestsAvailable: true,
  summary: { worktrees: 1, releases: 0, sessions: 0, needsYou: 0, working: 0, dirty: 0 },
  worktrees: [{ id: "worktree-e2e", repoId: "repo-e2e", path: "/Users/test/Developers/karven/cmux-e2e-cypress", name: "cmux-e2e-cypress", branch: "main", isPrimary: true, detached: false, ahead: 0, behind: 0, changedFiles: 0, dirty: false, lastActivity: 1, pullRequest: null, sessions: [], state: { label: "No session", tone: "ready" } }],
  releases: [],
};

function task(id: string, health: string, session: Session | null, overrides: Record<string, unknown> = {}) {
  return {
    id, title: id === "T1" ? "Implement the fixture" : "Verify the fixture", branch: `e2e/${id.toLowerCase()}`,
    agent: id === "T1" ? "codex" : "claude", wave: 0, launchStatus: "launched", launchError: null,
    deliveryStatus: health === "ready" ? "ready" : "pending", workspaceId: session?.id || null,
    health, reason: health === "working" ? "This task agent is running" : health === "ready" ? "This task pushed its evidence and waits for the merge" : health === "needs_you" ? "This task agent is waiting for an answer" : "This task session is no longer open in cmux",
    session: session ? { id: session.id, title: session.title, lastActivityAt: Date.parse(now), effective: session.effective } : null,
    ...overrides,
  };
}

function plan(id: string, goal: string, count: number, overrides: Record<string, unknown> = {}) {
  return {
    planId: id, repositoryId: "repo-e2e", repositoryName: "cmux-e2e-cypress", goal,
    status: "launched", stage: "ready", round: 1, taskCount: count, launchedCount: count, readyCount: 0,
    agentSplit: { claude: count === 2 ? 1 : 0, codex: 1 }, workspaceIds: [] as string[], deliveryStatus: "implementing",
    boardState: "dev_in_progress", createdAt: now, updatedAt: now, launchedAt: now,
    ...overrides,
  };
}

function healthGoal(source: ReturnType<typeof plan>, tasks: ReturnType<typeof task>[], overrides: Record<string, unknown> = {}) {
  return {
    planId: source.planId, goal: source.goal, repositoryId: source.repositoryId, repositoryName: source.repositoryName,
    health: tasks.some((item) => item.health === "dead") ? "dead" : tasks.some((item) => item.health === "needs_you") ? "needs_you" : tasks.every((item) => item.health === "ready") ? "ready" : "working",
    stuckCount: tasks.filter((item) => item.health === "dead").length, readyCount: tasks.filter((item) => item.health === "ready").length,
    launchedCount: tasks.length, taskCount: tasks.length, deliveryStatus: source.deliveryStatus, merge: null, tasks,
    ...overrides,
  };
}

type Scenario = {
  plans: Array<ReturnType<typeof plan> & Record<string, unknown>>;
  goals: Array<ReturnType<typeof healthGoal> & Record<string, unknown>>;
  liveSessions: number;
};

function installScenario(state: Scenario) {
  const dashboard = () => ({
    generatedAt: now, github: { checkedAt: now, status: "ready" },
    summary: { repositories: 1, worktrees: 1, releases: 0, sessions: state.liveSessions, needsYou: 0, working: state.liveSessions, dirty: 0, pullRequests: 0 },
    repositories: [{ ...repository, summary: { ...repository.summary, sessions: state.liveSessions, working: state.liveSessions } }], orphanSessions: [],
  });
  const health = () => ({
    checkedAt: now, sessionsAvailable: true, goals: state.goals,
    summary: { goals: state.goals.length, tasks: state.goals.reduce((sum, goal) => sum + goal.tasks.length, 0), stuck: state.goals.filter((goal) => ["dead", "idle", "failed"].includes(goal.health)).length, needsYou: state.goals.filter((goal) => goal.health === "needs_you").length, working: state.goals.filter((goal) => goal.health === "working").length, deadTasks: 0, idleTasks: 0, failedTasks: 0 },
  });

  // Registered first so the explicit routes below win Cypress's reverse-order
  // matching. Any missing fixture, including a future mutation, fails closed
  // instead of escaping through Vite's proxy to the installed Companion.
  cy.intercept("**/api/**", { statusCode: 501, body: { error: "Missing deterministic Cypress API fixture" } });
  cy.intercept("GET", "**/api/auth/status", { paired: true });
  cy.intercept("GET", "**/api/bootstrap", { connected: true, host: { mac_display_name: "E2E Mac" }, workspaces: [], error: null, refreshedAt: now });
  cy.intercept("GET", "**/api/inbox", { items: [], actionableCount: 0, unreadCount: 0 });
  cy.intercept("GET", "**/api/repos", { repos: [] });
  cy.intercept("GET", "**/api/prompt-queue*", { items: [] });
  cy.intercept("GET", "**/api/updater/status", { available: false });
  cy.intercept("GET", "**/api/health", { version: { builtAt: now } });
  cy.intercept("GET", "**/api/goals/capacity*", { providers: [], next: null, reason: "Local fixture", nextReset: null, available: false });
  cy.intercept("GET", "**/api/worktree-dashboard*", (request) => request.reply(dashboard())).as("dashboard");
  cy.intercept("GET", "**/api/worktree-plans*", (request) => request.reply({ plans: state.plans })).as("plans");
  cy.intercept("GET", "**/api/goals/health", (request) => request.reply(health())).as("health");
}

function visitBoard() {
  cy.visit("/?mode=worktrees", { onBeforeLoad(window) { window.localStorage.setItem("cmux-companion-home-mode", "worktrees"); } });
  cy.wait(["@dashboard", "@plans", "@health"]);
  cy.findByRole("region", { name: "Goals board" }).should("be.visible");
  cy.findByRole("button", { name: "Expand Blocked" }).click();
}

describe("goal board matches live cmux evidence", () => {
  for (const entry of ["dashboard", "settings"] as const) {
    it(`reviews worktree cleanup from ${entry}, protects unsafe rows, and records a manual run without enabling automation`, () => {
      const state: Scenario = { plans: [], goals: [], liveSessions: 0 };
      installScenario(state);
      const policy = { enabled: false, intervalHours: 24, graceDays: 7, pruneEnabled: false, pruneGraceDays: 30 };
      const history: Array<Record<string, unknown>> = [];
      cy.intercept("GET", "**/api/worktree-cleanup", (request) => request.reply({ policy, history })).as("cleanupStatus");
      cy.intercept("PATCH", "**/api/worktree-cleanup", (request) => { Object.assign(policy, request.body); request.reply({ policy }); }).as("cleanupConfig");
      cy.intercept("POST", "**/api/worktree-cleanup/preview", {
        previewId: "reviewed", summary: { candidates: 1, protected: 2, estimatedBytes: 1024 ** 3 }, errors: [], prune: [],
        entries: [
          { id: "done", path: "/fixture/merged-goal", branch: "goal/done", classification: "development", eligible: true, reasons: ["Goal PR #12 is merged; this exact work is delivered"], estimatedBytes: 1024 ** 3 },
          { id: "dirty", path: "/fixture/dirty", branch: "feature/dirty", classification: "development", eligible: false, reasons: ["Tracked changes or untracked files would be lost"], estimatedBytes: null },
          { id: "release", path: "/fixture/releases/current", branch: null, classification: "managed-release", eligible: false, reasons: ["Managed release: retention belongs to the updater"], estimatedBytes: null },
        ],
      }).as("cleanupPreview");
      cy.intercept("POST", "**/api/worktree-cleanup/run", (request) => {
        expect(request.body).to.deep.equal({ previewId: "reviewed", ids: ["done"], prune: [] });
        const result = { at: now, estimatedReclaimedBytes: 1024 ** 3, results: [{ path: "/fixture/merged-goal", outcome: "removed" }] };
        history.unshift(result); request.reply(result);
      }).as("cleanupRun");
      if (entry === "settings") {
        cy.visit("/?view=settings");
        cy.findByRole("heading", { name: /^Settings$/ }).should("be.visible");
      } else {
        visitBoard();
        cy.findByRole("button", { name: "Worktree cleanup" }).should("not.exist");
        cy.findByRole("button", { name: /^Settings$/ }).click();
      }
      cy.findByRole("button", { name: "Worktree cleanup" }).click();
      cy.wait("@cleanupStatus");
      cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).should("not.be.checked");
      cy.findByRole("button", { name: "Preview cleanup" }).click();
      cy.wait("@cleanupPreview");
      cy.findByRole("region", { name: "Worktree cleanup" }).within(() => {
        cy.contains("1 eligible · 2 protected");
        cy.contains("Goal PR #12 is merged");
        cy.findByRole("button", { name: "Run cleanup" }).should("be.disabled");
        cy.findByRole("checkbox", { name: "Select /fixture/dirty" }).should("be.disabled");
        cy.findByRole("checkbox", { name: "Select /fixture/releases/current" }).should("be.disabled");
        cy.findByRole("checkbox", { name: "Select /fixture/merged-goal" }).check();
        cy.findByRole("button", { name: "Run cleanup" }).click();
      });
      cy.wait("@cleanupRun");
      cy.contains("1 worktrees removed; 0 skipped or failed.").should("be.visible");
      cy.contains("Cleanup history (1)").click();
      cy.contains("removed: /fixture/merged-goal").should("be.visible");
      cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).should("not.be.checked");
      cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).check();
      cy.wait("@cleanupConfig").its("request.body").should("deep.equal", { enabled: true });
      cy.findByRole("checkbox", { name: "Enable automatic development worktree deletion" }).uncheck();
      cy.wait("@cleanupConfig").its("request.body").should("deep.equal", { enabled: false });
    });

  }

  it("shows updater release retention separately with current and rollback protected", () => {
    installScenario({ plans: [], goals: [], liveSessions: 0 });
    cy.intercept("GET", "**/api/worktree-cleanup", { policy: { enabled: false, intervalHours: 24, graceDays: 7, pruneEnabled: false, pruneGraceDays: 30 }, history: [] });
    cy.intercept("GET", "**/api/worktree-cleanup/releases", { policy: { enabled: false, intervalHours: 24 }, history: [] });
    cy.intercept("POST", "**/api/worktree-cleanup/releases/preview", { previewId: "releases", errors: [], entries: [
      { path: "/fixture/release-current", target: "companion", sha: "current-sha", eligible: false, reasons: ["Current release"], estimatedBytes: null },
      { path: "/fixture/release-old", target: "companion", sha: "old-sha", eligible: true, reasons: ["Verified updater-owned release exceeds retention"], estimatedBytes: 1024 ** 3 },
    ] });
    cy.intercept("POST", "**/api/worktree-cleanup/releases/run", (request) => { expect(request.body).to.deep.equal({ previewId: "releases", ids: ["/fixture/release-old"] }); request.reply({ results: [] }); }).as("releaseRun");
    visitBoard();
    cy.findByRole("button", { name: /^Settings$/ }).click();
    cy.findByRole("heading", { name: /^Settings$/ }).should("be.visible");
    cy.findByRole("button", { name: "Worktree cleanup" }).click();
    cy.contains("Managed release retention (updater)").click();
    cy.findByRole("checkbox", { name: "Enable automatic release deletion" }).should("not.be.checked");
    cy.findByRole("button", { name: "Preview release retention" }).click();
    cy.findByRole("checkbox", { name: "Select release current-sha" }).should("be.disabled");
    cy.findByRole("checkbox", { name: "Select release old-sha" }).check();
    cy.findByRole("button", { name: "Run release cleanup" }).click();
    cy.wait("@releaseRun");
    cy.findByRole("checkbox", { name: "Enable automatic release deletion" }).should("not.be.checked");
  });

  it("removes a repaired launch failure when the recovered goal resumes integration", () => {
    const source = plan("goal-recovered", "Recover existing task work", 1, {
      launchedCount: 0, health: "failed", boardState: "blocked", stuckCount: 1,
      healthReason: "That branch already has a worktree with a running session",
    });
    const state: Scenario = { plans: [source], goals: [healthGoal(source, [
      task("T1", "failed", null, { launchStatus: "failed", reason: "That branch already has a worktree with a running session" }),
    ], { health: "failed", stuckCount: 1 })], liveSessions: 1 };
    installScenario(state);
    visitBoard();
    cy.findByRole("region", { name: "Blocked" }).should("contain.text", "Recover existing task work");
    const recovered = { ...source, launchedCount: 1, readyCount: 1, health: "working", boardState: "dev_in_progress", stuckCount: 0,
      healthReason: "The merge agent is running", deliveryStatus: "assembling", mergeStatus: "running", mergeWorkspaceId: "merge-recovered" };
    cy.then(() => {
      state.plans = [recovered];
      state.goals = [healthGoal(recovered, [task("T1", "ready", { id: "existing-task", title: "Existing task", effective: "todo" })],
        { health: "working", stuckCount: 0, merge: { id: "merge", kind: "merge", workspaceId: "merge-recovered", health: "working",
          reason: "The merge agent is running", session: { id: "merge-recovered", title: "Goal merge", effective: "working" } } })];
      state.liveSessions = 2;
    });
    cy.openBoardTools();
    cy.findByRole("button", { name: "Refresh GitHub" }).click();
    cy.wait("@plans");
    cy.findByRole("region", { name: "Blocked" }).should("not.contain.text", "Recover existing task work");
    cy.findByRole("region", { name: "Dev in progress" }).should("contain.text", "Recover existing task work");
    cy.contains("That branch already has a worktree with a running session").should("not.exist");
  });

  it("clears a stale lock failure after the watchdog observes the delivery PR", () => {
    const source = plan("goal-lock", "Delivery recovered automatically", 1, {
      health: "failed", boardState: "blocked", stuckCount: 1, deliveryStatus: "blocked", mergeStatus: "blocked",
      deliveryError: "Another worktree operation holds this lock", healthReason: "Another worktree operation holds this lock",
    });
    const state: Scenario = { plans: [source], goals: [healthGoal(source, [], { health: "failed", stuckCount: 1 })], liveSessions: 0 };
    installScenario(state);
    visitBoard();
    cy.findByRole("region", { name: "Blocked" }).should("contain.text", source.goal);
    cy.then(() => {
      state.plans = [{ ...source, health: "ready", boardState: "waiting_for_merge", stuckCount: 0,
        deliveryStatus: "pr_open", mergeStatus: "done", deliveryError: null, healthReason: "The goal pull request is open",
        boardPrState: "OPEN", boardPrNumber: 73, boardPrUrl: "https://github.test/pull/73" }];
      state.goals = [];
    });
    cy.reload();
    cy.wait(["@plans", "@health"]);
    cy.findByRole("region", { name: "Waiting for merge" }).should("contain.text", source.goal);
    cy.findByRole("region", { name: "Blocked" }).should("not.contain.text", source.goal);
    cy.contains("Another worktree operation holds this lock").should("not.exist");
  });

  it("launches one multi-action follow-up from a Waiting for merge card", () => {
    const goal = "Review the open delivery";
    const waitingMerge = plan("goal-followup", goal, 1, {
      readyCount: 1,
      health: "ready",
      deliveryStatus: "pr_open",
      boardPrState: "OPEN",
      boardPrNumber: 19,
      boardPrUrl: "https://github.test/pull/19",
      boardState: "waiting_for_merge",
    });
    const state: Scenario = { plans: [waitingMerge], goals: [], liveSessions: 0 };
    installScenario(state);
    cy.intercept("POST", "**/api/worktree-plans/goal-followup/followups", (request) => {
      expect(request.body).to.deep.equal({ actions: ["question", "review"], question: "Which edge cases remain?", agent: "codex" });
      request.reply({ planId: "goal-followup", workspaceId: "ws-followup", agent: "codex", actions: ["question", "review"], branch: "goal/open-delivery", worktreePath: "/Users/test/goal-open-delivery", pullRequest: { number: 19, url: "https://github.test/pull/19" }, title: "Follow up" });
    }).as("followup");
    visitBoard();

    cy.findByRole("region", { name: "Waiting for merge" }).within(() => {
      cy.findByRole("button", { name: `More actions for ${goal}` }).click();
    });
    cy.findByRole("dialog", { name: `More actions for ${goal}` }).within(() => {
      for (const label of ["Ask a question", "More unit and e2e tests", "Complete code review", "Something else"]) cy.contains(label);
      cy.findByRole("checkbox", { name: /^Ask a question/ }).click();
      cy.findByRole("textbox", { name: "Ask a question details" }).type("Which edge cases remain?");
      cy.findByRole("checkbox", { name: /^Complete code review/ }).click();
      cy.findByRole("radio", { name: "Codex" }).click();
      cy.findByRole("button", { name: "Submit follow-up" }).click();
    });
    cy.wait("@followup");
    cy.findByRole("dialog", { name: `More actions for ${goal}` }).should("not.exist");
    cy.get("@followup.all").should("have.length", 1);
  });

  it("moves one goal through every successful Kanban column", () => {
    const goal = "Kanban lifecycle fixture";
    const writing = plan("goal-kanban", goal, 0, { status: "draft", stage: "questions", round: 0, taskCount: 0, launchedCount: 0, running: true, runStage: "writing_spec", runStep: "Reading the repository…", boardState: "writing_spec" });
    const state: Scenario = { plans: [writing], goals: [], liveSessions: 0 };
    installScenario(state);
    visitBoard();

    const expectColumn = (name: string) => cy.findByRole("region", { name }).should("contain.text", goal);
    const advance = (next: ReturnType<typeof plan>, goals: ReturnType<typeof healthGoal>[] = [], liveSessions = 0) => {
      cy.then(() => { state.plans = [next]; state.goals = goals; state.liveSessions = liveSessions; });
      cy.openBoardTools();
      cy.findByRole("button", { name: "Refresh GitHub" }).click();
      cy.wait("@plans");
    };

    expectColumn("Writing Spec");
    const review = { ...writing, running: true, runStage: "review_spec", runStep: "Reviewing the specification…", boardState: "review_spec" };
    advance(review);
    expectColumn("Review Spec");

    const waiting = plan("goal-kanban", goal, 1, { status: "draft", stage: "ready", running: false, boardState: "waiting_for_dev" });
    advance(waiting);
    expectColumn("Waiting for dev");

    const session = { id: "ws-kanban", title: "E2E · Kanban lifecycle (kanb) · T1-code · Implement fixture", effective: "working" };
    const developing = plan("goal-kanban", goal, 1, { workspaceIds: [session.id], health: "working", boardState: "dev_in_progress" });
    advance(developing, [healthGoal(developing, [task("T1", "working", session)])], 1);
    expectColumn("Dev in progress");

    const waitingMerge = plan("goal-kanban", goal, 1, { workspaceIds: [], mergeWorkspaceId: null, readyCount: 1, health: "ready", deliveryStatus: "pr_open", boardPrState: "OPEN", boardPrNumber: 7, boardPrUrl: "https://github.test/pull/7", boardState: "waiting_for_merge" });
    advance(waitingMerge, [healthGoal(waitingMerge, [task("T1", "ready", null)], { health: "ready", readyCount: 1 })], 0);
    expectColumn("Waiting for merge");
    cy.findByLabelText("0 live cmux sessions").should("exist");
    cy.findByRole("button", { name: `Open ${goal} in cmux` }).should("not.exist");

    const merged = { ...waitingMerge, health: null, boardStatus: "merged", boardPrState: "MERGED", boardState: "merged" };
    advance(merged);
    cy.findByRole("button", { name: "Expand Merged" }).click();
    expectColumn("Merged");
    cy.findAllByText(goal).should("have.length", 1);
  });

  it("moves a one-task goal from working to blocked on the next local poll", () => {
    // A goal text long enough to be clipped by the generator's own budget, so
    // the parser meets a realistic title rather than a short one.
    const live = { id: "ws-one", title: "E2E · One task lifecycle across the whole boa… (one) · T1-code · Implement the fixture", effective: "working" };
    const source = plan("goal-one", "One task lifecycle", 1, { workspaceIds: [live.id], health: "working" });
    const state: Scenario = { plans: [source], goals: [healthGoal(source, [task("T1", "working", live)])], liveSessions: 1 };
    installScenario(state);
    visitBoard();

    cy.findByRole("region", { name: "Dev in progress" }).should("contain.text", "One task lifecycle");
    cy.findByLabelText("1 live cmux sessions").should("exist");
    cy.findByLabelText("T1-code: Implement the fixture").should("exist");

    cy.then(() => {
      state.liveSessions = 0;
      state.plans = [{ ...source, boardState: "blocked", health: "dead", healthReason: "This task session is no longer open in cmux", stuckCount: 1 }];
      state.goals = [healthGoal(source, [task("T1", "dead", null)], { health: "dead", stuckCount: 1 })];
    });
    cy.wait(10_500);

    cy.findByRole("region", { name: "Blocked" }).should("contain.text", "One task lifecycle");
    cy.findByRole("button", { name: "1 stuck goals. Show the tasks that need you" }).should("exist");
    cy.findByRole("region", { name: "Goals needing attention" }).should("contain.text", "This task session is no longer open in cmux");
    cy.findByLabelText("0 live cmux sessions").should("exist");
  });

  it("shows a two-task blocked merge as stuck and opens the real merge workspace", () => {
    // Another legacy-shape session, kept to prove the two shapes coexist.
    const taskSession = { id: "ws-task", title: "E2E-T1-code · Implement the fixture", effective: "todo" };
    const mergeSession = { id: "ws-merge", title: "E2E · Two task merge lifecycle (two) · MERGE", effective: "todo" };
    const source = plan("goal-two", "Two task merge lifecycle", 2, {
      deliveryStatus: "blocked", deliveryError: "The merge agent stopped before opening the pull request", mergeStatus: "blocked", mergeWorkspaceId: mergeSession.id,
      readyCount: 2, workspaceIds: [taskSession.id, mergeSession.id], health: "failed", healthReason: "The merge agent stopped before opening the pull request", boardState: "blocked", stuckCount: 1,
    });
    const tasks = [task("T1", "ready", taskSession), task("T2", "ready", null)];
    const merge = { id: "merge", kind: "merge", title: "Goal merge", workspaceId: mergeSession.id, health: "failed", reason: "The merge agent stopped before opening the pull request", session: { id: mergeSession.id, title: mergeSession.title, lastActivityAt: Date.parse(now), effective: "todo" }, observedHealth: "working" };
    const state = { plans: [source], goals: [healthGoal(source, tasks, { health: "failed", stuckCount: 1, merge })], liveSessions: 2 };
    installScenario(state);
    cy.intercept("POST", "**/api/workspaces/ws-merge/select", { selected: true }).as("selectMerge");
    visitBoard();

    cy.findByRole("region", { name: "Blocked" }).within(() => {
      cy.contains("Two task merge lifecycle");
      cy.findByLabelText("2 of 2 launched tasks ready").should("exist");
      cy.contains("The merge agent stopped before opening the pull request");
      cy.findByRole("button", { name: "Open Two task merge lifecycle in cmux" }).click();
    });
    cy.wait("@selectMerge").its("request.url").should("match", /\/api\/workspaces\/ws-merge\/select$/);
    cy.findByRole("region", { name: "Goals needing attention" }).within(() => {
      cy.contains("Goal merge");
      cy.findByRole("button", { name: "Open Goal merge in cmux" }).click();
      cy.findByRole("button", { name: /Continue|Restart|Skip/ }).should("not.exist");
    });
    cy.wait("@selectMerge").its("request.url").should("match", /\/api\/workspaces\/ws-merge\/select$/);
    cy.contains("Focused Goal merge in cmux").should("be.visible");
    cy.findByLabelText("2 live cmux sessions").should("exist");
  });

  it("opens each attention task's own workspace and reports a closed workspace", () => {
    const sessions = [
      { id: "ws-first", title: "First agent", effective: "todo" },
      { id: "ws-second", title: "Second agent", effective: "todo" },
    ];
    const source = plan("goal-attention", "Two waiting agents", 2, { boardState: "blocked", workspaceIds: sessions.map((session) => session.id) });
    const tasks = sessions.map((session, index) => task(`T${index + 1}`, "needs_you", session));
    installScenario({ plans: [source], goals: [healthGoal(source, tasks)], liveSessions: 2 });
    cy.intercept("POST", "**/api/workspaces/ws-first/select", { ok: true }).as("selectFirst");
    cy.intercept("POST", "**/api/workspaces/ws-second/select", { statusCode: 404, body: { error: "Workspace not found" } }).as("selectSecond");
    visitBoard();
    cy.findByRole("region", { name: "Goals needing attention" }).within(() => {
      cy.findByRole("button", { name: "Open Implement the fixture in cmux" }).click();
    });
    cy.wait("@selectFirst");
    cy.contains("Focused Implement the fixture in cmux").should("be.visible");
    cy.findByRole("region", { name: "Goals needing attention" }).within(() => {
      cy.findByRole("button", { name: "Open Verify the fixture in cmux" }).click();
    });
    cy.wait("@selectSecond");
    cy.contains("Workspace not found").should("be.visible");
    cy.findByRole("button", { name: "Open Verify the fixture in cmux" }).should("be.enabled");
  });

  it("shows the next dependency wave launching automatically after integration", () => {
    const mergeSession = { id: "ws-wave-merge", title: "E2E · Automatic dependency waves (wave) · MERGE", effective: "working" };
    const source = plan("goal-waves", "Automatic dependency waves", 4, {
      launchedCount: 2, readyCount: 2, deliveryStatus: "assembling", mergeStatus: "running", mergeWorkspaceId: mergeSession.id,
      workspaceIds: [mergeSession.id], health: "working", boardState: "dev_in_progress",
    });
    const waitingTasks = [
      task("T1", "ready", null),
      task("T2", "ready", null),
      task("T3", "queued", null, { wave: 1, launchStatus: "queued", deliveryStatus: "pending", reason: "This task waits for wave 1 to integrate" }),
      task("T4", "queued", null, { wave: 1, launchStatus: "queued", deliveryStatus: "pending", reason: "This task waits for wave 1 to integrate" }),
    ];
    const state: Scenario = {
      plans: [source],
      goals: [healthGoal(source, waitingTasks, { health: "working", merge: { id: "merge", kind: "merge", title: "Goal merge", workspaceId: mergeSession.id, health: "working", reason: "The merge agent is running", session: { ...mergeSession, lastActivityAt: Date.parse(now) } } })],
      liveSessions: 1,
    };
    installScenario(state);
    visitBoard();

    cy.findByRole("region", { name: "Dev in progress" }).within(() => {
      cy.contains("Automatic dependency waves");
      cy.findByLabelText("2 of 2 launched tasks ready").should("exist");
      cy.contains("Agents are working on the launched tasks");
    });

    const waveTwoCodex = { id: "ws-wave-t3", title: "E2E · Automatic dependency waves (wave) · T3-code · Continue workflow", effective: "working" };
    // Kept on the legacy leading-prefix shape on purpose. A cmux session is
    // never renamed, so a board carries both shapes at once during the
    // migration, and the card must still show a code for this one.
    const waveTwoClaude = { id: "ws-wave-t4", title: "E2E-T4-test · Verify workflow", effective: "working" };
    const advanced = { ...source, launchedCount: 4, deliveryStatus: "implementing", mergeStatus: null, mergeWorkspaceId: null, workspaceIds: [waveTwoCodex.id, waveTwoClaude.id] };
    const activeTasks = [
      task("T1", "ready", null, { deliveryStatus: "integrated" }),
      task("T2", "ready", null, { deliveryStatus: "integrated" }),
      task("T3", "working", waveTwoCodex, { wave: 1, title: "Continue workflow" }),
      task("T4", "working", waveTwoClaude, { wave: 1, title: "Verify workflow" }),
    ];
    cy.then(() => {
      state.plans = [advanced];
      state.goals = [healthGoal(advanced, activeTasks, { health: "working", readyCount: 2, launchedCount: 4 })];
      state.liveSessions = 2;
    });
    cy.openBoardTools();
    cy.findByRole("button", { name: "Refresh GitHub" }).click();
    cy.wait("@plans");

    cy.findByRole("region", { name: "Dev in progress" }).within(() => {
      cy.contains("Automatic dependency waves");
      cy.findByLabelText("2 of 4 launched tasks ready").should("exist");
      // New shape: the mid-string task-part segment. Legacy shape: the
      // leading prefix. Neither card falls back to the raw task id (T3 / T4).
      cy.findByLabelText("T3-code: Continue workflow").should("have.text", "T3-code");
      cy.findByLabelText("E2E-T4-test: Verify workflow").should("have.text", "E2E-T4-test");
      // The bare task id is the fallback. Neither card is allowed to show it.
      cy.findByLabelText("T3: Continue workflow").should("not.exist");
      cy.findByLabelText("T4: Verify workflow").should("not.exist");
    });
    cy.findByRole("region", { name: "Blocked" }).should("not.contain.text", "Automatic dependency waves");
    cy.findByLabelText("2 live cmux sessions").should("exist");
  });

  it("keeps a two-task goal in development while making an agent question visible", () => {
    const asking = { id: "ws-two", title: "E2E · Two task question lifecycle (ques) · T2-test · Verify the fixture", effective: "waiting" };
    const source = plan("goal-question", "Two task question lifecycle", 2, { readyCount: 1, workspaceIds: [asking.id], health: "needs_you" });
    const tasks = [task("T1", "ready", null), task("T2", "needs_you", asking)];
    const state = { plans: [source], goals: [healthGoal(source, tasks)], liveSessions: 1 };
    installScenario(state);
    visitBoard();

    cy.findByRole("region", { name: "Dev in progress" }).should("contain.text", "Two task question lifecycle");
    cy.findByRole("button", { name: "1 goals need you. Show the tasks that need you" }).should("exist");
    cy.findByRole("region", { name: "Goals needing attention" }).should("contain.text", "This task agent is waiting for an answer");
  });

  // Submitting a goal is fire and forget. The companion answers as soon as the
  // plan row exists, so the sheet must not sit on a "Planning…" button while a
  // round that outlives it runs on the companion.
  it("closes the sheet and preserves the new goal while cmux inventory catches up", () => {
    const state: Scenario = { plans: [], goals: [], liveSessions: 0 };
    installScenario(state);
    const planning = plan("goal-new", "Close every stale cmux session", 0, {
      status: "draft", stage: "questions", round: 0, taskCount: 0, launchedCount: 0,
      running: true, runStage: "writing_spec", runStep: "Reading the repository…", boardState: "writing_spec",
    });
    cy.intercept("POST", "**/api/goal-sessions", (request) => {
      state.plans = [planning];
      request.reply({ statusCode: 202, body: { ...planning, workflow: "goal_session", goalSessionWorkspaceId: "workspace-new", goalSessionState: "planning", planId: "goal-new", questions: [], tasks: [], running: true } });
    }).as("submit");
    visitBoard();

    cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
    cy.findByRole("dialog", { name: "Plan a goal" }).within(() => {
      cy.findByRole("textbox", { name: "Goal" }).type("Close every stale cmux session");
      cy.findByRole("button", { name: "Start goal session" }).click();
    });

    cy.wait("@submit");
    cy.findByRole("dialog", { name: "Plan a goal" }).should("not.exist");
    cy.contains("Goal session started in cmux for cmux-e2e-cypress.").should("be.visible");
    cy.location("search").should("not.contain", "workspace=");
    cy.findByRole("region", { name: "Writing Spec" }).should("contain.text", "Close every stale cmux session");
  });

  it("keeps the sheet open and reports the reason when a submit fails", () => {
    const state: Scenario = { plans: [], goals: [], liveSessions: 0 };
    installScenario(state);
    cy.intercept("POST", "**/api/goal-sessions", { statusCode: 500, body: { error: "The companion could not reach that repository" } }).as("submit");
    visitBoard();

    cy.findByRole("button", { name: "Plan a goal for cmux-e2e-cypress" }).click();
    cy.findByRole("dialog", { name: "Plan a goal" }).within(() => {
      cy.findByRole("textbox", { name: "Goal" }).type("Close every stale cmux session");
      cy.findByRole("button", { name: "Start goal session" }).click();
    });

    cy.wait("@submit");
    cy.findByRole("dialog", { name: "Plan a goal" }).should("be.visible")
      .and("contain.text", "The companion could not reach that repository");
  });
});

export {};
