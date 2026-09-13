import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { HomeDestination, isMonitoringDestination } from '../app/home-destination';
import { AppNavigation } from '../app/navigation';
vi.mock('../app/orchestration/goal-board', () => ({ GoalBoard: () => <h1>Goals landing</h1> }));
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
it('lands on Goals for home and campaign URLs, preserving explicit legacy destinations', () => {
  expect(isMonitoringDestination('')).toBe(false); expect(isMonitoringDestination('?utm_source=phone')).toBe(false);
  for (const query of ['mode=sessions', 'view=sessions', 'view=inbox', 'view=settings', 'view=apps', 'view=usage', 'view=launch', 'view=worktrees', 'workspace=w&surface=s', 'repo=r&file=README.md', 'action=a', 'preview=p']) expect(isMonitoringDestination('?'+query)).toBe(true);
  render(<HomeDestination sessions={<h1>Sessions view</h1>} />); expect(screen.getByRole('heading').textContent).toBe('Goals landing');
  act(() => { history.pushState(null, '', '/?view=sessions'); window.dispatchEvent(new PopStateEvent('popstate')); }); expect(screen.getByRole('heading').textContent).toBe('Sessions view');
  act(() => { history.replaceState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }); expect(screen.getByRole('heading').textContent).toBe('Goals landing');
});
it('shows three main destinations and treats Sessions as part of Goals', () => {
  render(<AppNavigation active="sessions" />);
  expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual(['▤Goals', '▣Inbox', '⚙Settings']);
  expect(screen.getByRole('link', { name: 'Goals' }).getAttribute('aria-current')).toBe('page'); expect(screen.queryByRole('link', { name: 'Sessions' })).toBeNull();
});
