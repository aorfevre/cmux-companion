import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TITLE, goalSegment, mergeSessionTitle, partCode, projectCode, sessionEnv, sessionTitle, taskCode } from "../server/session-name.mjs";

// --- project code --------------------------------------------------------

// A hyphenated name takes one initial per word, so "cmux-companion" is CC and
// not a consonant squeeze of the first word. This is the shape a person would
// write by hand, and it is what the launch tests assert against.
test("takes one initial per word for a multi-word repository name", () => {
  assert.equal(projectCode("cmux-companion"), "CC");
  assert.equal(projectCode("rekord-api"), "RA");
  assert.equal(projectCode("sample"), "SMP");
});

// Any non-alphanumeric run is a word boundary, not just a hyphen, so a repo
// cloned as `cmux_companion` or `cmux.companion` reads the same as the dashed
// one rather than falling into the single-word branch.
test("treats every non-alphanumeric run as a word boundary", () => {
  assert.equal(projectCode("cmux_companion"), "CC");
  assert.equal(projectCode("cmux.companion"), "CC");
  assert.equal(projectCode("my repo name"), "MRN");
});

// The initials are capped at four so a deeply hyphenated fork does not push
// the code half past the budget the title reserves for it.
test("caps the initials of a many-word name at four characters", () => {
  assert.equal(projectCode("a-b-c-d-e"), "ABCD");
});

// A single word drops its vowels first, because the consonant skeleton is what
// stays legible once it is squeezed to three characters.
test("strips vowels from a single-word repository name", () => {
  assert.equal(projectCode("karven"), "KRV");
  assert.equal(projectCode("rekord"), "RKR");
});

// A word with fewer than three consonants would produce a one- or two-letter
// code, so the original word is used instead of the skeleton.
test("keeps the raw word when it has too few consonants to squeeze", () => {
  assert.equal(projectCode("area"), "ARE");
  assert.equal(projectCode("ai"), "AI");
  assert.equal(projectCode("x"), "X");
});

// A missing repository name is normal — a plan can be saved before the catalog
// answers — so it must not throw and must not produce an empty code that would
// collapse the name into a leading dash.
test("falls back to GOAL for a name that carries no letters", () => {
  assert.equal(projectCode(""), "GOAL");
  assert.equal(projectCode("   "), "GOAL");
  assert.equal(projectCode(null), "GOAL");
  assert.equal(projectCode(undefined), "GOAL");
  assert.equal(projectCode(42), "GOAL");
  assert.equal(projectCode({ name: "karven" }), "GOAL");
  assert.equal(projectCode("___"), "GOAL");
});

// --- task code -----------------------------------------------------------

// The planner's own T-shaped id is what the contract, the brief filename and
// the commit trailer already use, so the session must not invent a second one.
test("passes a planner task id through unchanged", () => {
  assert.equal(taskCode("T1"), "T1");
  assert.equal(taskCode("T12", 7), "T12");
  assert.equal(taskCode("T123"), "T123");
});

test("upper-cases a lowercase task id rather than treating it as free text", () => {
  assert.equal(taskCode("t12"), "T12");
  assert.equal(taskCode("t1", 4), "T1");
});

// A uuid is not readable, so the position in the plan becomes the code. The
// position is zero-based and the code is one-based.
test("falls back to the position for an id that is not a task code", () => {
  assert.equal(taskCode("3f2b9c1e-1c4a-4d33-9f2e-1a2b3c4d5e6f", 4), "T5");
  assert.equal(taskCode("3f2b9c1e-1c4a-4d33-9f2e-1a2b3c4d5e6f"), "T1");
  assert.equal(taskCode(null, 2), "T3");
});

// Four digits is past the pattern, so it is not a planner id and falls back.
test("does not pass through an id with more digits than the pattern allows", () => {
  assert.equal(taskCode("T1234", 0), "T1");
});

// A negative or unparsable position must not produce T0 or TNaN.
test("clamps a nonsense position to the first task", () => {
  assert.equal(taskCode("uuid", -3), "T1");
  assert.equal(taskCode("uuid", "zz"), "T1");
  assert.equal(taskCode("uuid", Number.POSITIVE_INFINITY), "T1");
});

// --- part code -----------------------------------------------------------

test("maps every task type the contract defines", () => {
  assert.deepEqual(
    ["feature", "bugfix", "ui", "backend", "docs", "test", "migration", "investigation", "refactor"].map(partCode),
    ["feat", "fix", "ui", "api", "docs", "test", "migr", "spike", "rfac"],
  );
});

test("matches a task type case-insensitively", () => {
  assert.equal(partCode("BACKEND"), "api");
  assert.equal(partCode("  Migration  "), "migr");
});

// Free text must never reach the code half. An unknown type is generic work.
test("falls back to dev for a type outside the contract", () => {
  assert.equal(partCode("chore"), "dev");
  assert.equal(partCode(""), "dev");
  assert.equal(partCode(null), "dev");
  assert.equal(partCode(123), "dev");
});

// --- session title -------------------------------------------------------

const PLAN = {
  planId: "plan-1",
  repositoryName: "cmux-companion",
  goal: "Ship the goal board",
  spec: { outcome: "Every goal is visible on the board" },
  tasks: [{ id: "t1" }, { id: "t2" }],
};

test("orders the name as project, goal, task-part, then title", () => {
  assert.equal(
    sessionTitle(PLAN, { id: "t2", type: "backend", title: "Wire the health sweep" }),
    "CC · Every goal is visible on the board (plan) · T2-api · Wire the health sweep",
  );
});

// --- goal segment --------------------------------------------------------

// The spec outcome is the reviewed sentence. The raw goal is what the user
// typed before the planner refined it, so it is the fallback and not the
// first choice.
test("prefers the spec outcome over the raw goal", () => {
  assert.equal(goalSegment(PLAN), "Every goal is visible on the board (plan)");
});

test("falls back to the raw goal when there is no usable spec outcome", () => {
  const base = { planId: "plan-1", goal: "only goal" };
  assert.equal(goalSegment(base), "only goal (plan)");
  assert.equal(goalSegment({ ...base, spec: { outcome: null } }), "only goal (plan)");
  assert.equal(goalSegment({ ...base, spec: { outcome: "" } }), "only goal (plan)");
  // A whitespace-only outcome is truthy. Both sides are trimmed before the
  // choice, so it does not win and then collapse to nothing.
  assert.equal(goalSegment({ ...base, spec: { outcome: "   " } }), "only goal (plan)");
});

// A plan with no goal text at all still needs a segment, because the name is
// four segments and the board parser slices on them.
test("degrades to the id fragment alone when there is no goal text", () => {
  assert.equal(goalSegment({ planId: "plan-1" }), "(plan)");
  assert.equal(goalSegment({ planId: "plan-1", goal: "  ", spec: { outcome: "  " } }), "(plan)");
  assert.equal(
    sessionTitle({ planId: "plan-1", repositoryName: "karven" }, { id: "T1", type: "ui", title: "Board column" }),
    "KRV · (plan) · T1-ui · Board column",
  );
});

// The fragment is what keeps two goals in one repository apart when they open
// with the same words, so it is derived and never omitted.
test("gives two identically worded goals different titles", () => {
  const task = { id: "T1", type: "ui", title: "Board column" };
  const one = sessionTitle({ planId: "aaaa1111", repositoryName: "karven", goal: "Ship the board" }, task);
  const two = sessionTitle({ planId: "bbbb2222", repositoryName: "karven", goal: "Ship the board" }, task);
  assert.notEqual(one, two);
  assert.equal(one, "KRV · Ship the board (aaaa) · T1-ui · Board column");
  assert.equal(two, "KRV · Ship the board (bbbb) · T1-ui · Board column");
});

// An unusable id must not produce an empty pair of parentheses: that says
// nothing and still costs three characters of the budget.
test("uses a readable fragment for an id that carries no alphanumerics", () => {
  assert.equal(goalSegment({ goal: "Ship it" }), "Ship it (goal)");
  assert.equal(goalSegment({ planId: "", goal: "Ship it" }), "Ship it (goal)");
  assert.equal(goalSegment({ planId: "   ", goal: "Ship it" }), "Ship it (goal)");
  assert.equal(goalSegment({ planId: 12345, goal: "Ship it" }), "Ship it (goal)");
  assert.equal(goalSegment({ planId: "---___", goal: "Ship it" }), "Ship it (goal)");
});

test("takes the first four alphanumerics of the plan id, lowercased", () => {
  assert.equal(goalSegment({ planId: "PLAN-12345678", goal: "Ship it" }), "Ship it (plan)");
  assert.equal(goalSegment({ planId: "3f2b9c1e-1c4a-4d33", goal: "Ship it" }), "Ship it (3f2b)");
});

// A person types the goal, so it can carry the separator itself. An embedded
// separator would make the name read as five segments and the board parser
// would slice it wrongly.
test("strips a separator and parentheses out of user-typed goal text", () => {
  assert.equal(goalSegment({ planId: "plan-1", goal: "Ship A · then B" }), "Ship A - then B (plan)");
  assert.equal(goalSegment({ planId: "plan-1", goal: "Ship (the) board" }), "Ship the board (plan)");
  assert.equal(sessionTitle({ planId: "plan-1", repositoryName: "karven", goal: "A · B" }, { id: "T1", type: "ui", title: "Col" }).split(" · ").length, 4);
});

// --- budgets -------------------------------------------------------------

// cmux refuses a title over 100 characters, so the bound is the module's job
// and not the caller's.
test("never exceeds MAX_TITLE, however long the task title is", () => {
  const title = sessionTitle(PLAN, { id: "t2", type: "backend", title: "x".repeat(500) });
  assert.equal(MAX_TITLE, 100);
  assert.ok(title.length <= MAX_TITLE, `got ${title.length} characters`);
});

// The task-part code identifies the session, so the title loses characters and
// the segments before it never do.
test("truncates the title and leaves every earlier segment whole", () => {
  const title = sessionTitle(PLAN, { id: "t2", type: "backend", title: "x".repeat(500) });
  assert.ok(title.startsWith("CC · Every goal is visible on the board (plan) · T2-api · "), `an earlier segment was cut: ${title}`);
  assert.ok(title.endsWith("…"), "a clipped title must say it was clipped");
});

// A long goal clips inside its own budget. The fragment and the task-part code
// both survive, because they are what identify the session.
test("clips a 500-character goal inside its own budget and keeps the fragment", () => {
  const title = sessionTitle({ ...PLAN, spec: { outcome: "z".repeat(500) } }, { id: "t2", type: "backend", title: "y".repeat(500) });
  assert.ok(title.length <= MAX_TITLE, `got ${title.length} characters`);
  assert.ok(title.includes("(plan)"), `the id fragment was clipped away: ${title}`);
  assert.ok(title.includes(" · T2-api · "), `the task-part segment was cut: ${title}`);
  assert.ok(title.endsWith("…"), "a clipped title must say it was clipped");
  assert.deepEqual(title.split(" · ").length, 4);
});

// A title long enough to need clipping must be clipped to the budget, not
// merely to the ellipsis: the ellipsis replaces a character.
test("clips a long title to exactly the remaining budget", () => {
  const label = "CC · Every goal is visible on the board (plan) · T2-api";
  const title = sessionTitle(PLAN, { id: "t2", type: "backend", title: "y".repeat(500) });
  assert.equal(title.length, MAX_TITLE);
  assert.equal(title.slice(label.length + 3).length, MAX_TITLE - label.length - 3);
});

// A title made only of whitespace is not a title. Emitting the separator with
// nothing after it would leave a session named "… T1-ui · ".
test("returns the name without a trailing empty segment for a blank title", () => {
  const expected = "CC · Every goal is visible on the board (plan) · T1-ui";
  assert.equal(sessionTitle(PLAN, { id: "t1", type: "ui", title: "   \n\t  " }), expected);
  assert.equal(sessionTitle(PLAN, { id: "t1", type: "ui", title: "" }), expected);
  assert.equal(sessionTitle(PLAN, { id: "t1", type: "ui" }), expected);
});

// A multi-line title would break the one-line display cmux renders.
test("folds a multi-line title onto one line", () => {
  assert.equal(
    sessionTitle(PLAN, { id: "t1", type: "ui", title: "Add the\n  board\tcolumn" }),
    "CC · Every goal is visible on the board (plan) · T1-ui · Add the board column",
  );
});

// A suffix that eats the whole budget leaves no usable room for a title, so
// the label is returned alone rather than with a two-character stub.
test("drops the title when a long suffix leaves no room for it", () => {
  const title = sessionTitle(PLAN, { id: "t1", type: "ui", title: "Board column" }, { suffix: "y".repeat(200) });
  assert.ok(title.length <= MAX_TITLE);
  assert.ok(!title.includes("Board column"), `the title should have been dropped: ${title}`);
});

test("appends a suffix between the codes and the title when it fits", () => {
  assert.equal(
    sessionTitle(PLAN, { id: "t1", type: "ui", title: "Board column" }, { suffix: "retry" }),
    "CC · Every goal is visible on the board (plan) · T1-ui · retry · Board column",
  );
});

// A missing plan or task is a programming error upstream, but a thrown name
// would take down a launch that has already created a worktree.
test("names a session even with no plan and no task", () => {
  assert.equal(sessionTitle(null, null), "GOAL · (goal) · T1-dev");
  assert.equal(sessionTitle(undefined, undefined), "GOAL · (goal) · T1-dev");
});

// A task that is not in the plan's list has no position, so it falls back to
// the first slot instead of producing T0.
test("uses the first position for a task the plan does not list", () => {
  assert.equal(
    sessionTitle(PLAN, { id: "stranger", type: "docs", title: "Notes" }),
    "CC · Every goal is visible on the board (plan) · T1-docs · Notes",
  );
});

// --- merge session title -------------------------------------------------

// The goal text lives in the segment now, so the merge name does not repeat it
// after the MERGE marker.
test("names a merge session project, goal and MERGE", () => {
  assert.equal(mergeSessionTitle(PLAN), "CC · Every goal is visible on the board (plan) · MERGE");
});

test("falls back to the raw goal for a merge session with no spec outcome", () => {
  const base = { planId: "plan-1", repositoryName: "karven", goal: "only goal" };
  assert.equal(mergeSessionTitle(base), "KRV · only goal (plan) · MERGE");
  assert.equal(mergeSessionTitle({ ...base, spec: { outcome: null } }), "KRV · only goal (plan) · MERGE");
  assert.equal(mergeSessionTitle({ ...base, spec: { outcome: "" } }), "KRV · only goal (plan) · MERGE");
  assert.equal(mergeSessionTitle({ ...base, spec: { outcome: "   " } }), "KRV · only goal (plan) · MERGE");
});

test("names a merge session with no goal and a merge session with no plan", () => {
  assert.equal(mergeSessionTitle({ planId: "plan-1", repositoryName: "karven" }), "KRV · (plan) · MERGE");
  assert.equal(mergeSessionTitle(null), "GOAL · (goal) · MERGE");
});

test("keeps a merge title inside MAX_TITLE and clips the goal, not the codes", () => {
  const title = mergeSessionTitle({ planId: "plan-1", repositoryName: "cmux-companion", goal: "z".repeat(500) });
  assert.ok(title.length <= MAX_TITLE, `got ${title.length} characters`);
  assert.ok(title.startsWith("CC · "), `the project code was cut: ${title}`);
  assert.ok(title.endsWith("(plan) · MERGE"), `the fragment or the marker was cut: ${title}`);
});

// --- session env ---------------------------------------------------------

// These stamps are the machine-readable identity. A user can rename a title;
// they cannot rename an exported variable, so a later sweep still resolves the
// session back to its goal and task.
test("stamps the project, plan, goal, task and part for a task session", () => {
  assert.deepEqual(sessionEnv(PLAN, { id: "t2", type: "backend" }), {
    COMPANION_PROJECT: "CC",
    COMPANION_PLAN: "plan-1",
    COMPANION_GOAL: "plan",
    COMPANION_TASK: "T2",
    COMPANION_PART: "api",
  });
});

// A merge session has no task, so the task keys must be absent rather than
// present and empty: an exported empty value reads as a real task id of "".
test("omits the task keys entirely when there is no task", () => {
  const env = sessionEnv(PLAN, null);
  assert.deepEqual(env, { COMPANION_PROJECT: "CC", COMPANION_PLAN: "plan-1", COMPANION_GOAL: "plan" });
  assert.equal("COMPANION_TASK" in env, false);
  assert.equal("COMPANION_PART" in env, false);
});

// COMPANION_GOAL carries the same fragment the title shows, so a sweep can
// match a session to its goal without parsing the name.
test("stamps the goal fragment the title uses", () => {
  assert.equal(sessionEnv({ planId: "3f2b9c1e-1c4a" }, null).COMPANION_GOAL, "3f2b");
  assert.ok(sessionTitle({ planId: "3f2b9c1e-1c4a", goal: "Ship it" }, null).includes("(3f2b)"));
});

test("keeps the plan key present but empty when the plan has no id", () => {
  assert.deepEqual(sessionEnv({ repositoryName: "karven" }, null), { COMPANION_PROJECT: "KRV", COMPANION_PLAN: "", COMPANION_GOAL: "goal" });
});
