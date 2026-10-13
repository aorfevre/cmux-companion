# Goal Decision Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put one state, one reason and one primary action at the top of both goal pages, and shrink the proposal card and thread, per `docs/superpowers/specs/2026-10-13-goal-decision-bar-design.md`.

**Architecture:** A pure `decisionView(goal)` in the domain computes `{ state, reason, primary }` from the goal and its already projected actions. The state view includes it as `goal.decision`. One shared `DecisionBar` React component renders it above both goal pages. The conversational proposal card and message rendering collapse by default.

**Tech Stack:** Node 22 ESM domain code with JSDoc types checked by `tsc --project tsconfig.backend.json`; React 19 client components; node:test for the backend; Vitest and Testing Library for the UI; Cypress for browser checks.

---

## File structure

- Create `server/orchestration/domain/decision-view.mjs`: pure decision ladder.
- Modify `server/orchestration/domain/state-view.mjs`: include `decision`.
- Create `tests/orchestration-decision-view.test.mjs`: ladder and observed scenario tests.
- Create `app/orchestration/decision-bar.tsx`: shared bar, "More" menu, inline title form.
- Modify `app/orchestration/goal-detail.tsx`: render the bar, remove the legacy header controls.
- Modify `app/orchestration/goal-conversation.tsx`: remove the header card and card buttons, collapse proposals and long messages.
- Modify `app/orchestration/orchestration.css`: bar, menu, collapsed proposal and clamp styles.
- Create `tests/ui-decision-bar.test.tsx`: bar rendering and attention agreement.
- Modify `tests/ui-goal-conversation.test.tsx`, `tests/ui-orchestration.test.tsx`, `tests/ui-mission-control.test.tsx`: follow the new controls.
- Modify `cypress/e2e/orchestration-core.cy.ts`, `cypress/e2e/orchestration-conversation.cy.ts`, `cypress/e2e/goal-workspace.cy.ts`: open "More" for secondary actions, check the phone layout.

Run commands from the repository root with the Node version in `.nvmrc`.

---

### Task 1: Decision view in the domain

**Files:**
- Create: `server/orchestration/domain/decision-view.mjs`
- Modify: `server/orchestration/domain/state-view.mjs`
- Test: `tests/orchestration-decision-view.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { decisionView } from '../server/orchestration/domain/decision-view.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture, contract, BASE, HEAD_A, HEAD_B } from './helpers/orchestration/domain-fixture.mjs';

const primary = goal => decisionView(goal).primary?.type ?? null;

test('startup failure, approval, publication and terminal states pick the first offered primary', () => {
  const f = fixture();
  f.command('fail_startup', { error: 'Repository is owned by another service.' });
  assert.deepEqual(decisionView(f.goal), { state: 'Repository is owned by another service.', reason: null, primary: { type: 'retry_startup', label: 'Retry startup', payload: {} } });
  const ready = fixture();
  ready.command('publish_contract', { contract: contract() }, ready.user);
  assert.equal(decisionView(ready.goal).state, 'Your plan waits on a blocker.');
  assert.equal(decisionView(ready.goal).reason, 'Independent plan review must accept this revision');
  assert.equal(primary(ready.goal), null);
  ready.request('plan_review', 'reviewer'); ready.dispatch('plan_review'); ready.review('plan_review', `contract:${ready.goal.revision}`);
  assert.equal(decisionView(ready.goal).state, 'Your plan is ready to approve.');
  assert.equal(decisionView(ready.goal).primary.label, 'Approve revision 1');
  const delivered = fixture(); delivered.deliver();
  assert.equal(decisionView(delivered.goal).state, 'Pull request published. Waiting for merge.');
  assert.equal(primary(delivered.goal), null);
  delivered.command('abort', {}, delivered.user);
  assert.equal(decisionView(delivered.goal).state, 'Aborted. Evidence is retained.');
});

test('the publication gate and a moved target are primaries, and progress has none', () => {
  const f = fixture();
  const single = contract(); single.tasks = [single.tasks[0]]; f.approve(single);
  assert.deepEqual(decisionView(f.goal), { state: 'Work continues automatically. No action needed.', reason: null, primary: null });
  f.request('a', 'implementer', 'A'); f.dispatch('a');
  assert.equal(decisionView(f.goal).state, '1 agent working.');
  f.command('confirm_candidate', { attemptId: 'a', headSha: HEAD_A }); f.command('record_stopped', { attemptId: 'a' });
  f.request('ar', 'reviewer', 'A'); f.dispatch('ar'); f.review('ar', HEAD_A);
  f.command('request_integration', { taskId: 'A', operationId: 'integrate' });
  f.command('record_integration', { operationId: 'integrate', headSha: HEAD_B });
  f.request('final', 'reviewer'); f.dispatch('final'); f.review('final', HEAD_B);
  f.command('record_verification', { headSha: HEAD_B, checks: [{ id: 'unit', passed: true, artifactId: 'log' }] });
  f.command('request_publication', { operationId: 'publish' });
  assert.equal(decisionView(f.goal).state, 'The verified result waits for your publication approval.');
  assert.equal(primary(f.goal), 'approve_publication');
});

test('a held goal recovers first, then approves, and a running worker explains the refusal', () => {
  const f = fixture(); f.request('planner', 'planner'); f.dispatch('planner');
  f.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  const held = decisionView(f.goal);
  assert.equal(held.state, 'The goal is on hold.');
  assert.equal(held.reason, 'Let active workers finish and reconcile uncertain ownership before recovery');
  assert.equal(held.primary, null);
  f.command('record_stopped', { attemptId: 'planner' });
  const stopped = decisionView(f.goal);
  assert.equal(stopped.reason, 'planner did not finish successfully.');
  assert.equal(stopped.primary.label, 'Recover goal');
  f.recover();
  assert.equal(decisionView(f.goal).state, 'Work continues automatically. No action needed.');
});

test('the observed supervisor scenario recovers then approves revision 3 from the bar', t => {
  const store = new OrchestrationStore({ path: ':memory:' }); t.after(() => store.close());
  let next = 0; const user = { kind: 'user' }, system = { kind: 'system' };
  const command = (type, payload = {}, authority = user) => store.apply({ id: `c${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, authority);
  command('create_goal', { repositoryId: 'repo', title: 'Session in mobile', baseSha: BASE, experienceVersion: 2 });
  command('request_attempt', { attemptId: 'supervisor', operationId: 'launch', role: 'planner', conversationId: 'native' }, system);
  command('record_dispatch', { attemptId: 'supervisor', identity: 'owned', worktree: '/tmp/s', branch: 'goal/s' }, system);
  const authority = { kind: 'agent', goalId: 'g', attemptId: 'supervisor', role: 'planner', generation: 1, revision: 0 };
  command('supervisor_propose', { contract: contract() }, authority);
  command('request_attempt', { attemptId: 'review', operationId: 'review_launch', role: 'reviewer', conversationId: 'review_native' }, system);
  command('record_dispatch', { attemptId: 'review', identity: 'review_owned', worktree: '/tmp/r', branch: 'goal/r' }, system);
  command('record_review', { attemptId: 'review', reviewId: 'r1', review: { schemaVersion: 1, target: `contract:${store.get('g').revision}`, disposition: 'accept', findings: [] } }, system);
  command('record_stopped', { attemptId: 'supervisor' }, system);
  const view = goalView(store.get('g'));
  assert.equal(view.decision.state, 'The goal is on hold.');
  assert.equal(view.decision.reason, 'planner did not finish successfully.');
  assert.equal(view.decision.primary.type, 'recover_goal');
  assert.equal(view.decision.primary.label, 'Recover goal');
  command('recover_goal', view.decision.primary.payload);
  const recovered = goalView(store.get('g'));
  assert.equal(recovered.decision.state, 'Your plan is ready to approve.');
  assert.equal(recovered.decision.primary.label, `Approve revision ${recovered.revision}`);
  command('pause_goal', {});
  assert.equal(goalView(store.get('g')).decision.state, 'Paused.');
  assert.equal(goalView(store.get('g')).decision.primary.type, 'resume_goal');
});

test('clarification questions and failed tasks or attempts become the state', () => {
  const f = fixture();
  f.goal.clarification = { question: 'Which module first?' };
  assert.deepEqual(decisionView(f.goal), { state: 'Which module first?', reason: null, primary: null });
  const failed = fixture(); failed.approve();
  failed.goal.tasks[0].status = 'failed';
  assert.equal(decisionView(failed.goal).state, 'A task needs a retry.');
  assert.equal(decisionView(failed.goal).primary.type, 'retry_task');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/orchestration-decision-view.test.mjs`
Expected: FAIL with `Cannot find module '.../decision-view.mjs'`.

- [ ] **Step 3: Write the decision view**

Create `server/orchestration/domain/decision-view.mjs`:

```js
import { isSupervisor } from './conversation.mjs';
import { actionView } from './action-view.mjs';

/** The browser shows one state, one reason and one primary action. It derives
 * nothing else; the action projection stays the only authority.
 * @typedef {{ type: string; label: string; payload: Record<string, unknown> }} ProjectedAction
 * @typedef {{ state: string; reason: string | null; primary: ProjectedAction | null }} Decision */
const PRIMARY_ORDER = ['retry_startup', 'recover_goal', 'approve', 'accept_moved_target', 'approve_publication', 'request_review_fix', 'retry_task', 'retry_attempt', 'retry_integration', 'retry_verification', 'authorize_repair', 'resume_goal'];

/** @param {import('../types.d.ts').Goal} goal @param {ReturnType<typeof actionView>} [projected] @returns {Decision} */
export function decisionView(goal, projected = actionView(goal)) {
  const { actions, approvalBlocked, recoveryBlocked } = projected;
  const offered = actions.filter(action => action.type !== 'recover_goal' || action.payload.mode === undefined);
  const primary = PRIMARY_ORDER.map(type => offered.find(action => action.type === type)).find(Boolean) ?? null;
  const decision = (/** @type {string} */ state, /** @type {string | null} */ reason = null, keep = true) => ({ state, reason, primary: keep ? primary : null });
  if (goal.startup?.status === 'failed') return decision(goal.startup.error || 'Could not prepare the base branch.');
  if (goal.hold) return decision('The goal is on hold.', recoveryBlocked ?? goal.hold.reasons.map(reason => reason.message).join(' '));
  if (goal.clarification && goal.clarification.answer === undefined) return decision(goal.clarification.question, null, false);
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

Note: `recoveryBlocked` from the action projection is the refusal message of the plain "Recover goal" action, or null when it is offered. The "Retry verification & resume" recovery action carries `payload.mode`, so the filter above keeps the plain one as the primary. The moved-target, closed-PR and uncertain-push steps were added to the spec after review; this example matches the amended spec.

- [ ] **Step 4: Include the decision in the state view**

In `server/orchestration/domain/state-view.mjs`, add the import after the `actionView` import:

```js
import { decisionView } from './decision-view.mjs';
```

Change the start of the returned object in `goalView` from:

```js
  return { ...actionView(goal), experienceVersion: goal.experienceVersion ?? 1,
```

to:

```js
  const projected = actionView(goal);
  return { ...projected, decision: decisionView(goal, projected), experienceVersion: goal.experienceVersion ?? 1,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/orchestration-decision-view.test.mjs`
Expected: PASS, 5 tests. If the paused step fails because `pause_goal` is refused on a goal in `awaiting_approval`, keep the ladder order and move the pause assertion in the observed scenario before the `recover_goal` command; the hold step still wins over the paused step, so assert `state` is `'The goal is on hold.'` there and remove the paused assertions from that test.

- [ ] **Step 6: Typecheck the backend and run the full backend suite**

Run: `npx tsc --project tsconfig.backend.json && npm test`
Expected: no type errors; all backend tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/orchestration/domain/decision-view.mjs server/orchestration/domain/state-view.mjs tests/orchestration-decision-view.test.mjs
git commit -m "feat: project one goal decision state, reason and primary action"
```

---

### Task 2: Shared decision bar component

**Files:**
- Create: `app/orchestration/decision-bar.tsx`
- Modify: `app/orchestration/orchestration.css`
- Test: `tests/ui-decision-bar.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { DecisionBar } from '../app/orchestration/decision-bar';
import { attention } from '../app/orchestration/attention';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';
import type { Goal } from '../app/orchestration/goal-board';

afterEach(cleanup);
const base = (): Goal => goalView(fixture().goal);

test('the bar shows stage, state, reason, the primary action and secondary actions behind More', () => {
  const goal: Goal = { ...base(), title: 'Session in mobile', status: 'awaiting_approval', planReviewPending: false,
    decision: { state: 'Your plan is ready to approve.', reason: null, primary: { type: 'approve', label: 'Approve revision 3', payload: { revision: 3 } } },
    actions: [{ type: 'approve', label: 'Approve revision 3', payload: { revision: 3 } }, { type: 'pause_goal', label: 'Pause goal', payload: {} }, { type: 'send_goal_message', label: 'Send message', payload: {} }, { type: 'rename_goal', label: 'Edit title', payload: { title: 'Session in mobile' } }, { type: 'abort', label: 'Abort goal', payload: {} }] };
  const act = vi.fn().mockResolvedValue(true);
  render(<DecisionBar goal={goal} disabled={false} act={act} />);
  const bar = screen.getByRole('region', { name: 'Goal decision' });
  expect(bar.textContent).toContain('Needs approval');
  expect(screen.getByRole('heading', { name: 'Session in mobile' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Your plan is ready to approve.');
  expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve revision 3' }));
  expect(act).toHaveBeenCalledWith(goal, goal.actions[0]);
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.queryByRole('menuitem', { name: 'Send message' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Approve revision 3' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Abort goal' }));
  expect(act).toHaveBeenCalledWith(goal, goal.actions[4]);
});

test('a refused action renders as the reason with no primary button', () => {
  const goal: Goal = { ...base(), hold: { id: 'hold', reasons: [{ kind: 'attempt', target: 'planner', message: 'planner did not finish successfully.' }] },
    decision: { state: 'The goal is on hold.', reason: 'Let active workers finish and reconcile uncertain ownership before recovery', primary: null }, actions: [{ type: 'abort', label: 'Abort goal', payload: {} }] };
  render(<DecisionBar goal={goal} disabled={false} act={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toBe('The goal is on hold.');
  expect(screen.getByText('Let active workers finish and reconcile uncertain ownership before recovery')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Goal decision' }).querySelector('.decision-primary')).toBeNull();
});

test('Edit title opens the inline form and saves through the rename action', async () => {
  const goal: Goal = { ...base(), title: 'Short title', decision: { state: 'Work continues automatically. No action needed.', reason: null, primary: null },
    actions: [{ type: 'rename_goal', label: 'Edit title', payload: { title: 'Short title' } }] };
  const act = vi.fn().mockResolvedValue(true);
  render(<DecisionBar goal={goal} disabled={false} act={act} />);
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit title' }));
  fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Better title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
  expect(act).toHaveBeenCalledWith(goal, expect.objectContaining({ type: 'rename_goal', payload: { title: 'Better title' } }));
  await screen.findByRole('button', { name: 'More' });
  expect(screen.queryByLabelText('Goal title')).toBeNull();
});

test('every fleet attention case has a primary, a question or a hold in the decision view', () => {
  const held = fixture(); held.request('planner', 'planner'); held.dispatch('planner');
  held.command('record_failure', { attemptId: 'planner', uncertain: true, error: 'Lost connection' });
  const approved = fixture(); approved.command('publish_contract', { contract: (await import('./helpers/orchestration/domain-fixture.mjs')).contract() }, approved.user);
  const cases: Goal[] = [
    goalView(held.goal),
    { ...base(), startup: { status: 'failed', error: 'Repository is owned by another service.' } },
    { ...base(), clarification: { question: 'Which module?' } },
    { ...base(), status: 'awaiting_approval', planReviewPending: false },
  ].map(goal => ({ ...goal, decision: goalView({ ...fixture().goal, ...goal } as never).decision }));
  for (const goal of cases) {
    expect(attention(goal), goal.id).toBeTruthy();
    const decision = goal.decision;
    expect(Boolean(decision.primary) || Boolean(goal.hold) || decision.state === goal.clarification?.question, decision.state).toBe(true);
  }
});
```

Replace the `approved` line in the last test with nothing; it is unused. Keep the four cases. The fourth case needs the domain goal in `awaiting_approval`: build it as `const planned = fixture(); planned.command('publish_contract', { contract: contract() }, planned.user); planned.request('plan_review', 'reviewer'); planned.dispatch('plan_review'); planned.review('plan_review', \`contract:${planned.goal.revision}\`);` and use `goalView(planned.goal)` directly instead of the spread form. Import `contract` from the domain fixture at the top of the file. Write the cases as direct `goalView` calls over domain goals, not spreads over the view, so `decision` is real.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:ui -- tests/ui-decision-bar.test.tsx`
Expected: FAIL with `Failed to resolve import "../app/orchestration/decision-bar"`.

- [ ] **Step 3: Write the component**

Create `app/orchestration/decision-bar.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from 'react';
import type { Action, Goal } from './goal-board';
import { goalStage } from './goal-fleet';

const COMPOSER_TYPES = new Set(['send_goal_message', 'request_revision', 'answer_clarification', 'override_assignment']);

export function DecisionBar({ goal, disabled, act }: { goal: Goal; disabled: boolean; act(goal: Goal, action: Action): Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(goal.title);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const { decision } = goal;
  const primary = decision.primary;
  const secondary = goal.actions.filter(action => !COMPOSER_TYPES.has(action.type) && !(primary && action.type === primary.type && JSON.stringify(action.payload) === JSON.stringify(primary.payload)));
  const rename = goal.actions.find(action => action.type === 'rename_goal');
  const choose = (action: Action) => {
    setOpen(false);
    if (action.type === 'rename_goal') { setTitle(goal.title); setEditing(true); return; }
    void act(goal, action);
  };
  return <section className="decision-bar" aria-label="Goal decision">
    <div className="decision-heading">
      <span className={`mission-badge ${primary || goal.hold ? 'attention' : goal.status === 'merged' ? 'complete' : ''}`}>{goalStage(goal)}</span>
      <h1>{goal.title}</h1>
    </div>
    <div className="decision-body">
      <div className="decision-text">
        <p role="status" className="decision-state">{decision.state}</p>
        {decision.reason && <p className="decision-reason">{decision.reason}</p>}
      </div>
      <div className="decision-controls">
        {primary && <button className="primary-button decision-primary" disabled={disabled} onClick={() => void act(goal, primary)}>{primary.label}</button>}
        {secondary.length > 0 && <div className="decision-menu" ref={menu}>
          <button aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)}>More</button>
          {open && <div role="menu" aria-label="More actions">{secondary.map(action => <button role="menuitem" key={`${action.type}:${JSON.stringify(action.payload)}`} onClick={() => choose(action)}>{action.label}</button>)}</div>}
        </div>}
      </div>
    </div>
    {editing && rename && <form className="decision-rename" onSubmit={event => { event.preventDefault(); void act(goal, { ...rename, payload: { title } }).then(saved => { if (saved) setEditing(false); }); }}>
      <label>Goal title<input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} disabled={disabled} required /></label>
      <button disabled={disabled || !title.trim()}>Save title</button><button type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>}
  </section>;
}
```

- [ ] **Step 4: Add the styles**

Append to `app/orchestration/orchestration.css`:

```css
.decision-bar { position:sticky; top:0; z-index:3; margin:0 0 14px; padding:16px 18px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:0 8px 24px #0004; }
.decision-heading { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.orchestration .decision-heading h1 { font-size:22px; line-height:1.25; margin:0; letter-spacing:0; }
.decision-body { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-top:10px; }
.decision-text { min-width:0; flex:1; }
.decision-state { margin:0; font-weight:600; }
.decision-reason { margin:4px 0 0; color:var(--muted); font-size:13px; }
.decision-controls { display:flex; align-items:center; gap:10px; flex:none; }
.decision-menu { position:relative; }
.decision-menu [role=menu] { position:absolute; right:0; top:calc(100% + 6px); min-width:220px; display:grid; gap:4px; padding:6px; border:1px solid var(--line); border-radius:10px; background:var(--panel-raised); box-shadow:0 10px 30px #0006; z-index:4; }
.decision-menu [role=menuitem] { width:100%; text-align:left; border:0; background:none; min-height:40px; }
.decision-menu [role=menuitem]:hover,.decision-menu [role=menuitem]:focus-visible { background:var(--panel); }
.decision-rename { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; margin-top:12px; }
.decision-rename label { flex:1; min-width:200px; margin:0; } .decision-rename input { margin:8px 0 0; }
@media(max-width:700px) { .decision-body { flex-direction:column; } .decision-controls { width:100%; justify-content:flex-start; } .decision-controls .decision-primary { flex:1; } .decision-reason { order:3; } .decision-body { display:grid; } .decision-text { display:contents; } .decision-state { order:1; } .decision-controls { order:2; } }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:ui -- tests/ui-decision-bar.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app/orchestration/decision-bar.tsx tests/ui-decision-bar.test.tsx --quiet`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add app/orchestration/decision-bar.tsx app/orchestration/orchestration.css tests/ui-decision-bar.test.tsx
git commit -m "feat: add the shared goal decision bar"
```

---

### Task 3: Decision bar on both goal pages

**Files:**
- Modify: `app/orchestration/goal-detail.tsx`
- Modify: `app/orchestration/goal-conversation.tsx` (header only)
- Test: `tests/ui-orchestration.test.tsx`, `tests/ui-mission-control.test.tsx`, `tests/ui-goal-conversation.test.tsx`

- [ ] **Step 1: Update the tests that depend on the old header**

In `tests/ui-orchestration.test.tsx`:

The test `'finishing a command for A does not invalidate the selected B detail request'` and the modal-goal test and the last abort test click `Abort goal` directly. Before each `fireEvent.click(await screen.findByRole('button', { name: 'Abort goal' }))`, insert:

```tsx
  fireEvent.click(await screen.findByRole('button', { name: 'More' }));
```

and change the click to `fireEvent.click(await screen.findByRole('menuitem', { name: 'Abort goal' }));`.

In `'goal details preserve the request, edit only the title, and hide empty evidence'`, replace:

```tsx
  fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
```

with:

```tsx
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit title' }));
```

That test's goal literal spreads `goalView(...)` so `decision` exists; its `actions` override lists only `rename_goal`, which is fine.

In `'held goal shows failure and reconciliation guidance, then submits the exact recovery action'`, replace the first two expectations:

```tsx
  expect(screen.getByText(/On hold/)).toBeTruthy();
  expect(screen.getByText(/Let active workers finish and reconcile/)).toBeTruthy();
```

with:

```tsx
  expect(screen.getByRole('status', { name: '' }).textContent).toBe('The goal is on hold.');
  expect(screen.getByText(/Let active workers finish and reconcile/)).toBeTruthy();
```

If `getByRole('status', { name: '' })` is ambiguous, use `screen.getByText('The goal is on hold.')`.

In `tests/ui-mission-control.test.tsx`, no header assertions exist for `GoalDetail`; leave it.

In `tests/ui-goal-conversation.test.tsx`, the first test clicks `Approve revision 1` inside `GoalConversation`. Task 4 moves approval out of the card, so change that test now: replace

```tsx
  fireEvent.click(screen.getByRole('button', { name: 'Approve revision 1' }));
  expect(act).toHaveBeenCalledWith(value, expect.objectContaining({ type: 'approve', payload: { revision: 1 } }));
```

with:

```tsx
  expect(screen.queryByRole('button', { name: 'Approve revision 1' })).toBeNull();
  expect(screen.getByText('Request changes in the message box below.')).toBeTruthy();
```

In the second test, replace

```tsx
  expect((screen.getByRole('button', { name: 'Approve revision 1' }) as HTMLButtonElement).disabled).toBe(true);
```

with nothing (delete the line). In the third test, replace

```tsx
  fireEvent.click(screen.getByRole('button', { name: 'Approve & publish PR' }));
  expect(act).toHaveBeenCalledWith(value, value.actions[0]);
```

with:

```tsx
  expect(screen.queryByRole('button', { name: 'Approve & publish PR' })).toBeNull();
```

In the fourth test, the status text moves to the bar. Replace

```tsx
  expect(screen.getByRole('status').textContent).toBe('Supervisor waiting for execution capacity · no action needed');
```

with:

```tsx
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('log', { name: 'Conversation messages' })).toBeTruthy();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:ui -- tests/ui-orchestration.test.tsx tests/ui-goal-conversation.test.tsx`
Expected: FAIL on the `More` button and the removed approve button.

- [ ] **Step 3: Render the bar in `GoalDetail` and strip the legacy header**

In `app/orchestration/goal-detail.tsx`:

Add the import:

```tsx
import { DecisionBar } from './decision-bar';
```

Remove these imports and uses: `attention` (import and the two `attention(goal)` uses), `goalStage` (import and use), and the `editingTitle`, `title`, `rename` state and the title form.

Replace the first `<section className="orch-card">` block's opening part. The old code starts with:

```tsx
    <section className="orch-card"><div className="orch-eyebrow">{goalStage(goal)} · PLAN {goal.revision}</div><h1>{goal.title}</h1>{rename && (editingTitle ? <form ...>...</form> : <button ...>Edit title</button>)}
      <p className="orch-description">{goal.description || goal.title}</p><p>{goal.plannerName}</p>{attention(goal) && <p className="orch-banner">{attention(goal)}</p>}
```

Replace it with:

```tsx
    <section className="orch-card"><div className="orch-eyebrow">PLAN {goal.revision}</div>
      <p className="orch-description">{goal.description || goal.title}</p><p>{goal.plannerName}</p>
```

Remove the generic action row line:

```tsx
      <div className="orch-actions">{goal.actions.filter(action => action.type !== 'send_goal_message' && ...).map(action => <button ...>{action.label}</button>)}</div>
```

Remove the line `{goal.status === 'awaiting_approval' && goal.approvalBlocked && <p className="orch-banner">{goal.approvalBlocked}</p>}` because the bar shows it as the reason.

Rename `LegacyGoalDetail` body wrapper: keep `<article className="orch-detail" aria-label="Goal detail">` but it must not render the bar itself. Change the exported wrapper to:

```tsx
export function GoalDetail(props: Parameters<typeof LegacyGoalDetail>[0]) {
  const bar = <DecisionBar goal={props.goal} disabled={props.disabled} act={props.act} />;
  if (props.goal.experienceVersion !== 2) return <>{bar}<LegacyGoalDetail {...props} /></>;
  return <>{bar}<GoalConversation goal={props.goal} disabled={props.disabled} act={props.act} /><details className="orch-card"><summary>Technical details, team and full evidence</summary><LegacyGoalDetail {...props} /></details></>;
}
```

- [ ] **Step 4: Remove the conversation header card**

In `app/orchestration/goal-conversation.tsx`, delete the `status` computation (the long ternary starting `const status = conversation.paused ?`) and the whole `<header className="orch-card">...</header>` element. Delete `const active = ...` only if it becomes unused; it is still used by the Working agents card, so keep it. Delete the `button`/`decision` helpers if unused after Task 4; for now keep them.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:ui -- tests/ui-orchestration.test.tsx tests/ui-goal-conversation.test.tsx tests/ui-mission-control.test.tsx tests/ui-decision-bar.test.tsx`
Expected: PASS. The first conversation test still fails on the approve expectations until Task 4; if so, run Task 4 before the commit of this task is amended. Prefer: complete Task 4 Step 3 first, then run and commit both together only if Task 3 cannot pass alone.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app/orchestration tests/ui-orchestration.test.tsx tests/ui-goal-conversation.test.tsx --quiet`
Expected: no errors. Unused-variable lint errors point at helpers to delete.

- [ ] **Step 7: Commit**

```bash
git add app/orchestration/goal-detail.tsx app/orchestration/goal-conversation.tsx tests/ui-orchestration.test.tsx tests/ui-goal-conversation.test.tsx
git commit -m "feat: show the decision bar on both goal pages"
```

---

### Task 4: Collapsed proposal card and clamped messages

**Files:**
- Modify: `app/orchestration/goal-conversation.tsx`
- Modify: `app/orchestration/orchestration.css`
- Test: `tests/ui-goal-conversation.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui-goal-conversation.test.tsx`:

```tsx
test('the current proposal shows a summary first, old proposals one line, and long messages clamp', () => {
  const value = goal();
  const revised = { ...value, revision: 2, contracts: [...value.contracts, { revision: 2, contract: { ...value.contracts[0].contract, outcome: 'Combine modules with care' } }] };
  revised.conversation = { ...value.conversation!, messages: [
    ...value.conversation!.messages,
    { id: 'long', sequence: 2, author: 'supervisor', kind: 'message', text: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n'), revision: 1, delivery: 'delivered' },
    { id: 'p2', sequence: 3, author: 'supervisor', kind: 'proposal', text: 'Revised proposal', revision: 2, delivery: 'delivered' },
  ] };
  render(<GoalConversation goal={revised} disabled={false} act={vi.fn()} />);
  expect(screen.getByText('Proposal 1 · Superseded by 2')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Proposal 2' })).toBeTruthy();
  expect(screen.getByText('Combine modules with care')).toBeTruthy();
  expect(screen.getByText('1 scope item · 1 acceptance criterion · 1 check · 3 tasks')).toBeTruthy();
  expect(screen.queryByText('Modules A and B and their composition')).toBeNull();
  fireEvent.click(screen.getByText('Scope'));
  expect(screen.getByText('Modules A and B and their composition')).toBeTruthy();
  expect(sessionStorage.getItem('companion.proposal.goal.Scope')).toBe('open');
  expect(screen.getByText('Line 1')).toBeTruthy();
  expect(screen.queryByText('Line 12')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
  expect(screen.getByText(/Line 12/)).toBeTruthy();
});
```

Note: the fixture's `contract()` has 1 scope item, 1 criterion, 1 check and 3 tasks, so the counts line reads exactly as above. The existing `goal()` helper in this file creates a conversation with one user message at revision 0 whose proposal is at revision 1 after `publish_contract`; check `value.conversation.messages` in a quick `console.log` if the message kinds differ, and adjust the appended messages' `sequence` values to follow the last one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:ui -- tests/ui-goal-conversation.test.tsx`
Expected: FAIL, `Proposal 1 · Superseded by 2` not found.

- [ ] **Step 3: Rewrite the proposal and message rendering**

In `app/orchestration/goal-conversation.tsx`, add two small components above `GoalConversation`:

```tsx
function Section({ goalId, name, count, children }: { goalId: string; name: string; count: number; children: React.ReactNode }) {
  const key = `companion.proposal.${goalId}.${name}`;
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem(key) === 'open'; } catch { return false; } });
  return <details open={open} onToggle={event => { const next = (event.target as HTMLDetailsElement).open; setOpen(next); try { sessionStorage.setItem(key, next ? 'open' : 'closed'); } catch { /* storage unavailable */ } }}>
    <summary>{name} ({count})</summary>{children}
  </details>;
}

function ClampedText({ text }: { text: string }) {
  const lines = text.split('\n');
  const [expanded, setExpanded] = useState(false);
  if (lines.length <= 8) return <p className="goal-message-text">{text}</p>;
  return <><p className="goal-message-text">{expanded ? text : lines.slice(0, 8).join('\n')}</p><button type="button" className="goal-message-more" onClick={() => setExpanded(current => !current)}>{expanded ? 'Show less' : 'Show more'}</button></>;
}
```

Import `React` types via `import type { ReactNode } from 'react';` and use `ReactNode` instead of `React.ReactNode`.

Replace `<p className="goal-message-text">{entry.text}</p>` with `<ClampedText text={entry.text} />`.

Replace the whole `{proposal && <details ...>...</details>}` block with:

```tsx
          {proposal && (entry.revision !== goal.revision
            ? <details aria-label={`Proposal revision ${entry.revision}`}><summary>Proposal {entry.revision} · Superseded by {goal.revision}</summary><ProposalBody goalId={goal.id} proposal={proposal} /></details>
            : <section aria-label={`Proposal revision ${entry.revision}`}><h2>Proposal {entry.revision}</h2><ProposalBody goalId={goal.id} proposal={proposal} />
              {goal.approvedRevision === entry.revision ? <p>Approved.</p> : <p>Request changes in the message box below.</p>}
            </section>)}
```

Add `ProposalBody` above `GoalConversation`:

```tsx
function ProposalBody({ goalId, proposal }: { goalId: string; proposal: Contract }) {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return <>
    <p className="goal-proposal-outcome">{proposal.outcome}</p>
    <p className="goal-proposal-counts">{plural(proposal.scope.length, 'scope item', 'scope items')} · {plural(proposal.criteria.length, 'acceptance criterion', 'acceptance criteria')} · {plural(proposal.verification.length, 'check', 'checks')} · {plural(proposal.tasks.length, 'task', 'tasks')}</p>
    <Section goalId={goalId} name="Scope" count={proposal.scope.length}><ul>{proposal.scope.map(item => <li key={item}>{item}</li>)}</ul></Section>
    {proposal.exclusions.length > 0 && <Section goalId={goalId} name="Excluded" count={proposal.exclusions.length}><ul>{proposal.exclusions.map(item => <li key={item}>{item}</li>)}</ul></Section>}
    <Section goalId={goalId} name="Acceptance" count={proposal.criteria.length}><ul>{proposal.criteria.map(item => <li key={item.id}>{item.text} <small>Check: {item.verification}</small></li>)}</ul></Section>
    <Section goalId={goalId} name="Checks" count={proposal.verification.length}><ul>{proposal.verification.map(check => <li key={check.id}><strong>{check.id}</strong> <code>{check.argv.join(' ')}</code></li>)}</ul></Section>
    <Section goalId={goalId} name="Assignments" count={proposal.tasks.length}><ul>{proposal.tasks.map(task => <li key={task.id}>{task.title}{task.dependsOn.length ? ` · after ${task.dependsOn.join(', ')}` : ''}</li>)}</ul></Section>
  </>;
}
```

The test clicks the text `Scope`; the summary reads `Scope (1)`, so change the test's click to `fireEvent.click(screen.getByText('Scope (1)'))`.

Remove `{button(decision('approve_publication'))}` from the result card. Remove the `button` and `decision` helpers if nothing else uses them.

- [ ] **Step 4: Add the styles**

Append to `app/orchestration/orchestration.css`:

```css
.goal-proposal-outcome { font-weight:600; margin:8px 0 4px; }
.goal-proposal-counts { color:var(--muted); font-size:13px; margin:0 0 10px; }
.goal-message details { border-top:1px solid var(--line); padding:8px 0; } .goal-message summary { cursor:pointer; font-weight:600; }
.goal-message-more { min-height:32px!important; padding:4px 10px!important; font-size:13px!important; margin-top:4px; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:ui -- tests/ui-goal-conversation.test.tsx tests/ui-decision-bar.test.tsx tests/ui-orchestration.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint and run the whole UI suite with coverage**

Run: `npx tsc --noEmit && npm run lint && npm run test:ui:coverage`
Expected: no errors; UI line coverage at or above 90%.

- [ ] **Step 7: Commit**

```bash
git add app/orchestration/goal-conversation.tsx app/orchestration/orchestration.css tests/ui-goal-conversation.test.tsx
git commit -m "feat: collapse goal proposals and clamp long supervisor messages"
```

---

### Task 5: Browser checks and full verification

**Files:**
- Modify: `cypress/e2e/orchestration-core.cy.ts`
- Modify: `cypress/e2e/orchestration-conversation.cy.ts`
- Modify: `cypress/e2e/goal-workspace.cy.ts`

- [ ] **Step 1: Route secondary actions through More in the core spec**

In `cypress/e2e/orchestration-core.cy.ts`, every `cy.findByRole('button', { name: 'Abort goal' }).click();` becomes:

```ts
    cy.findByRole('button', { name: 'More' }).click(); cy.findByRole('menuitem', { name: 'Abort goal' }).click();
```

Every `cy.findByRole('button', { name: 'Address review comments', timeout: 30000 }).should('be.enabled').click();` stays, because `request_review_fix` is in the primary order and renders as the primary button. `Approve revision N`, `Approve & publish PR` and `Recover goal` stay as primary buttons. The line `cy.findByRole('button', { name: 'Address review comments', timeout: 60000 }).should('be.enabled');` stays.

In the abort test, after the abort click, keep `cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'Aborted');` but note the stage badge is now in the bar outside the article. Change it to `cy.findByRole('region', { name: 'Goal decision' }).should('contain.text', 'Aborted');`.

- [ ] **Step 2: Route conversation controls through the bar**

In `cypress/e2e/orchestration-conversation.cy.ts`, the `Pause goal` and `Resume goal` clicks and the approve clicks sit inside `cy.get('.goal-conversation').within(...)`. The bar is outside that element. Restructure:

```ts
    cy.get('.goal-conversation').within(() => {
      cy.findByLabelText('Message your supervisor').type('Yes, use the fixture.');
      cy.findByRole('button', { name: 'Send message' }).click();
    });
    cy.findByRole('button', { name: 'Approve revision 1', timeout: 20000 }).should('be.enabled');
    cy.get('.goal-conversation').within(() => {
      cy.findByLabelText('Message your supervisor').type('Please revise the plan.');
      cy.findByRole('button', { name: 'Send message' }).click();
    });
    cy.findByRole('button', { name: 'Approve revision 2', timeout: 20000 }).should('be.enabled');
    cy.findByRole('button', { name: 'More' }).click(); cy.findByRole('menuitem', { name: 'Pause goal' }).click();
    cy.findByRole('button', { name: 'Resume goal' }).should('be.enabled');
    cy.get('.goal-conversation').within(() => {
      cy.findByLabelText('Message your supervisor').type('Keep this guidance through reload.');
      cy.findByRole('button', { name: 'Send message' }).click();
      cy.contains('Queued for supervisor').should('be.visible');
    });
    cy.reload();
    cy.get('.goal-conversation').contains('Keep this guidance through reload.').should('be.visible');
    cy.findByRole('button', { name: 'Resume goal' }).click();
    cy.get('.goal-conversation').within(() => {
      cy.contains('Keep this guidance through reload.').closest('section').contains('Answered', { timeout: 10000 });
    });
    cy.findByRole('button', { name: 'Approve revision 2' }).click();
    cy.get('.goal-conversation').within(() => {
      cy.contains('Automatic launch retry 1 of 1 is queued', { timeout: 20000 }).should('be.visible');
      cy.findByRole('heading', { name: 'Working agents', timeout: 20000 }).should('be.visible');
      cy.findByLabelText('Message your supervisor').focus().should('have.focus');
    });
```

`Resume goal` is in the primary order, so it is the primary button while paused.

- [ ] **Step 3: Add the phone layout check to the workspace spec**

In `cypress/e2e/goal-workspace.cy.ts`, after `cy.findByRole('article', { name: 'Goal detail' }).should('contain.text', 'EXAMPLE Planning Outcome 1');`, add:

```ts
    cy.findByRole('region', { name: 'Goal decision' }).within(() => {
      cy.findByRole('status').should('be.visible').and('contain.text', 'Your plan');
      cy.findByRole('button', { name: 'More' }).should('be.visible');
    });
```

The intercepted goals in that spec are plain literals with `actions: []`, so no `decision` field exists. Add to the `base` literal: `decision: { state: 'Your plan is ready to approve.', reason: null, primary: null },`. Also add the same `decision` field to the `base` objects in `cypress/e2e/mission-control.cy.ts` only if the detail pages there fail to render; they spread `goalView(...)`, so `decision` is present and nothing is needed.

- [ ] **Step 4: Run the browser checks**

Run: `npm run test:e2e:local`
Expected: all specs pass. If Electron fails, run `CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local`. Record any spec that cannot run in the completion report.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`
Expected: backend and UI coverage at or above 90%, lint, types and build pass.

- [ ] **Step 6: Commit**

```bash
git add cypress/e2e/orchestration-core.cy.ts cypress/e2e/orchestration-conversation.cy.ts cypress/e2e/goal-workspace.cy.ts
git commit -m "test: drive goal decisions through the decision bar in browser checks"
```
