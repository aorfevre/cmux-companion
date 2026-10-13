# Goals List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Goals list with decisions first and inline buttons, one goal page layout for both experiences, translated reasons with a next step, and the supervisor flow by default, per `docs/superpowers/specs/2026-10-13-goals-list-design.md`.

**Architecture:** The server-side `decisionView` grows `detail`, `next`, `rank` and `stage`. The client deletes its `attention()` and `goalStage()` helpers and reads `goal.decision` everywhere. A `GoalsList` component replaces `GoalFleet`; a `GoalPage` component replaces the legacy tabbed detail by reusing the conversation layout with a request card, a revision composer and a technical disclosure. Navigation collapses to one "Goals" link.

**Tech Stack:** Node 22 ESM domain code checked by `tsc --project tsconfig.backend.json`; React 19 client; node:test, Vitest with Testing Library, Cypress.

---

## File structure

- Modify `server/orchestration/domain/decision-view.mjs`: translations, `detail`, `next`, `rank`, `stage`.
- Modify `tests/orchestration-decision-view.test.mjs`: new fields.
- Create `app/orchestration/goals-list.tsx`: list, chips, rows with inline buttons.
- Delete `app/orchestration/goal-fleet.tsx` and `app/orchestration/attention.ts`.
- Modify `app/orchestration/decision-bar.tsx`: render `next` as the primary, callback to open the composer.
- Create `app/orchestration/goal-page.tsx`: shared page; request card for legacy goals; technical disclosure.
- Modify `app/orchestration/goal-conversation.tsx`: accept legacy goals, composer modes, prefill.
- Modify `app/orchestration/goal-detail.tsx`: becomes the technical sections only, exported as `GoalTechnicalDetails`.
- Modify `app/orchestration/goal-board.tsx`: list, redirect, composer default.
- Modify `app/navigation.tsx`, `app/mission-shell.tsx`: one "Goals" link.
- Modify `app/orchestration/orchestration.css`.
- Create `tests/ui-goals-list.test.tsx`, `tests/ui-goal-page.test.tsx`; delete `tests/ui-mission-control.test.tsx`; modify `tests/ui-decision-bar.test.tsx`, `tests/ui-orchestration.test.tsx`, `tests/ui-goal-conversation.test.tsx`, `tests/ui-goals-navigation.test.tsx`, `tests/ui-features.test.tsx`, `tests/ui-page.test.tsx`.
- Modify Cypress: `mission-control.cy.ts` (renamed `goals-list.cy.ts`), `goals-navigation.cy.ts`, `goal-workspace.cy.ts`, `orchestration-core.cy.ts`, `orchestration-conversation.cy.ts`, and the label assertions in `account-usage`, `pairing`, `launch`, `settings-onboarding`, `ui-consistency`.

---

### Task 1: Decision view fields

**Files:** `server/orchestration/domain/decision-view.mjs`, `tests/orchestration-decision-view.test.mjs`

- [ ] **Step 1: Write failing tests** appended to the test file:

```js
test('hold reasons are translated with a hint and keep the raw detail', () => {
  const f = fixture(); f.request('planner', 'planner'); f.dispatch('planner');
  f.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  f.command('record_stopped', { attemptId: 'planner' });
  const d = decisionView(f.goal);
  assert.equal(d.reason, 'The planner stopped before it finished. Recover to run it again.');
  assert.equal(d.detail, 'planner did not finish successfully.');
  assert.equal(d.stage, 'On hold');
  assert.equal(d.rank, 0);
  assert.equal(d.next, null);
});

test('a blocking plan review refuses recovery and offers a revision with the findings as context', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  f.request('plan_review', 'reviewer'); f.dispatch('plan_review'); f.review('plan_review', planTarget(f.goal), true);
  const d = decisionView(f.goal);
  assert.equal(d.primary, null);
  assert.equal(d.reason, 'A plan revision is required before recovery.');
  assert.deepEqual(d.next, { type: 'request_revision', label: 'Request revision', context: 'high: Incorrect value. Return the required value' });
  assert.equal(d.rank, 0);
});

test('a clarification and a conversational refusal offer the composer as the next step', () => {
  const asked = fixture(); asked.goal.clarification = { question: 'Which module first?' };
  assert.deepEqual(decisionView(asked.goal).next, { type: 'answer_clarification', label: 'Answer question' });
  assert.equal(decisionView(asked.goal).rank, 0);
});

test('ranks order decisions, active work, delivered, merged and aborted', () => {
  const approved = fixture(); approved.approve();
  assert.equal(decisionView(approved.goal).rank, 1);
  assert.equal(decisionView(approved.goal).stage, 'In progress');
  const delivered = fixture(); delivered.deliver();
  assert.equal(decisionView(delivered.goal).rank, 2, 'an open mergeable PR waits on GitHub even though a review fix stays offered');
  delivered.goal.actions = undefined;
  const merged = { ...delivered.goal, status: 'merged' };
  assert.equal(decisionView(merged).rank, 3); assert.equal(decisionView(merged).stage, 'Complete');
  const aborted = { ...delivered.goal, status: 'aborted' };
  assert.equal(decisionView(aborted).rank, 4); assert.equal(decisionView(aborted).stage, 'Aborted');
});

test('every hold kind and recovery refusal has a translation', () => {
  const { HOLD_TRANSLATIONS, REFUSAL_TRANSLATIONS } = await import('../server/orchestration/domain/decision-view.mjs');
  for (const kind of ['attempt', 'review', 'integration', 'verification', 'publication', 'review_fix']) assert.ok(kind in HOLD_TRANSLATIONS, kind);
  for (const message of ['Let active workers finish and reconcile uncertain ownership before recovery', 'Request a plan revision to address the blocking review', 'Wait for submitted results to settle before recovery', 'Confirm the fix push outcome before recovery', 'The failure hold changed']) assert.ok(message in REFUSAL_TRANSLATIONS, message);
});
```

Make the last test `async`. The delivered rank is 2 per the spec: an open, non-conflicting PR waits on GitHub even though `request_review_fix` stays offered.

- [ ] **Step 2: Run** `node --test tests/orchestration-decision-view.test.mjs` → FAIL on `reason`.

- [ ] **Step 3: Implement.** Replace the module body with:

```js
import { isSupervisor } from './conversation.mjs';
import { actionView } from './action-view.mjs';
import { currentWave } from './waves.mjs';

/** @typedef {{ type: string; label: string; payload: Record<string, unknown> }} ProjectedAction
 * @typedef {{ type: 'request_revision'; label: string; context: string } | { type: 'answer_clarification' | 'send_goal_message'; label: string }} NextStep
 * @typedef {{ state: string; reason: string | null; detail: string | null; primary: ProjectedAction | null; next: NextStep | null; rank: 0 | 1 | 2 | 3 | 4; stage: string }} Decision */
const PRIMARY_ORDER = ['retry_startup', 'recover_goal', 'approve', 'accept_moved_target', 'approve_publication', 'request_review_fix', 'retry_task', 'retry_attempt', 'retry_integration', 'retry_verification', 'authorize_repair', 'resume_goal'];
const ROLE_WORDS = { planner: 'planner', implementer: 'implementer', reviewer: 'reviewer', integrator: 'integrator', review_fixer: 'review fixer' };

/** Plain sentences for each hold kind. Exported so a test can prove coverage.
 * @type {Record<string, (reason: { message: string; target: string }, goal: import('../types.d.ts').Goal) => string>} */
export const HOLD_TRANSLATIONS = {
  attempt: (reason, goal) => {
    const attempt = goal.attempts.find(entry => entry.id === reason.target);
    const role = attempt ? (isSupervisor(goal, attempt) ? 'supervisor' : attempt.role === 'reviewer' && attempt.target.startsWith('contract:') ? 'plan reviewer' : ROLE_WORDS[attempt.role]) : 'agent';
    return `The ${role} stopped before it finished. Recover to run it again.`;
  },
  review: (reason, goal) => goal.reviews.find(review => review.id === reason.target)?.kind === 'plan'
    ? 'The plan review asked for changes. Request a revision with your guidance.'
    : 'An independent review asked for changes. Recover to repair them.',
  integration: (reason, goal) => goal.integration?.state === 'conflict' ? 'Combining the work hit a conflict. Recover to repair it.' : 'Combining the work failed. Recover to retry it.',
  verification: reason => reason.message.startsWith('Dependencies') ? 'Dependencies did not install on the integrated commit. Inspect the check output, then recover.' : 'Checks failed on the integrated commit. Recover to repair them.',
  publication: () => 'The pull request outcome is uncertain. Recover after you confirm it on GitHub.',
  review_fix: reason => reason.message.startsWith('The fix push outcome') ? 'The fix push outcome is uncertain. Companion is confirming the branch.' : 'Addressing review comments failed. Recover to try again.',
};
/** @type {Record<string, string>} */
export const REFUSAL_TRANSLATIONS = {
  'Let active workers finish and reconcile uncertain ownership before recovery': 'Workers are still running. Recovery opens when they stop.',
  'Request a plan revision to address the blocking review': 'A plan revision is required before recovery.',
  'Wait for submitted results to settle before recovery': "A worker's result is still being recorded. Recovery opens when it settles.",
  'Confirm the fix push outcome before recovery': 'Companion is confirming the fix push. Recovery opens when it is confirmed.',
  'The failure hold changed': 'The goal changed. Reload to see its current state.',
};

/** @param {import('../types.d.ts').Goal} goal */
function stageOf(goal) {
  if (goal.status === 'merged') return 'Complete';
  if (goal.status === 'aborted') return 'Aborted';
  if (goal.hold) return 'On hold';
  if (goal.conversation?.paused) return 'Paused';
  if (goal.status === 'addressing_review') return 'Addressing review';
  if (goal.status === 'delivered') return 'Waiting for merge';
  if (goal.status === 'ready_to_publish') return goal.publication?.approval ? 'PR delivery' : 'Ready to publish';
  if (goal.status === 'discovering') return 'Planning';
  if (goal.status === 'awaiting_approval') return 'Needs approval';
  if (goal.verificationRuns?.some(run => run.generation === goal.generation && run.revision === goal.revision && ['pending', 'uncertain'].includes(run.status))) return 'Verification';
  if (goal.tasks.length && goal.tasks.every(task => task.status === 'integrated')) return goal.reviews.some(review => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'accept') ? 'Verification' : 'Review';
  if (goal.tasks.some(task => task.status === 'in_review') && !goal.tasks.some(task => task.status === 'running')) return 'Review';
  return 'In progress';
}

/** @param {import('../types.d.ts').Goal} goal @param {ProjectedAction[]} actions @param {ProjectedAction | null} primary @returns {NextStep | null} */
function nextStep(goal, actions, primary) {
  if (primary) return null;
  const offered = type => actions.some(action => action.type === type);
  const blockingPlan = goal.hold?.reasons.some(reason => reason.kind === 'review' && goal.reviews.some(review => review.id === reason.target && review.kind === 'plan'));
  if (blockingPlan && offered('request_revision')) {
    const review = goal.reviews.filter(entry => entry.kind === 'plan' && entry.disposition === 'request_changes').at(-1);
    const context = (review?.findings ?? []).map(finding => `${finding.severity}: ${finding.title}. ${finding.suggestion}`).join('\n');
    return { type: 'request_revision', label: 'Request revision', context };
  }
  if (goal.clarification && goal.clarification.answer === undefined && offered('answer_clarification')) return { type: 'answer_clarification', label: 'Answer question' };
  if (goal.experienceVersion === 2 && goal.hold && offered('send_goal_message')) return { type: 'send_goal_message', label: 'Message supervisor' };
  return null;
}

/** @param {import('../types.d.ts').Goal} goal @param {ReturnType<typeof actionView>} [projected] @returns {Decision} */
export function decisionView(goal, projected = actionView(goal)) {
  const { actions, approvalBlocked, recoveryBlocked } = projected;
  const offered = actions.filter(action => action.type !== 'recover_goal' || action.payload.mode === undefined);
  const primary = PRIMARY_ORDER.map(type => offered.find(action => action.type === type)).find(Boolean) ?? null;
  const next = nextStep(goal, actions, primary);
  const stage = stageOf(goal);
  const deliveredQuiet = goal.status === 'delivered' && goal.mergeSync?.state !== 'closed' && goal.mergeSync?.mergeable !== 'conflicting';
  const rank = /** @type {Decision['rank']} */ ((primary || next) && !deliveredQuiet ? 0 : goal.status === 'delivered' ? 2 : goal.status === 'merged' ? 3 : goal.status === 'aborted' ? 4 : 1);
  /** @param {string} state @param {string | null} [reason] @param {boolean} [keep] @param {string | null} [detail] */
  const decision = (state, reason = null, keep = true, detail = null) => ({ state, reason, detail, primary: keep ? primary : null, next: keep ? next : null, rank, stage });
  if (goal.startup?.status === 'failed') return decision(goal.startup.error || 'Could not prepare the base branch.');
  if (goal.hold) {
    const detail = recoveryBlocked ?? goal.hold.reasons.map(reason => reason.message).join(' ');
    const reason = recoveryBlocked ? (REFUSAL_TRANSLATIONS[recoveryBlocked] ?? recoveryBlocked) : goal.hold.reasons.map(entry => HOLD_TRANSLATIONS[entry.kind]?.(entry, goal) ?? entry.message).join(' ');
    return decision('The goal is on hold.', reason, true, detail);
  }
  if (goal.clarification && goal.clarification.answer === undefined) return decision(goal.clarification.question, null, true);
  if (goal.status === 'awaiting_approval') return approvalBlocked ? decision('Your plan waits on a blocker.', approvalBlocked, false) : decision('Your plan is ready to approve.');
  if (goal.status === 'ready_to_publish' && goal.publication?.observation?.status === 'target_moved') return decision('The target branch moved after review.', 'Publishing keeps the reviewed head unchanged; it does not rebase or merge the target.');
  if (goal.status === 'ready_to_publish' && !goal.publication?.approval) return decision('The verified result waits for your publication approval.');
  const current = goal.attempts.filter(attempt => isSupervisor(goal, attempt) || (attempt.generation === goal.generation && attempt.revision === goal.revision));
  const latest = new Map(current.map(attempt => [JSON.stringify([attempt.role, attempt.taskId, attempt.target]), attempt]));
  const failed = [...latest.values()].find(attempt => attempt.workerState === 'unknown' || (attempt.status === 'failed' && !attempt.launchFailure?.scheduled));
  if (failed) return decision(failed.error || (failed.workerState === 'unknown' ? 'Agent ownership needs reconciliation.' : 'An agent needs a retry.'));
  if (goal.tasks.some(task => task.status === 'failed')) return decision('A task needs a retry.');
  if (goal.conversation?.paused) return decision('Paused.', 'Your messages stay queued.');
  if (goal.status === 'merged') return decision('Merged on GitHub.', null, false);
  if (goal.status === 'aborted') return decision('Aborted. Evidence is retained.', null, false);
  if (goal.status === 'delivered' && goal.mergeSync?.state === 'closed') return decision('The pull request was closed without merging.', 'Review it on GitHub.');
  if (goal.status === 'addressing_review' && goal.reviewRound?.state === 'unknown') return decision('The fix push outcome is uncertain.', 'Companion is confirming the remote branch.', false);
  if (goal.status === 'delivered') return decision('Pull request published. Waiting for merge.', goal.mergeSync?.error ?? null);
  const working = current.filter(attempt => attempt.workerState === 'running' && !isSupervisor(goal, attempt)).length;
  return decision(working ? `${working} agent${working === 1 ? '' : 's'} working.` : 'Work continues automatically. No action needed.', null, false);
}
```

Note: the clarification step now keeps `next` (the `keep` flag is true, `primary` is null there because no primary is offered). Remove the unused `currentWave` import if the typecheck flags it. The existing clarification test asserts `primary: null` only; update its `deepEqual` to include the new fields or switch it to field assertions.

- [ ] **Step 4: Run the file**, fix the older `deepEqual` assertions to the new shape (add `detail`, `next`, `rank`, `stage`), then run `npx tsc --project tsconfig.backend.json && npm test`.

- [ ] **Step 5: Commit** `feat: translate hold reasons and project next step, rank and stage`.

---

### Task 2: Goals list and navigation

**Files:** create `app/orchestration/goals-list.tsx`, `tests/ui-goals-list.test.tsx`; delete `app/orchestration/goal-fleet.tsx`, `app/orchestration/attention.ts`, `tests/ui-mission-control.test.tsx`; modify `app/navigation.tsx`, `app/mission-shell.tsx`, `app/orchestration/goal-board.tsx`, `app/orchestration/orchestration.css`, `tests/ui-goals-navigation.test.tsx`, `tests/ui-features.test.tsx`, `tests/ui-page.test.tsx`, `tests/ui-orchestration.test.tsx`.

- [ ] **Step 1: Write failing tests** in `tests/ui-goals-list.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalsList } from '../app/orchestration/goals-list';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';
import type { Goal } from '../app/orchestration/goal-board';

afterEach(cleanup);
const base = (): Goal => goalView(fixture().goal);
const decision = (over: Partial<Goal['decision']>): Goal['decision'] => ({ state: 'Work continues automatically. No action needed.', reason: null, detail: null, primary: null, next: null, rank: 1, stage: 'In progress', ...over });
const recover = { type: 'recover_goal', label: 'Recover goal', payload: { holdId: 'h' } };
function goals(): Goal[] {
  return [
    { ...base(), id: 'active', title: 'Active goal', lastActivity: { kind: 'attempt_dispatched', createdAt: '2026-10-13T10:00:00Z' }, decision: decision({}) },
    { ...base(), id: 'held', title: 'Held goal', hold: { id: 'h', reasons: [] }, actions: [recover, { type: 'abort', label: 'Abort goal', payload: {} }], lastActivity: { kind: 'goal_dispatch_held', createdAt: '2026-10-13T09:00:00Z' }, decision: decision({ state: 'The goal is on hold.', reason: 'The planner stopped before it finished. Recover to run it again.', primary: recover, rank: 0, stage: 'On hold' }) },
    { ...base(), id: 'merged', title: 'Merged goal', status: 'merged', decision: decision({ state: 'Merged on GitHub.', rank: 3, stage: 'Complete' }) },
    { ...base(), id: 'aborted', title: 'Aborted goal', status: 'aborted', decision: decision({ state: 'Aborted. Evidence is retained.', rank: 4, stage: 'Aborted' }) },
    { ...base(), id: 'revise', title: 'Needs revision', actions: [{ type: 'request_revision', label: 'Request revision', payload: {} }], lastActivity: { kind: 'review_recorded', createdAt: '2026-10-13T11:00:00Z' }, decision: decision({ state: 'The goal is on hold.', reason: 'A plan revision is required before recovery.', next: { type: 'request_revision', label: 'Request revision', context: 'high: Wrong. Fix it' }, rank: 0, stage: 'On hold' }) },
  ];
}

test('rows sort decisions first by newest activity, show one state, one reason and one button, and act without opening', () => {
  const act = vi.fn().mockResolvedValue(true), select = vi.fn(), openNext = vi.fn();
  render(<GoalsList goals={goals()} chip="All" onChip={vi.fn()} disabled={false} act={act} select={select} openNext={openNext} projectName={() => 'Example'} />);
  const rows = screen.getAllByRole('article').map(row => row.getAttribute('aria-label'));
  expect(rows).toEqual(['Needs revision', 'Held goal', 'Active goal', 'Merged goal', 'Aborted goal']);
  const held = screen.getByRole('article', { name: 'Held goal' });
  expect(within(held).getByText('The goal is on hold.')).toBeTruthy();
  expect(within(held).getByText('The planner stopped before it finished. Recover to run it again.')).toBeTruthy();
  fireEvent.click(within(held).getByRole('button', { name: 'Recover goal' }));
  expect(act).toHaveBeenCalledWith(expect.objectContaining({ id: 'held' }), recover);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('article', { name: 'Needs revision' })).getByRole('button', { name: 'Request revision' }));
  expect(openNext).toHaveBeenCalledWith('revise', expect.objectContaining({ type: 'request_revision' }));
  fireEvent.click(within(held).getByRole('button', { name: 'Open Held goal' }));
  expect(select).toHaveBeenCalledWith('held');
});

test('chips filter by rank and empty states name the chip', () => {
  const onChip = vi.fn();
  const view = render(<GoalsList goals={goals()} chip="Needs you" onChip={onChip} disabled={false} act={vi.fn()} select={vi.fn()} openNext={vi.fn()} projectName={() => 'Example'} />);
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Needs revision', 'Held goal']);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onChip).toHaveBeenCalledWith('Done');
  view.rerender(<GoalsList goals={goals()} chip="Done" onChip={onChip} disabled={false} act={vi.fn()} select={vi.fn()} openNext={vi.fn()} projectName={() => 'Example'} />);
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Merged goal', 'Aborted goal']);
  view.rerender(<GoalsList goals={[goals()[0]]} chip="Needs you" onChip={onChip} disabled={false} act={vi.fn()} select={vi.fn()} openNext={vi.fn()} projectName={() => 'Example'} />);
  expect(screen.getByText('Nothing needs you')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
  view.rerender(<GoalsList goals={goals()} chip="All" onChip={onChip} disabled={false} act={vi.fn()} select={vi.fn()} openNext={vi.fn()} projectName={() => 'Example'} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
  expect(screen.getByText('No matching goals')).toBeTruthy();
});

test('read-only disables every row button', () => {
  render(<GoalsList goals={goals()} chip="All" onChip={vi.fn()} disabled act={vi.fn()} select={vi.fn()} openNext={vi.fn()} projectName={() => 'Example'} />);
  expect(screen.getAllByRole('button', { name: /Recover goal|Request revision|More/ }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});
```

- [ ] **Step 2: Run** `npm run test:ui -- tests/ui-goals-list.test.tsx` → FAIL, module missing.

- [ ] **Step 3: Implement `app/orchestration/goals-list.tsx`:**

```tsx
"use client";
import { useState } from 'react';
import type { Action, Goal } from './goal-board';
import { activityLabel } from './goal-activity';
import { DecisionActions } from './decision-bar';

export const CHIPS = ['All', 'Needs you', 'Active', 'Done'] as const;
export type Chip = typeof CHIPS[number];
const inChip = (goal: Goal, chip: Chip) => chip === 'All' || (chip === 'Needs you' ? goal.decision.rank === 0 : chip === 'Active' ? goal.decision.rank === 1 : goal.decision.rank >= 2);
const EMPTY: Record<Chip, string> = { All: 'Your first goal starts here', 'Needs you': 'Nothing needs you', Active: 'No active goals', Done: 'No finished goals' };

export function GoalsList({ goals, chip, onChip, disabled, act, select, openNext, projectName }: {
  goals: Goal[]; chip: Chip; onChip(chip: Chip): void; disabled: boolean;
  act(goal: Goal, action: Action): Promise<boolean>; select(id: string): void; openNext(id: string, next: NonNullable<Goal['decision']['next']>): void; projectName(id: string): string;
}) {
  const [search, setSearch] = useState('');
  const visible = goals
    .filter(goal => inChip(goal, chip) && `${goal.title} ${projectName(goal.repositoryId)}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.decision.rank - b.decision.rank || Date.parse(b.lastActivity?.createdAt ?? '0') - Date.parse(a.lastActivity?.createdAt ?? '0'));
  return <section aria-label="Goals">
    <div className="goals-tools">
      <div className="mission-filters" aria-label="Filter goals">{CHIPS.map(value => <button key={value} aria-pressed={chip === value} onClick={() => onChip(value)}>{value}</button>)}</div>
      <label className="mission-search"><span className="sr-only">Search goals and projects</span><input type="search" placeholder="Search goals or projects" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>
    <div className="goals-rows">
      {visible.map(goal => <article className="goal-row" key={goal.id} aria-label={goal.title}>
        <button type="button" className="goal-row-open" aria-label={`Open ${goal.title}`} onClick={() => select(goal.id)}>
          <strong>{goal.title}</strong><small>{projectName(goal.repositoryId)}</small>
          <p className="decision-state">{goal.decision.state}</p>
          {goal.decision.reason && <p className="decision-reason">{goal.decision.reason}</p>}
        </button>
        <div className="goal-row-actions"><DecisionActions goal={goal} disabled={disabled} act={act} openNext={next => openNext(goal.id, next)} /></div>
        <footer><span className={`mission-badge ${goal.decision.rank === 0 ? 'attention' : goal.status === 'merged' ? 'complete' : ''}`}>{goal.decision.stage}</span>{goal.lastActivity && <small>{activityLabel(goal.lastActivity.kind)} · <time dateTime={goal.lastActivity.createdAt}>{new Date(goal.lastActivity.createdAt).toLocaleString()}</time></small>}</footer>
      </article>)}
      {!visible.length && <div className="mission-empty"><h3>{search ? 'No matching goals' : EMPTY[chip]}</h3><p>{search ? 'Try another search.' : chip === 'All' ? 'Choose a project and describe the outcome you want.' : 'Decisions, questions and recovery steps appear here when they are yours to take.'}</p></div>}
    </div>
  </section>;
}
```

- [ ] **Step 4: Extract `DecisionActions` from the bar.** In `decision-bar.tsx`, move the primary button, the "More" disclosure and the rename form into an exported `DecisionActions({ goal, disabled, act, openNext })` component. The primary renders `decision.primary` when set, else `decision.next` as a button that calls `openNext(next)`. `DecisionBar` keeps the heading, state and reason and renders `<DecisionActions … />` in `.decision-controls`. `DecisionBar` gains an `openNext` prop and passes it through. Update `tests/ui-decision-bar.test.tsx`: add one test that a `next` renders as the primary and calls `openNext`.

- [ ] **Step 5: Navigation.** In `app/navigation.tsx` replace the two entries with `['goals', '/orchestration', 'Goals', '▤']` and narrow the `active` union to `'usage' | 'sessions' | 'goals' | 'settings'`; same in `app/mission-shell.tsx`. In `goal-board.tsx`: delete `fleetFilter`, `needsOnly`; add `const [chip, setChip] = useState<Chip>(() => new URLSearchParams(window.location.search).get('view') === 'needs' ? 'Needs you' : 'All')` and on mount, when `view=needs`, replace the URL with `/orchestration` (keep `goal` if present). Replace the heading block with `<p className="orch-eyebrow">GOALS</p><h1>Goals</h1>`. Remove the execution capacity `<details>`. Replace `<GoalFleet …/>` with `<GoalsList goals chip onChip={setChip} disabled act select openNext={(id, next) => { select(id); setPendingNext(next); }} projectName />`. Add `const [pendingNext, setPendingNext] = useState<Goal['decision']['next']>(null)` and pass `pendingNext` and `onNextConsumed={() => setPendingNext(null)}` to `GoalDetail`. The `MissionShell` `active` is always `'goals'`.

- [ ] **Step 6: Delete** `goal-fleet.tsx`, `attention.ts`, `tests/ui-mission-control.test.tsx`. Grep `attention(\|goalStage(\|GoalFleet\|goal-fleet` across `app tests cypress` and fix every hit (the `decision-bar.tsx` stage badge reads `goal.decision.stage`).

- [ ] **Step 7: Styles.** Append:

```css
.goals-tools { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin:18px 0; }
.goals-rows { display:grid; gap:12px; }
.goal-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px 16px; padding:16px 18px; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
.mission-control .goal-row-open { grid-column:1; min-height:0; padding:0; border:0; background:none; text-align:left; display:grid; gap:4px; }
.goal-row-open strong { font-size:17px; } .goal-row-open small { color:var(--muted); }
.goal-row-actions { grid-column:2; grid-row:1; display:flex; align-items:flex-start; }
.goal-row footer { grid-column:1 / -1; display:flex; align-items:center; gap:12px; color:var(--muted); font-size:12px; }
@media(max-width:700px) { .goal-row { grid-template-columns:minmax(0,1fr); } .goal-row-actions { grid-column:1; grid-row:auto; } .goal-row-actions .decision-primary { flex:1; } }
```

Remove the `.mission-stats`, `.mission-stat`, `.mission-fleet*` and `.mission-workers` rules.

- [ ] **Step 8: Fix the navigation tests.** `tests/ui-goals-navigation.test.tsx` expects `['◴Account usage', '▤Goals', '▣Sessions', '⚙Setup']`. `tests/ui-features.test.tsx` and `tests/ui-page.test.tsx`: `'Mission Control'` → `'Goals'`. In `tests/ui-orchestration.test.tsx`: `Back to Mission Control` → `Back to Goals` (the back button text becomes `← Back to Goals`), `'Mission Control opens first…'` test title and any `findByRole('heading', { name: 'Mission Control' })` → `'Goals'`; the Needs You test at line 512 asserts via chips: render, click `Needs you`, expect the row absent.

- [ ] **Step 9: Run** `npm run test:ui && npx tsc --noEmit && npx eslint app tests --quiet`. Fix until green.

- [ ] **Step 10: Commit** `feat: replace Mission Control and Needs You with one Goals list`.

---

### Task 3: One goal page

**Files:** create `app/orchestration/goal-page.tsx`, `tests/ui-goal-page.test.tsx`; modify `goal-detail.tsx`, `goal-conversation.tsx`, `goal-board.tsx`, `orchestration.css`, `tests/ui-orchestration.test.tsx`, `tests/ui-goal-conversation.test.tsx`.

- [ ] **Step 1: Write failing tests** in `tests/ui-goal-page.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalDetail } from '../app/orchestration/goal-detail';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture, contract } from './helpers/orchestration/domain-fixture.mjs';

afterEach(cleanup);
const props = { disabled: false, terminal: false, act: vi.fn(async () => true), control: vi.fn(async () => {}), pendingNext: null, onNextConsumed: vi.fn() };

test('a legacy goal renders the shared layout: bar, request, collapsed contract, revision composer and technical details', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  const goal = { ...goalView(f.goal), description: 'Build the modules\nhttps://example.com/design', contracts: f.goal.contracts };
  render(<GoalDetail {...props} goal={goal} />);
  expect(screen.getByRole('region', { name: 'Goal decision' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Your request' }).textContent).toContain('https://example.com/design');
  const proposal = screen.getByRole('region', { name: 'Proposal revision 1' });
  expect(within(proposal).getByText('1 scope item · 1 acceptance criterion · 1 check · 3 tasks')).toBeTruthy();
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.change(screen.getByLabelText('Request a revision'), { target: { value: 'Narrow the scope.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send revision request' }));
  expect(props.act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'request_revision', payload: { message: 'Narrow the scope.' } }));
  const details = screen.getByRole('group', { name: 'Technical details' });
  fireEvent.click(within(details).getByText('Technical details'));
  for (const heading of ['Source', 'Waves and sessions', 'Team and models', 'Activity']) expect(within(details).getByRole('heading', { name: heading })).toBeTruthy();
});

test('a pending next step prefills and focuses the composer, then is consumed', () => {
  const f = fixture(); f.command('publish_contract', { contract: contract() }, f.user);
  const goal = { ...goalView(f.goal), contracts: f.goal.contracts };
  const onNextConsumed = vi.fn();
  render(<GoalDetail {...props} goal={goal} onNextConsumed={onNextConsumed} pendingNext={{ type: 'request_revision', label: 'Request revision', context: 'high: Wrong value. Return two' }} />);
  const box = screen.getByLabelText('Request a revision') as HTMLTextAreaElement;
  expect(box.value).toBe('high: Wrong value. Return two\n\n');
  expect(document.activeElement).toBe(box);
  expect(onNextConsumed).toHaveBeenCalled();
});

test('a legacy planner question renders its answer form above the composer', () => {
  const goal = { ...goalView(fixture().goal), contracts: [], clarification: { question: 'Which module first?' }, actions: [{ type: 'answer_clarification', label: 'Send answer', payload: { answer: '' } }] };
  render(<GoalDetail {...props} goal={goal} />);
  expect(screen.getByText('Which module first?')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(props.act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'answer_clarification', payload: { answer: 'A' } }));
});
```

- [ ] **Step 2: Run** → FAIL on `Your request`.

- [ ] **Step 3: Rework `goal-detail.tsx`.** Rename `LegacyGoalDetail` to `GoalTechnicalDetails` and export it. Remove the tabs, the tab state, the top card, the clarification form, the contract card, the revision form and the "Planning the outcome" card. Render every former section stacked, each with an `h3`: "Source" (base branch, integrated head, reconcile button, PR link, merge sync line, review round phase, publication lines, plan review messages, references), "Waves and sessions" (`WaveBoard` + agent activity), "Team and models" (`GoalTeam`), "Integration", "Review rounds", "Independent reviews", "Combined verification", "Verification runs", "Activity" (`GoalActivity`). Keep every existing element and label inside those sections. Wrap in `<div className="goal-technical">`.

Create `app/orchestration/goal-page.tsx`:

```tsx
"use client";
import type { Contract } from '../../server/orchestration/types';
import type { Action, Goal } from './goal-board';
import { DecisionBar } from './decision-bar';
import { GoalConversation } from './goal-conversation';
import { GoalTechnicalDetails } from './goal-detail';

export type Next = Goal['decision']['next'];
export function GoalPage({ goal, disabled, terminal, act, control, pendingNext, onNextConsumed }: {
  goal: Goal & { contracts: { revision: number; contract: Contract }[] }; disabled: boolean; terminal: boolean;
  act(goal: Goal, action: Action): Promise<boolean>; control(goal: Goal, action: 'terminal' | 'reconcile', attemptId?: string): Promise<void>;
  pendingNext: Next; onNextConsumed(): void;
}) {
  return <>
    <DecisionBar goal={goal} disabled={disabled} act={act} openNext={next => { /* handled by the conversation through pendingNext */ onNextConsumed(); setLocal(next); }} />
    …
  </>;
}
```

Simplest workable shape: `GoalPage` holds `const [local, setLocal] = useState<Next>(null)` and passes `pendingNext ?? local` to `GoalConversation` as `next`, with `onNextConsumed={() => { setLocal(null); onNextConsumed(); }}`. Then renders `<GoalConversation goal disabled act next onNextConsumed />` and `<details className="orch-card" role="group" aria-label="Technical details"><summary>Technical details</summary><GoalTechnicalDetails goal disabled terminal act control /></details>`. `goal-detail.tsx` exports `GoalDetail = GoalPage` for the existing import in `goal-board.tsx` (or update the import).

- [ ] **Step 4: Extend `GoalConversation`.** New props `next: Next; onNextConsumed(): void`. Remove the `if (!conversation) return null` early return. Build `messages`: when `conversation` exists use its messages; otherwise synthesize `[{ id: 'request', author: 'user', kind: 'message', text: goal.description || goal.title, revision: 0, delivery: 'answered' }, ...goal.contracts.map(entry => ({ id: `contract-${entry.revision}`, author: 'supervisor', kind: 'proposal', text: '', revision: entry.revision, delivery: 'delivered' }))]`. Render the legacy request card with `aria-label="Your request"` and eyebrow "Your request"; no delivery small for it. The composer: when `conversation` exists keep "Message your supervisor" and `send_goal_message`; otherwise label "Request a revision", button "Send revision request", action `request_revision` with `payload: { message }`; when neither action is offered, hide the composer. Legacy clarification: when `goal.clarification?.answer === undefined` and `answer_clarification` is offered and no conversation exists, render the answer form (`<h3>A question from your planner</h3>`, textarea "Your answer", button "Send answer") above the composer. Prefill: `useEffect(() => { if (!next) return; if (next.type === 'request_revision') setMessage(`${next.context}\n\n`); textarea.current?.focus(); onNextConsumed(); }, [next])` with a `useRef` on the textarea; for `answer_clarification` focus the answer textarea instead.

- [ ] **Step 5: Update existing tests.** In `tests/ui-orchestration.test.tsx` every `render(<GoalDetail …/>)` gains `pendingNext={null} onNextConsumed={vi.fn()}`; tests that click a `tab` instead open the "Technical details" group first and query inside it; `'failed revision feedback remains editable…'` uses label "Request a revision" and button "Send revision request"; the `No review or verification evidence yet` assertions move inside the group. In `tests/ui-goal-conversation.test.tsx` pass `next={null} onNextConsumed={vi.fn()}`.

- [ ] **Step 6: Run** `npm run test:ui && npx tsc --noEmit && npx eslint app tests --quiet`.

- [ ] **Step 7: Commit** `feat: render every goal in one page layout with a technical disclosure`.

---

### Task 4: Composer default

**Files:** `app/orchestration/goal-board.tsx`, `tests/ui-orchestration.test.tsx`

- [ ] **Step 1: Failing test:**

```tsx
test('the composer uses the supervisor flow when a profile exists and the planner flow with a note otherwise', async () => {
  const original = api.getMockImplementation()!;
  api.mockImplementation(async (url, options) => url.endsWith('/supervisors') ? { recommendedId: 'codex', profiles: [{ id: 'codex', label: 'Codex', model: 'gpt', ready: true, reason: 'Ready', capacity: { reason: '' } }] } : original(url, options));
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Start a goal' }));
  expect(screen.queryByLabelText('Try conversational Goals (evaluation)')).toBeNull();
  expect(await screen.findByLabelText('Supervisor')).toHaveProperty('value', 'codex');
  cleanup();
  api.mockImplementation(async (url, options) => url.endsWith('/supervisors') ? { recommendedId: null, profiles: [] } : original(url, options));
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Start a goal' }));
  expect(await screen.findByText('Add a supervisor in Setup for conversational goals.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Setup' })).toBeTruthy();
});
```

Check how `start()` is defined in that file and the exact supervisors response shape in `server/orchestration/types.d.ts` (`SupervisorChoices`) before running.

- [ ] **Step 2: Implement.** Remove the checkbox and `conversational` state. Add `const [supervisors, setSupervisors] = useState<SupervisorChoices | null | undefined>(undefined)` loaded once when `creating` becomes true. `conversational = Boolean(supervisors?.profiles.length)`. Render `SupervisorPicker` when conversational; otherwise `<p>Add a supervisor in <a href="/settings">Setup</a> for conversational goals.</p>` with link text exactly "Setup" (adjust the test to that link name). Submit payload uses `experienceVersion: 2` when conversational. The Start button stays disabled while `supervisors === undefined`.

- [ ] **Step 3: Run tests, typecheck, lint. Commit** `feat: default new goals to the supervisor flow`.

---

### Task 5: Browser checks and verification

- [ ] **Step 1: Rename** `cypress/e2e/mission-control.cy.ts` → `goals-list.cy.ts`. Rewrite: intercept a snapshot with three goals carrying `decision` objects (rank 0 with `primary`, rank 1, rank 3); visit `/orchestration`; assert the heading "Goals", the row order, that clicking the row button posts the command (intercept `POST **/api/orchestration/commands` and assert the body type), and that `?view=needs` lands with the "Needs you" chip pressed. Keep the `width` loop for 1440 and 390 and the horizontal-scroll assertion.
- [ ] **Step 2: Update label assertions** `'Mission Control'` → `'Goals'` in `goals-navigation`, `account-usage`, `pairing`, `launch`, `settings-onboarding`, `ui-consistency`; `Back to Mission Control` → `Back to Goals` in `goal-workspace`, `orchestration-core`; in `goal-workspace.cy.ts` the fixture goals need `decision` objects with `rank` and `stage`; tabs assertions become "Technical details" group assertions; in `orchestration-core.cy.ts` the `Waves & sessions` tab clicks become opening the Technical details group; `Needs you` button clicks stay (it is now a chip with the same name).
- [ ] **Step 3: Run** `npm run test:e2e:local -- --spec cypress/e2e/goals-list.cy.ts`, then `goal-workspace`, then `--orchestration` for `orchestration-core` and `orchestration-conversation`. Fix failures.
- [ ] **Step 4: Run** `npm run verify`.
- [ ] **Step 5: Commit** `test: drive the Goals list and shared goal page in browser checks`.
