// The goal board needs to know whether a launched goal's pull request is open,
// closed or merged. That answer already arrives with the manual Refresh GitHub
// action, so this module never runs `gh` itself: it reads the observations the
// dashboard cached during that one refresh and records what they mean.
//
// It is deliberately tolerant. A malformed repository entry, a plan the store
// cannot read, or a pull request with no branch must leave the dashboard
// response untouched, because the refresh is what the user asked for and the
// reconciliation is a side effect of it.

const PREFERENCE = { MERGED: 3, OPEN: 2, CLOSED: 1 };

export class GoalMergeWatch {
  constructor({ store, worktrees, sessionCollector = null, worktreeCleanup = null, burstReview = null, log = null } = {}) {
    if (!store) throw new TypeError("A goal plan store is required");
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    this.store = store;
    this.worktrees = worktrees;
    this.log = log;
    this.sessionCollector = sessionCollector;
    this.worktreeCleanup = worktreeCleanup;
    // Asked once per open pull request on every pass; it decides for itself
    // whether the goal is a burst goal and whether a reviewer already runs.
    this.burstReview = burstReview;
  }

  #plans() {
    return this.store.sessionCleanupPlanIds
      ? this.store.sessionCleanupPlanIds().map((planId) => ({ planId }))
      : this.store.list({ status: "launched", limit: 200 }) || [];
  }

  // The watchdog only needs GitHub state for repositories that still own a
  // non-terminal launched goal. Returning unique ids lets it avoid refreshing
  // every unrelated checkout on each supervision tick.
  activeRepositoryIds() {
    const ids = new Set();
    let plans;
    try { plans = this.#plans(); }
    catch (cause) {
      this.log?.warn?.({ err: cause }, "goal merge watch could not read the plan list");
      return [];
    }
    for (const summary of plans) {
      if (!summary || summary.boardStatus) continue;
      try {
        const plan = this.store.get(summary.planId);
        if (plan?.status === "launched" && plan.goalType !== "analysis" && !plan.boardStatus && plan.repositoryId) ids.add(String(plan.repositoryId));
      } catch (cause) {
        this.log?.warn?.({ err: cause, planId: summary.planId }, "goal merge watch could not read a plan");
      }
    }
    return [...ids];
  }

  // Called once after a successful explicit GitHub refresh, and never on an
  // ordinary poll. It returns what it recorded, so a test and a log line can
  // both read the outcome.
  async reconcile() {
    const recorded = [];
    let plans;
    try {
      plans = this.#plans();
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "goal merge watch could not read the plan list");
      return { recorded };
    }
    // One repository is read once, however many goals it carries.
    const byRepository = new Map();
    for (const summary of plans) {
      if (!summary || summary.boardStatus) continue;
      let plan;
      try {
        plan = this.store.get(summary.planId);
      } catch (cause) {
        this.log?.warn?.({ err: cause, planId: summary.planId }, "goal merge watch could not read a plan");
        continue;
      }
      if (!plan || plan.status !== "launched" || plan.goalType === "analysis" || plan.boardStatus) continue;
      const repositoryId = String(plan.repositoryId || "");
      if (!byRepository.has(repositoryId)) byRepository.set(repositoryId, this.#observations(repositoryId));
      const { available, observations } = byRepository.get(repositoryId);
      if (!available || !observations.length) continue;
      const match = selectGoalPullRequest(plan, observations);
      if (!match) continue;
      const written = this.#record(plan, match);
      if (written) {
        recorded.push(written);
        await this.sessionCollector?.collect(plan.planId);
        if (written.state === "MERGED") this.worktreeCleanup?.schedule();
      }
      // The review is asked for on every pass the pull request is open, not
      // only on the pass that recorded it: a reviewer that failed to start
      // released its claim, and nothing else would retry. reviewGoal answers
      // false cheaply once a review is claimed or running, and it owns the
      // burst rules, so the watch does not check the flag itself.
      // The reviewer opens a cmux session, which must not hold up the
      // refresh the user is waiting on, so it is not awaited.
      if (match.state === "OPEN") {
        Promise.resolve().then(() => this.burstReview?.reviewGoal?.(plan.planId))
          .catch((cause) => this.log?.warn?.({ err: cause, planId: plan.planId }, "burst goal review could not start"));
      }
    }
    return { recorded };
  }

  #observations(repositoryId) {
    try {
      const value = this.worktrees.pullRequestObservations?.(repositoryId);
      const observations = Array.isArray(value?.observations) ? value.observations : [];
      return { available: value?.available === true, observations };
    } catch (cause) {
      this.log?.warn?.({ err: cause, repositoryId }, "goal merge watch could not read repository pull requests");
      return { available: false, observations: [] };
    }
  }

  #record(plan, match) {
    const payload = { number: match.number ?? null, url: match.url || null, observedAt: match.observedAt || null };
    try {
      if (match.state === "MERGED") this.store.recordGoalMerged(plan.planId, payload);
      else this.store.recordGoalPullRequest(plan.planId, { ...payload, state: match.state });
      return { planId: plan.planId, state: match.state, number: payload.number, url: payload.url };
    } catch (cause) {
      this.log?.warn?.({ err: cause, planId: plan.planId }, "goal merge watch could not record a pull request");
      return null;
    }
  }
}

// The one selection rule, exported so the test can read it directly.
//
// A stored final pull request is identity, so it wins outright. Without one,
// only the goal's own branches count: the integration branch for a combined
// delivery, or the launched task branches for a single one. A branch match is
// weaker evidence than identity, so a pull request created before the goal was
// launched is rejected: it belongs to earlier work on the same branch name.
export function selectGoalPullRequest(plan, observations) {
  const list = (Array.isArray(observations) ? observations : []).filter((item) => item && typeof item === "object");
  const identified = list.filter((item) => sameIdentity(plan, item));
  const candidates = identified.length ? identified : list.filter((item) => matchesBranch(plan, item) && !precedesLaunch(plan, item));
  const usable = candidates.filter((item) => PREFERENCE[state(item)]);
  if (!usable.length) return null;
  const best = usable.reduce((winner, item) => (rank(item) > rank(winner) ? item : winner));
  return {
    number: Number.isInteger(best.number) ? best.number : null,
    url: typeof best.url === "string" && best.url ? best.url : null,
    state: state(best),
    observedAt: observedAt(best),
  };
}

function rank(item) {
  return PREFERENCE[state(item)] * 1e15 + timestamp(item.updatedAt);
}

function state(item) {
  return String(item?.state || "").toUpperCase();
}

function sameIdentity(plan, item) {
  const number = Number(plan?.finalPrNumber);
  if (Number.isInteger(number) && number > 0 && item.number === number) return true;
  const url = text(plan?.finalPrUrl);
  return Boolean(url) && text(item.url) === url;
}

// A combined goal delivers from its own integration branch. A single-task goal
// delivers from the task branches its launch actually created.
function matchesBranch(plan, item) {
  const branch = text(item.headBranch);
  if (!branch) return false;
  return goalBranches(plan).has(branch);
}

function goalBranches(plan) {
  if (plan?.deliveryMode === "combined") {
    const branch = text(plan.integrationBranch);
    return new Set(branch ? [branch] : []);
  }
  return new Set((Array.isArray(plan?.tasks) ? plan.tasks : [])
    .filter((task) => task?.launchStatus === "launched")
    .map((task) => text(task.branch))
    .filter(Boolean));
}

// A pull request opened before the goal launched cannot be this goal's work.
// An unreadable timestamp on either side proves nothing, so it is not rejected.
function precedesLaunch(plan, item) {
  const launched = timestamp(plan?.launchedAt);
  const created = timestamp(item?.createdAt);
  return launched > 0 && created > 0 && created < launched;
}

function observedAt(item) {
  return text(item.mergedAt) || text(item.closedAt) || text(item.updatedAt) || null;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
