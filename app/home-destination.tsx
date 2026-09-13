'use client';
import { useSyncExternalStore, type ReactNode } from 'react';
import { GoalBoard } from './orchestration/goal-board';
import './orchestration/orchestration.css';

export function isMonitoringDestination(search: string) {
  const query = new URLSearchParams(search);
  return query.get('mode') === 'sessions' || ['sessions', 'inbox', 'launch', 'apps', 'settings', 'usage', 'worktrees'].includes(query.get('view') || '')
    || ['workspace', 'surface', 'repo', 'file', 'action', 'preview', 'context'].some(key => Boolean(query.get(key)));
}
const subscribe = (changed: () => void) => { window.addEventListener('popstate', changed); return () => window.removeEventListener('popstate', changed); };
export function HomeDestination({ sessions }: { sessions: ReactNode }) {
  const search = useSyncExternalStore(subscribe, () => location.search, () => null);
  if (search === null) return <main><p role="status">Opening Companion…</p></main>;
  return isMonitoringDestination(search) ? sessions : <GoalBoard />;
}
