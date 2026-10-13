"use client";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Contract } from '../../server/orchestration/types';
import type { Action, Goal } from './goal-board';
import { GoalChanges } from './goal-changes';
import { CheckEvidence } from './check-evidence';

function Section({ goalId, name, count, children }: { goalId: string; name: string; count: number; children: ReactNode }) {
  const key = `companion.proposal.${goalId}.${name}`;
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem(key) === 'open'; } catch { return false; } });
  return <details open={open} onToggle={event => { const next = (event.target as HTMLDetailsElement).open; setOpen(next); try { sessionStorage.setItem(key, next ? 'open' : 'closed'); } catch { /* storage unavailable */ } }}>
    <summary>{name} ({count})</summary>{children}
  </details>;
}

function ClampedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = paragraph.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);
  return <><p ref={paragraph} className={`goal-message-text${expanded ? '' : ' goal-message-clamped'}`}>{text}</p>
    {(overflows || expanded) && <button type="button" className="goal-message-more" aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>{expanded ? 'Show less' : 'Show more'}</button>}</>;
}

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

export function GoalConversation({ goal, disabled, act }: {
  goal: Goal & { contracts: { revision: number; contract: Contract }[] }; disabled: boolean;
  act(goal: Goal, action: Action): Promise<boolean>;
}) {
  const [message, setMessage] = useState('');
  const conversation = goal.conversation;
  if (!conversation) return null;
  const send = goal.actions.find(action => action.type === 'send_goal_message');
  const active = goal.attempts.filter(attempt => attempt.current && attempt.role !== 'planner' && attempt.workerState !== 'stopped');
  return <article className="goal-conversation" aria-label="Goal conversation">
    <div className="goal-thread" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions">
      {conversation.messages.map(entry => {
        const proposal = entry.kind === 'proposal' ? goal.contracts.find(saved => saved.revision === entry.revision)?.contract : null;
        return <section className={`orch-card goal-message goal-message-${entry.author}`} key={entry.id} aria-label={`${entry.author} ${entry.kind}`}>
          <p className="orch-eyebrow">{entry.author === 'user' ? 'You' : entry.author === 'supervisor' ? 'Supervisor' : 'Companion'}{entry.kind === 'question' ? ' · Question' : ''}</p>
          {!proposal && <ClampedText text={entry.text} />}
          {entry.author === 'user' && <small aria-label="Message delivery">{entry.delivery === 'queued' ? 'Queued for supervisor' : entry.delivery === 'delivered' ? 'Delivered to supervisor' : 'Answered'}</small>}
          {proposal && (entry.revision !== goal.revision
            ? <details aria-label={`Proposal revision ${entry.revision}`}><summary>Proposal {entry.revision} · Superseded by {goal.revision}</summary><ProposalBody goalId={goal.id} proposal={proposal} /></details>
            : <section aria-label={`Proposal revision ${entry.revision}`}><h2>Proposal {entry.revision}</h2><ProposalBody goalId={goal.id} proposal={proposal} />
              {goal.approvedRevision === entry.revision ? <p>Approved.</p> : <p>Request changes in the message box below.</p>}
            </section>)}
        </section>;
      })}
    </div>
    {active.length > 0 && <section className="orch-card" aria-label="Working agents"><h2>Working agents</h2><ul>{active.map(attempt => <li key={attempt.id}>{attempt.assignment?.label || attempt.role}{attempt.taskId ? ` · ${goal.tasks.find(task => task.id === attempt.taskId)?.title || attempt.taskId}` : ''} · {attempt.workerState === 'unknown' ? 'Ownership uncertain' : attempt.status}</li>)}</ul></section>}
    {goal.verificationRuns.some(run => run.attemptId) && <details className="orch-card"><summary>Worker checks and repair budgets</summary>{goal.verificationRuns.filter(run => run.attemptId).map(run => {
      const history = goal.verificationRuns.filter(entry => entry.attemptId === run.attemptId && entry.checkIds?.some(id => run.checkIds?.includes(id)));
      return <section key={run.operationId}><h3>{run.checkIds?.join(', ')} · run {history.findIndex(entry => entry.operationId === run.operationId) + 1} of {run.budgetLimit}</h3><p>{run.status} · <code>{run.headSha.slice(0, 12)}</code></p>{run.verification?.checks.map(check => <div key={check.id}><p>{check.id}: {check.passed ? 'Passed' : 'Failed'}</p><CheckEvidence goalId={goal.id} artifactId={check.artifactId} /></div>)}</section>;
    })}</details>}
    {['ready_to_publish', 'delivered', 'merged'].includes(goal.status) && <section className="orch-card" aria-label="Goal result"><h2>Result</h2>
      <p>Integrated commit <code>{goal.integrationHead}</code></p>
      <GoalChanges goalId={goal.id} headSha={goal.integrationHead} />
      <ul>{goal.tasks.map(task => <li key={task.id}>{task.title} · {task.status}</li>)}</ul>
      {goal.reviews.filter(review => review.kind === 'integration' && review.target === goal.integrationHead).map(review => <p key={review.id}>Independent review: {review.disposition.replaceAll('_', ' ')}</p>)}
      {goal.verification?.headSha === goal.integrationHead && goal.verification.checks.map(check => <div key={check.id}><p>{check.id}: {check.passed ? 'Passed' : 'Failed'}</p><CheckEvidence goalId={goal.id} artifactId={check.artifactId} /></div>)}
      {goal.pr?.url && /^https:\/\//.test(goal.pr.url) && <a href={goal.pr.url} target="_blank" rel="noreferrer">Open pull request #{goal.pr.number}</a>}
    </section>}
    <form className="orch-card goal-composer" onSubmit={event => { event.preventDefault(); if (send && message.trim() && !disabled) void act(goal, { ...send, payload: { message: message.trim() } }).then(saved => { if (saved) setMessage(''); }); }}>
      <label htmlFor="goal-message">Message your supervisor</label><textarea id="goal-message" rows={3} maxLength={8000} value={message} onChange={event => setMessage(event.target.value)} disabled={disabled || !send} placeholder="Answer a question, clarify scope, or request changes…" />
      <button type="submit" className="primary-button" disabled={disabled || !send || !message.trim()}>Send message</button>
      {conversation.paused && <small>Messages remain saved while the goal is paused.</small>}
    </form>
  </article>;
}
