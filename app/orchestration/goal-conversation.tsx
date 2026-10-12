"use client";
import { useState } from 'react';
import type { Contract } from '../../server/orchestration/types';
import type { Action, Goal } from './goal-board';
import { GoalChanges } from './goal-changes';
import { CheckEvidence } from './check-evidence';

export function GoalConversation({ goal, disabled, act }: {
  goal: Goal & { contracts: { revision: number; contract: Contract }[] }; disabled: boolean;
  act(goal: Goal, action: Action): Promise<boolean>;
}) {
  const [message, setMessage] = useState('');
  const conversation = goal.conversation;
  if (!conversation) return null;
  const send = goal.actions.find(action => action.type === 'send_goal_message');
  const decision = (type: string) => goal.actions.find(action => action.type === type);
  const button = (action: Action | undefined) => action && <button key={action.type} disabled={disabled} onClick={() => void act(goal, action)}>{action.label}</button>;
  const active = goal.attempts.filter(attempt => attempt.current && attempt.role !== 'planner' && attempt.workerState !== 'stopped');
  const status = conversation.paused ? 'Paused · your messages will stay queued'
    : goal.startup?.status === 'failed' ? goal.startup.error
      : goal.startup?.status === 'pending' ? 'Preparing the project'
        : goal.hold ? goal.hold.reasons.map(reason => reason.message).join(' ')
          : goal.status === 'awaiting_approval' ? 'Review the proposal below'
            : goal.status === 'ready_to_publish' ? 'Verified result awaits your publication approval'
              : goal.status === 'delivered' ? 'Pull request published · waiting for merge'
                : goal.status === 'merged' ? 'Merged'
                  : goal.status === 'aborted' ? 'Aborted · evidence retained'
                    : active.length ? `${active.length} agent${active.length === 1 ? '' : 's'} working`
                      : conversation.waiting ? 'Supervisor waiting for input or work results' : 'Supervisor working';
  return <article className="goal-conversation" aria-label="Goal conversation">
    <header className="orch-card"><p className="orch-eyebrow">GOAL</p><h1>{goal.title}</h1><p role="status">{status}</p>
      <div className="orch-actions">{['pause_goal', 'resume_goal', 'retry_startup', 'recover_goal', 'retry_attempt', 'abort'].map(type => button(decision(type)))}</div>
      {goal.hold && goal.recoveryBlocked && <p>{goal.recoveryBlocked}</p>}
    </header>
    <div className="goal-thread" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions">
      {conversation.messages.map(entry => {
        const proposal = entry.kind === 'proposal' ? goal.contracts.find(saved => saved.revision === entry.revision)?.contract : null;
        return <section className={`orch-card goal-message goal-message-${entry.author}`} key={entry.id} aria-label={`${entry.author} ${entry.kind}`}>
          <p className="orch-eyebrow">{entry.author === 'user' ? 'You' : entry.author === 'supervisor' ? 'Supervisor' : 'Companion'}{entry.kind === 'question' ? ' · Question' : ''}</p>
          <p className="goal-message-text">{entry.text}</p>
          {entry.author === 'user' && <small aria-label="Message delivery">{entry.delivery === 'queued' ? 'Queued for supervisor' : entry.delivery === 'delivered' ? 'Delivered to supervisor' : 'Answered'}</small>}
          {proposal && <details open={entry.revision === goal.revision} aria-label={`Proposal revision ${entry.revision}`}><summary><h2>Proposal {entry.revision}{entry.revision !== goal.revision ? ' · Superseded' : ''}</h2></summary>
            <h3>Scope</h3><ul>{proposal.scope.map(item => <li key={item}>{item}</li>)}</ul>
            {proposal.exclusions.length > 0 && <><h3>Excluded</h3><ul>{proposal.exclusions.map(item => <li key={item}>{item}</li>)}</ul></>}
            <h3>Acceptance</h3><ul>{proposal.criteria.map(item => <li key={item.id}>{item.text} <small>Check: {item.verification}</small></li>)}</ul>
            <details><summary>Verification checks ({proposal.verification.length})</summary><ul>{proposal.verification.map(check => <li key={check.id}><strong>{check.id}</strong> <code>{check.argv.join(' ')}</code></li>)}</ul></details>
            <h3>Assignments</h3><ul>{proposal.tasks.map(task => <li key={task.id}>{task.title}{task.dependsOn.length ? ` · after ${task.dependsOn.join(', ')}` : ''}</li>)}</ul>
            {entry.revision !== goal.revision ? <p>Superseded by proposal {goal.revision}.</p> : goal.approvedRevision === entry.revision ? <p>Approved.</p> : <>
              {goal.approvalBlocked && <p>{goal.approvalBlocked}</p>}{button(decision('approve'))}<p>Request changes in the conversation below.</p>
            </>}
          </details>}
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
      {button(decision('approve_publication'))}
      {goal.pr?.url && /^https:\/\//.test(goal.pr.url) && <a href={goal.pr.url} target="_blank" rel="noreferrer">Open pull request #{goal.pr.number}</a>}
    </section>}
    <form className="orch-card goal-composer" onSubmit={event => { event.preventDefault(); if (send && message.trim() && !disabled) void act(goal, { ...send, payload: { message: message.trim() } }).then(saved => { if (saved) setMessage(''); }); }}>
      <label htmlFor="goal-message">Message your supervisor</label><textarea id="goal-message" rows={3} maxLength={8000} value={message} onChange={event => setMessage(event.target.value)} disabled={disabled || !send} placeholder="Answer a question, clarify scope, or request changes…" />
      <button className="primary-button" disabled={disabled || !send || !message.trim()}>Send message</button>
      {conversation.paused && <small>Messages remain saved while the goal is paused.</small>}
    </form>
  </article>;
}
