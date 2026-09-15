import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GoalTeam } from '../app/orchestration/goal-team';
import { LaunchProfiles } from '../app/settings/launch-profiles';
import { transition } from '../server/orchestration/domain/transitions.mjs';
import { goalView } from '../server/orchestration/domain/state-view.mjs';
import { request } from '../app/api-request';
import type { Settings } from '../app/settings/settings-panel';
vi.mock('../app/api-request', () => ({ request: vi.fn(async () => ({ roles: {}, providers: {} })) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const defaults = (): Settings => ({ devRepos: [], projects: [], provider: 'claude', providers: { claude: { executable: 'ccs', args: ['claude'], model: 'default' }, codex: { executable: 'ccs', args: ['codex'], model: 'default' } }, tools: { cmux: 'cmux', tailscale: 'tailscale', chrome: 'chrome' }, execution: { global: 4, perGoal: 4, planners: 2, ceilingMs: 1800000, idleMs: 240000, maxOutputBytes: 1048576, killGraceMs: 5000 }, previews: { portStart: 8500, portEnd: 8599 }, onboarding: { completed: true } });
const roles = ['planner', 'implementer', 'reviewer', 'integrator'] as const;
function goal() {
  return transition(null, { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { title: 'Team', repositoryId: 'repo', baseSha: 'a'.repeat(40), teamConfiguration: { capturedAt: '2026-09-15T10:00:00Z', defaults: Object.fromEntries(roles.map(role => [role, 'claude'])), profiles: ['claude', 'codex'].map(provider => ({ id: provider, label: provider, provider, model: 'default', roles, ready: true, reason: 'Validated', capacity: { remainingPercent: null, checkedAt: null, source: 'CCS', reason: 'Quota unavailable' } })) } } }, { kind: 'user' }).goal;
}
test('team view reports unknown capacity and submits only service-authorized profile edits', () => {
  const state = goalView(goal()), act = vi.fn().mockResolvedValue(true);
  render(<GoalTeam goal={state} disabled={false} act={act} />);
  expect(screen.getByRole('heading', { name: 'Proposed team' })).toBeTruthy();
  expect(screen.getAllByText(/Provider capacity signal: Unknown/)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Profile for Planner & designer'), { target: { value: 'codex' } });
  expect(act).toHaveBeenCalledWith(state, { type: 'override_assignment', label: 'Apply profile override', payload: { key: 'planner:*', profileId: 'codex' } });
});
test('active worker assignments cannot be edited and explain why', () => {
  const base = goal(), next = transition(base, { id: 'launch', goalId: base.id, expectedVersion: base.version, type: 'request_attempt', payload: { attemptId: 'planner', operationId: 'operation', conversationId: 'conversation', role: 'planner' } }, { kind: 'system' }).goal;
  render(<GoalTeam goal={goalView(next)} disabled={false} act={vi.fn()} />);
  expect(screen.getByLabelText('Profile for Planner & designer')).toHaveProperty('disabled', true);
  expect(screen.getByText('The assigned worker must stop before choosing its replacement')).toBeTruthy();
});
test('setup configures eligible role defaults and validates an additional launch profile', async () => {
  let draft = defaults();
  const change = vi.fn((value: Settings) => { draft = value; view.rerender(<LaunchProfiles draft={draft} change={change} busy={false} />); });
  const view = render(<LaunchProfiles draft={draft} change={change} busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add launch profile' }));
  const group = screen.getByRole('group', { name: 'Launch profile New profile' });
  fireEvent.change(within(group).getByLabelText('Profile name'), { target: { value: 'Review team' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Independent review' }));
  fireEvent.change(screen.getByLabelText('Preferred Independent review'), { target: { value: draft.launchProfiles![0].id } });
  expect(draft.teamDefaults?.reviewer).toBe(draft.launchProfiles![0].id);
  vi.mocked(request).mockResolvedValueOnce({ ready: true });
  fireEvent.click(screen.getByRole('button', { name: 'Validate claude' }));
  await waitFor(() => expect(screen.getByText(/Provider command is ready/)).toBeTruthy());
  expect(request).toHaveBeenCalledWith('/api/settings/providers/validate', expect.objectContaining({ method: 'POST', body: JSON.stringify({ provider: 'claude', command: draft.launchProfiles![0].command }) }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Independent review' }));
  expect(draft.teamDefaults?.reviewer).toBeUndefined();
  expect(screen.getByLabelText('Preferred Independent review')).toHaveProperty('value', 'claude');
  fireEvent.change(screen.getByLabelText('Preferred Implementation'), { target: { value: draft.launchProfiles![0].id } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled for new goals' }));
  expect(draft.teamDefaults?.implementer).toBeUndefined();
  expect(screen.getByLabelText('Preferred Implementation')).toHaveProperty('value', 'claude');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Review team' }));
  expect(draft.launchProfiles).toEqual([]); expect(draft.teamDefaults?.reviewer).toBeUndefined();
});
