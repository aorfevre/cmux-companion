"use client";
import { useState } from 'react';
import type { Action, Goal } from './goal-board';
import { activityLabel } from './goal-activity';
import { DecisionActions, type NextStep } from './decision-bar';

export const CHIPS = ['All', 'Needs you', 'Active', 'Done', 'Aborted'] as const;
export type Chip = typeof CHIPS[number];
// Aborted goals are history: they show only under their own chip.
const inChip = (goal: Goal, chip: Chip) => chip === 'Aborted' ? goal.decision.rank === 4 : goal.decision.rank !== 4 && (chip === 'All' || (chip === 'Needs you' ? goal.decision.rank === 0 : chip === 'Active' ? goal.decision.rank === 1 : goal.decision.rank >= 2));
const EMPTY: Record<Chip, [string, string]> = {
  All: ['Your first goal starts here', 'Choose a project and describe the outcome you want.'],
  'Needs you': ['Nothing needs you', 'Decisions, questions and recovery steps appear here when they are yours to take.'],
  Active: ['No active goals', 'Goals that agents are planning or building appear here.'],
  Done: ['No finished goals', 'Delivered and merged goals appear here.'],
  Aborted: ['No aborted goals', 'Goals you stopped appear here with their evidence.'],
};

/** One list, decisions first. Every row reads the same projected decision as the goal page. */
export function GoalsList({ goals, chip, onChip, disabled, act, select, openNext, projectName }: {
  goals: Goal[]; chip: Chip; onChip(chip: Chip): void; disabled: boolean;
  act(goal: Goal, action: Action): Promise<boolean>; select(id: string): void; openNext(id: string, next: NextStep): void; projectName(id: string): string;
}) {
  const [search, setSearch] = useState('');
  const visible = goals
    .filter(goal => inChip(goal, chip) && `${goal.title} ${projectName(goal.repositoryId)}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.decision.rank - b.decision.rank || Date.parse(b.lastActivity?.createdAt ?? '1970-01-01') - Date.parse(a.lastActivity?.createdAt ?? '1970-01-01'));
  const [emptyTitle, emptyBody] = search ? ['No matching goals', 'Try another search.'] : EMPTY[chip];
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
          {goal.decision.effect && <p className="decision-effect" id={`decision-effect-${goal.id}`}>{goal.decision.effect}</p>}
        </button>
        <div className="goal-row-actions"><DecisionActions goal={goal} disabled={disabled} act={act} openNext={next => openNext(goal.id, next)} /></div>
        <footer><span className={`mission-badge ${goal.decision.rank === 0 ? 'attention' : goal.status === 'merged' ? 'complete' : ''}`}>{goal.decision.stage}</span>{goal.lastActivity && <small>{activityLabel(goal.lastActivity.kind)} · <time dateTime={goal.lastActivity.createdAt}>{new Date(goal.lastActivity.createdAt).toLocaleString()}</time></small>}</footer>
      </article>)}
      {!visible.length && <div className="mission-empty"><h3>{emptyTitle}</h3><p>{emptyBody}</p></div>}
    </div>
  </section>;
}
