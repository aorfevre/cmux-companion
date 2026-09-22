"use client";
import { useState } from 'react';
import type { Goal } from './goal-board';
import { activityLabel } from './goal-activity';
import { attention } from './attention';

export function goalStage(goal: Goal) {
  if (goal.status === 'merged') return 'Complete';
  if (goal.status === 'aborted') return 'Aborted';
  if (goal.status === 'addressing_review') return 'Addressing review';
  if (goal.status === 'delivered') return 'Waiting for merge';
  if (goal.status === 'ready_to_publish') return goal.publication?.approved ? 'PR delivery' : 'Ready to publish';
  if (goal.status === 'discovering') return 'Planning';
  if (goal.status === 'awaiting_approval') return 'Needs approval';
  if (goal.verificationRuns?.some(run => run.current && ['pending', 'uncertain'].includes(run.status)) || goal.hold?.reasons.some(reason => reason.kind === 'verification')) return 'Verification';
  if (goal.tasks.length && goal.tasks.every(task => task.status === 'integrated')) return goal.reviews.some(review => review.kind === 'integration' && review.target === goal.integrationHead && review.disposition === 'accept') ? 'Verification' : 'Review';
  if (goal.tasks.some(task => task.status === 'in_review') && !goal.tasks.some(task => task.status === 'running')) return 'Review';
  return 'In progress';
}
export function activeWorkers(goal: Goal) { return goal.attempts.filter(attempt => attempt.current && attempt.workerState === 'running').length; }
const filters = ['All', 'Running', 'Needs you', 'Waiting for merge', 'Complete', 'Aborted'] as const;
export type GoalFilter = typeof filters[number];
export function GoalFleet({ goals, select, projectName, needsOnly = false, selectedFilter, onFilterChange }: {
  goals: Goal[]; select(id: string): void; projectName(id: string): string; needsOnly?: boolean; selectedFilter?: GoalFilter; onFilterChange?(filter: GoalFilter): void;
}) {
  const [localFilter, setLocalFilter] = useState<GoalFilter>('All');
  const filter = selectedFilter ?? localFilter;
  const setFilter = (value: GoalFilter) => { setLocalFilter(value); onFilterChange?.(value); };
  const [search, setSearch] = useState('');
  const current = goals.filter(goal => goal.status !== 'aborted');
  const decisions = current.filter(goal => attention(goal));
  const visible = goals.filter(goal => {
    if (filter === 'Aborted' ? goal.status !== 'aborted' : goal.status === 'aborted') return false;
    if (needsOnly && !attention(goal)) return false;
    if (!`${goal.title} ${projectName(goal.repositoryId)}`.toLowerCase().includes(search.toLowerCase())) return false;
    return filter === 'All' || filter === 'Aborted' || (filter === 'Needs you' ? Boolean(attention(goal)) : filter === 'Complete' ? goal.status === 'merged' : filter === 'Waiting for merge' ? goal.status === 'delivered' : !attention(goal) && ['discovering', 'building', 'addressing_review'].includes(goal.status));
  });
  return <section aria-label={needsOnly ? 'Decision queue' : 'Goal fleet'}>
    {!needsOnly && <div className="mission-stats">
      {[['Goals', current.length, `${goals.filter(goal => goal.status === 'merged').length} complete`], ['Active sessions', goals.reduce((sum, goal) => sum + activeWorkers(goal), 0), 'Across all goals'], ['Needs you', decisions.length, 'Questions and decisions'], ['Waiting for merge', goals.filter(goal => goal.status === 'delivered').length, 'Merge on GitHub']].map(([label, value, note]) => <div className="mission-stat" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
    </div>}
    <div className="mission-fleet-tools"><div className="mission-filters" aria-label="Filter goals">{!needsOnly && filters.map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div><label className="mission-search"><span className="sr-only">Search goals and projects</span><input type="search" placeholder="Search goals or projects" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    <div className="mission-fleet"><div className="mission-fleet-heading"><h2>{needsOnly ? 'What needs your attention' : 'Goal fleet'}</h2><small>{visible.length} {visible.length === 1 ? 'goal' : 'goals'}</small></div>
      <div className="mission-fleet-labels" aria-hidden="true"><span>Goal / project</span><span>Lifecycle</span><span>Sessions</span><span>Next step</span></div>
      {visible.map(goal => <button type="button" className="mission-fleet-row" key={goal.id} aria-label={goal.title} onClick={() => select(goal.id)}>
        <span><span className="mission-goal-link">{goal.title}</span><small>{projectName(goal.repositoryId)}</small>{goal.lastActivity && <small className="mission-last-activity">{activityLabel(goal.lastActivity.kind)} · <time dateTime={goal.lastActivity.createdAt}>{new Date(goal.lastActivity.createdAt).toLocaleString()}</time></small>}</span>
        <span><span className={`mission-badge ${attention(goal) ? 'attention' : goal.status === 'merged' ? 'complete' : ''}`}>{goalStage(goal)}</span>{goal.waves?.find(wave => wave.current) && <small>Wave {goal.waves.find(wave => wave.current)?.number} of {goal.waves.length}</small>}</span>
        <span className="mission-workers"><strong>{activeWorkers(goal)}</strong><span className="mission-mobile-label"> active sessions</span></span>
        <span className="mission-next">{attention(goal) || (goal.status === 'addressing_review' ? goal.reviewRound?.phase ?? 'Addressing review comments' : goal.status === 'delivered' ? 'Waiting for GitHub merge' : goal.status === 'merged' ? 'Merged on GitHub' : goal.status === 'aborted' ? 'Execution stopped' : 'Execution continues automatically')}</span>
      </button>)}
      {!visible.length && <div className="mission-empty"><h3>{needsOnly ? 'No decisions pending' : search || filter !== 'All' ? 'No matching goals' : 'Your first goal starts here'}</h3><p>{needsOnly ? 'Questions, approvals and recovery decisions will appear here.' : search || filter !== 'All' ? 'Try another search or filter.' : 'Choose a project and describe the outcome you want.'}</p></div>}
    </div>
  </section>;
}
