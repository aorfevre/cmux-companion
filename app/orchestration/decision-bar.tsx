"use client";
import { useEffect, useRef, useState } from 'react';
import type { Action, Goal } from './goal-board';

export type NextStep = NonNullable<Goal['decision']['next']>;
/** Actions answered through the composer or the team table, never from the menu. */
const COMPOSER_TYPES = new Set(['send_goal_message', 'request_revision', 'answer_clarification', 'override_assignment']);
const sameAction = (a: Action, b: Action) => a.type === b.type && JSON.stringify(a.payload) === JSON.stringify(b.payload);

/** The primary button, the "More" disclosure and the inline rename form. Shared by the bar and every list row. */
export function DecisionActions({ goal, disabled, act, openNext }: { goal: Goal; disabled: boolean; act(goal: Goal, action: Action): Promise<boolean>; openNext(next: NextStep): void }) {
  const [requested, setOpen] = useState(false);
  // Controls that become unavailable must not keep an open panel of live buttons.
  const open = requested && !disabled;
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(goal.title);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const { primary, next } = goal.decision;
  const secondary = goal.actions.filter(action => !COMPOSER_TYPES.has(action.type) && !(primary && sameAction(action, primary)));
  const rename = goal.actions.find(action => action.type === 'rename_goal');
  const panelId = `decision-more-${goal.id}`;
  const choose = (action: Action) => {
    setOpen(false);
    if (action.type === 'rename_goal') { setTitle(goal.title); setEditing(true); return; }
    void act(goal, action);
  };
  return <>
    <div className="decision-controls">
      {primary && <button className="primary-button decision-primary" aria-describedby={goal.decision.effect ? `decision-effect-${goal.id}` : undefined} disabled={disabled} onClick={() => void act(goal, primary)}>{primary.label}</button>}
      {!primary && next && <button className="primary-button decision-primary" aria-describedby={goal.decision.effect ? `decision-effect-${goal.id}` : undefined} disabled={disabled} onClick={() => openNext(next)}>{next.label}</button>}
      {secondary.length > 0 && <div className="decision-menu" ref={menu}>
        <button aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => setOpen(current => !current)}>More</button>
        {open && <div id={panelId} className="decision-more" aria-label="More actions">{secondary.map(action => <button type="button" key={`${action.type}:${JSON.stringify(action.payload)}`} disabled={disabled} onClick={() => choose(action)}>{action.label}</button>)}</div>}
      </div>}
    </div>
    {editing && rename && <form className="decision-rename" onSubmit={event => { event.preventDefault(); void act(goal, { ...rename, payload: { title } }).then(saved => { if (saved) setEditing(false); }); }}>
      <label>Goal title<input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} disabled={disabled} required /></label>
      <button disabled={disabled || !title.trim()}>Save title</button><button type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>}
  </>;
}

export function DecisionBar({ goal, disabled, act, openNext }: { goal: Goal; disabled: boolean; act(goal: Goal, action: Action): Promise<boolean>; openNext(next: NextStep): void }) {
  const { decision } = goal;
  return <section className="decision-bar" aria-label="Goal decision">
    <div className="decision-heading">
      <span className={`mission-badge ${decision.rank === 0 ? 'attention' : goal.status === 'merged' ? 'complete' : ''}`}>{decision.stage}</span>
      <h1>{goal.title}</h1>
    </div>
    <div className="decision-body">
      <p role="status" className="decision-state">{decision.state}</p>
      {decision.outcome && <p className="decision-outcome">{decision.outcome}</p>}
      {decision.reason && <p className="decision-reason">{decision.reason}</p>}
      {decision.effect && <p className="decision-effect" id={`decision-effect-${goal.id}`}>{decision.effect}</p>}
      <DecisionActions goal={goal} disabled={disabled} act={act} openNext={openNext} />
    </div>
  </section>;
}
