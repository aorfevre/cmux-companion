'use client';
import { useEffect, useState } from 'react';
import { useOwnedRead } from '../use-owned-read';

export function activityLabel(kind: string) {
  const labels: Record<string, string> = {
    revision_requested: 'Plan revision requested', review_repair_requested: 'Automatic review repair requested', plan_review_policy_changed: 'Plan review preference updated',
    goal_created: 'Goal created', contract_published: 'Design and plan proposed', goal_approved: 'Plan and team approved',
    goal_dispatch_held: 'Dispatch stopped after a failure', goal_recovery_authorized: 'Manual recovery authorized',
    publication_approved: 'PR publication approved', pr_observed: 'Pull request published', pr_merged: 'Merged on GitHub',
    merge_sync_observed: 'GitHub merge status checked', clarification_requested: 'Planner asked a question',
    clarification_answered: 'Planner question answered', verification_result_recorded: 'Verification results recorded',
  };
  return labels[kind] ?? kind.replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
}
type Page = { events: { id: number; kind: string; createdAt: string; revision: number; version: number }[]; nextBefore: number | null; historyPruned: boolean };
export function GoalActivity({ goalId, version }: { goalId: string; version: number }) {
  const [pages, setPages] = useState<number[]>([]);
  const before = pages.at(-1);
  const path = `/api/orchestration/goals/${encodeURIComponent(goalId)}/activity${before ? `?before=${before}` : ''}`;
  const { value, error, refresh } = useOwnedRead<Page | null>(path, null);
  useEffect(() => { void refresh(); }, [refresh, version]);
  return <section className="orch-card"><h3>Activity</h3><p>Recorded decisions and execution events, newest first.</p>
    {error && <p role="alert">{error} <button onClick={() => void refresh(true)}>Retry activity</button></p>}
    {!value && !error && <p>Loading activity…</p>}
    {value && <><ol className="mission-activity">{value.events.map(event => <li key={event.id}><div><strong>{activityLabel(event.kind)}</strong><small>Plan {event.revision} · change {event.version}</small></div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></li>)}</ol>
      {!value.events.length && <p>No retained activity yet.</p>}
      {value.historyPruned && <p>Older journal history may have expired; saved goal and run evidence remain available.</p>}
      <div className="orch-actions">{pages.length > 0 && <button onClick={() => setPages(current => current.slice(0, -1))}>Newer activity</button>}{value.nextBefore !== null && <button onClick={() => setPages(current => [...current, value.nextBefore!])}>Older activity</button>}</div>
    </>}
  </section>;
}
