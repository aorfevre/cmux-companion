import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GoalFleet, goalStage } from '../app/orchestration/goal-fleet';
import { GoalDetail } from '../app/orchestration/goal-detail';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { fixture } from './helpers/orchestration/domain-fixture.mjs';
import type { Goal } from '../app/orchestration/goal-board';
afterEach(cleanup);
function goals(): Goal[] {
  const base = goalView(fixture().goal);
  return [
    { ...base, id: 'planning', title: 'Design ingestion', status: 'discovering', clarification: null },
    { ...base, id: 'decision', title: 'Approve dashboard', status: 'awaiting_approval' },
    { ...base, id: 'waiting', title: 'Published adapter', status: 'delivered' },
    { ...base, id: 'merged', title: 'Merged project', status: 'merged' },
    { ...base, id: 'aborted', title: 'Stopped project', status: 'aborted' },
  ];
}
test('fleet searches, filters and opens goals without calling an external service', () => {
  const select = vi.fn();
  render(<GoalFleet goals={goals()} select={select} projectName={() => 'Example'} />);
  fireEvent.click(screen.getByRole('button', { name: 'Waiting for merge' }));
  expect(screen.getByRole('button', { name: 'Published adapter' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Merged project' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'design' } });
  fireEvent.click(screen.getByRole('button', { name: 'Design ingestion' }));
  expect(select).toHaveBeenCalledWith('planning');
  expect(screen.queryByRole('button', { name: 'Approve dashboard' })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(screen.getByText('No matching goals')).toBeTruthy();
});
test('Needs You isolates decisions and never treats publication or abort as completion', () => {
  const entries = goals();
  render(<GoalFleet goals={entries} select={vi.fn()} projectName={() => 'Example'} needsOnly />);
  expect(screen.getByRole('button', { name: 'Approve dashboard' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Design ingestion' })).toBeNull();
  expect(goalStage(entries[2])).toBe('Waiting for merge');
  expect(goalStage(entries[3])).toBe('Complete');
  expect(goalStage(entries[4])).toBe('Aborted');
});
test('goal sections support arrow-key navigation and reveal evidence only in the report', () => {
  const goal = { ...goals()[0], contracts: [] };
  render(<GoalDetail goal={goal} disabled={false} terminal={false} act={vi.fn()} control={vi.fn()} />);
  const overview = screen.getByRole('tab', { name: 'Overview' });
  fireEvent.keyDown(overview, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Waves & sessions' })).toBe(document.activeElement);
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(document.activeElement?.id);
  fireEvent.click(screen.getByRole('tab', { name: 'Run report' }));
  expect(screen.getByText('No review or verification evidence yet')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Run report' }), { key: 'Home' });
  expect(overview.getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('No review or verification evidence yet')).toBeNull();
});

test('fleet distinguishes active verification and task review from implementation while retaining the held stage', () => {
  const f = fixture(); f.approve();
  const goal = goalView(f.goal);
  expect(goalStage(goal)).toBe('In progress');
  goal.tasks[0].status = 'in_review'; expect(goalStage(goal)).toBe('Review');
  goal.tasks[1].status = 'running'; expect(goalStage(goal)).toBe('In progress');
  goal.verificationRuns = [{ operationId: 'check', headSha: goal.integrationHead, revision: goal.revision, current: true, waveId: null, status: 'pending', workerState: 'pending', verification: null }];
  expect(goalStage(goal)).toBe('Verification');
  goal.verificationRuns = []; goal.hold = { id: 'hold', reasons: [{ kind: 'verification', target: 'check', message: 'Tests failed' }] };
  expect(goalStage(goal)).toBe('Verification');
});
test('wave inspection exposes task ownership, acceptance and integrated evidence', () => {
  const f = fixture(); f.approve();
  const goal = { ...goalView(f.goal), contracts: f.goal.contracts };
  goal.tasks[0].candidateSha = 'b'.repeat(40); goal.tasks[0].integratedSha = 'c'.repeat(40);
  render(<GoalDetail goal={goal} disabled={false} terminal={false} act={vi.fn()} control={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Waves & sessions' }));
  expect(screen.getByText('Owned areas: src/a.mjs')).toBeTruthy();
  expect(screen.getAllByText('Acceptance: works')).toHaveLength(3);
  expect(screen.getByText('cccccccccccc')).toBeTruthy();
});
