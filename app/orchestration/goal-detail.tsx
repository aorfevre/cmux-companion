"use client";
import type { Contract } from '../../server/orchestration/types';
import { GoalActivity } from './goal-activity';
import { CheckEvidence } from './check-evidence';
import { GoalTeam } from './goal-team';
import { WaveBoard } from './wave-board';
import type { Action, Goal } from './goal-board';
export function GoalTechnicalDetails({ goal, disabled, terminal, act, control }: {
  goal: Goal & { contracts: { revision: number; contract: Contract }[] }; disabled: boolean; terminal: boolean;
  act(goal: Goal, action: Action): Promise<boolean>; control(goal: Goal, action: 'terminal' | 'reconcile', attemptId?: string): Promise<void>;
}) {
  let planReviewMessage = 'Plan review is off. Review the plan yourself before approving implementation.';
  if (goal.planReviewRequired) planReviewMessage = goal.planReviewPending
    ? 'Initial plan review is off; the required review must finish before approval.'
    : 'Plan review accepted. Your approval is still required before implementation.';
  return <div className="goal-technical" aria-label="Goal detail">
    <section className="goal-technical-section"><h3>Source</h3><div className="orch-eyebrow">PLAN {goal.revision}</div>
      <p>{goal.plannerName}</p>
      {goal.experienceVersion !== 2 && !goal.actions.some(action => action.type === 'adopt_agent_recovery') && <p>To enable agent-led recovery, configure a ready planner profile as supervisor and let existing workers and operations settle.</p>}
      {goal.decision.detail && <p>Recorded reason: <code>{goal.decision.detail}</code></p>}
      {Boolean(goal.planRevisionCount) && <p role="status">Automatic plan revisions: {goal.planRevisionCount}{goal.recoveryPolicy ? ' (included in recovery spending)' : ' of 2'}.{goal.status === 'discovering' ? ' Addressing review findings.' : ''}</p>}
      {goal.recoveryPolicy && <section aria-label="Agent recovery"><h3>Agent recovery</h3><p>{Math.max(0, goal.recoveryPolicy.limit - goal.recoveryPolicy.priorSpent - goal.recoveryPolicy.decisions.length)} of {goal.recoveryPolicy.limit} recovery actions remaining.</p>
        {goal.recoveryPolicy.decisions.map(entry => <div key={entry.id}><strong>{entry.strategy} · {entry.state}</strong><p>{entry.rationale}</p><p>{entry.evidence.map(item => item.cause).join(', ')}</p>{entry.state === 'scheduled' && <p>Scheduled for {new Date(entry.dueAt).toLocaleString()}.</p>}</div>)}
      </section>}
      {goal.planReviewEnabled === false && ['discovering', 'awaiting_approval'].includes(goal.status) && <p>{planReviewMessage}</p>}
      <p>Base branch: {goal.baseBranch}</p><p>Integrated head <code>{goal.integrationHead.slice(0, 12) || 'Preparing fresh base…'}</code></p><button disabled={disabled} onClick={() => void control(goal, 'reconcile')}>Reconcile workers</button>
      {goal.status === 'delivered' && <p role="status">{goal.mergeSync?.state === 'closed' ? 'Closed without merging on GitHub.' : goal.mergeSync?.error || 'Waiting for merge on GitHub.'} {goal.mergeSync ? `Last checked ${new Date(goal.mergeSync.checkedAt).toLocaleString()}.` : 'First merge check pending.'} Checks run every 15 minutes while your Mac is online.</p>}
      {goal.status === 'addressing_review' && goal.reviewRound && <p role="status" aria-label="Review round phase">{goal.reviewRound.phase}{goal.reviewRound.error ? ` · ${goal.reviewRound.error}` : ''}</p>}
      {goal.publication?.observation && <p>Publication: {goal.publication.observation.status}</p>}
      {goal.publication?.observation?.status === 'target_moved' && <p className="orch-banner">The target branch moved to <code>{goal.publication.observation.baseHeadSha?.slice(0, 12) ?? 'an unavailable commit'}</code>. Publishing keeps the reviewed and verified head above unchanged; it does not rebase or merge the target branch.</p>}
      {goal.status === 'awaiting_approval' && goal.team && <p>Approval includes this design, plan, verification and proposed team.</p>}
    {Boolean(goal.references?.length) && <section className="orch-card"><h3>Reference files</h3><ul>{goal.references.map(reference => <li key={reference.id}><a href={`/api/orchestration/goals/${encodeURIComponent(goal.id)}/references/${reference.id}`} target="_blank" rel="noreferrer">{reference.name}</a> <small>{Math.ceil(reference.bytes / 1024)} KiB · {reference.mimeType}</small></li>)}</ul></section>}
    </section>
    <section className="goal-technical-section"><h3>Waves and sessions</h3><WaveBoard goal={goal} />
    {<div className="orch-card"><h3>Agent activity</h3>{goal.attempts.map(attempt => <div className="orch-attempt" key={attempt.id}><strong>{attempt.role === 'planner' ? goal.plannerName : attempt.role}{attempt.taskId ? ` · ${attempt.taskId}` : ''}</strong>{attempt.assignment && <small>{attempt.assignment.label} · {attempt.assignment.model}</small>}<span>{attempt.status} · worker {attempt.workerState}{attempt.current ? '' : ' · historical'}</span>{attempt.workerState === 'unknown' && <p className="orch-banner">Ownership is uncertain. Capacity stays reserved until reconciliation confirms termination.</p>}{attempt.error && <p>{attempt.error}</p>}{attempt.current && attempt.workerState === 'running' && <details><summary>{attempt.role === 'planner' ? 'Planning session' : 'Agent session'}</summary><div className="orch-actions"><button disabled={disabled || !terminal} onClick={() => void control(goal, 'terminal', attempt.id)}>{attempt.role === 'planner' ? 'Open planning terminal' : `Open ${attempt.role} terminal`}</button>{goal.actions.filter(action => action.type === 'resume_planner' && action.payload.attemptId === attempt.id).map(action => <button key={action.type} disabled={disabled || !terminal} onClick={() => void act(goal, action)}>{action.label}</button>)}{!terminal && <small>This adapter has no native terminal.</small>}</div></details>}</div>)}</div>}
    </section>
    <section className="goal-technical-section"><h3>Team and models</h3><GoalTeam goal={goal} disabled={disabled} act={act} /></section>
    <section className="goal-technical-section"><h3>Run report</h3>
    {(goal.integration || Boolean(goal.integrationResults?.length)) && <section className="orch-card"><h3>Integration</h3>{goal.integration && <p>{goal.integration.state} · {goal.integration.taskId || 'Combined output'}{goal.integration.code && ` · ${goal.integration.code}`}</p>}{goal.integrationResults?.map(result => <p key={result.operationId}>{result.taskId || 'Combined repair'} integrated at <code>{result.headSha.slice(0, 12)}</code></p>)}</section>}
    {(goal.reviewRound || goal.reviewRounds.length > 0) && <section className="orch-card"><h3>Review rounds</h3>{[...(goal.reviewRound ? [goal.reviewRound] : []), ...goal.reviewRounds].map(round => <div className="orch-review" key={round.id}>
      <strong>{round.outcome === 'addressed' ? 'Addressed' : round.outcome === 'nothing_to_address' ? 'Nothing to address' : round.outcome === 'failed' ? 'Failed' : round.phase} · {round.threads.length} {round.threads.length === 1 ? 'thread' : 'threads'}{round.fixHeadSha ? ` · new head ${round.fixHeadSha.slice(0, 12)}` : ''}</strong>
      <p>Started {new Date(round.startedAt).toLocaleString()}{round.trigger === 'conflict' ? ' · Started automatically by an observed merge conflict' : ''}{round.error ? ` · ${round.error}` : ''}</p>
      {round.mergeCommitSha && <p>Merged target <code>{round.mergedBaseSha?.slice(0, 12)}</code>{round.conflictPaths?.length ? ` · resolved ${round.conflictPaths.length} ${round.conflictPaths.length === 1 ? 'conflict' : 'conflicts'}: ${round.conflictPaths.join(', ')}` : ' · no conflicts'}</p>}
      {round.threads.map(thread => { const reply = round.replies?.find(entry => entry.threadId === thread.id); return <blockquote key={thread.id}><strong>{thread.author}{thread.path ? ` · ${thread.path}${thread.line ? `:${thread.line}` : ''}` : ''}</strong><p>{thread.body}</p>{reply && <p><em>{reply.action}{round.resolved?.includes(thread.id) ? ' · resolved' : ''}{round.unconfirmed?.includes(thread.id) ? ' · reply unconfirmed' : ''}</em> {reply.body}</p>}</blockquote>; })}
    </div>)}</section>}
    {goal.reviews.length > 0 && <section className="orch-card"><h3>Independent reviews</h3>{goal.reviews.length === 0 && <p>No review evidence yet.</p>}{goal.reviews.map(review => <div className="orch-review" key={review.id}><strong>{review.kind}{review.taskId ? ` · ${review.taskId}` : ''}: {review.disposition.replaceAll('_', ' ')}</strong><p>Target <code>{review.target.startsWith('contract:') ? review.target : review.target.slice(0, 12)}</code></p>{review.findings.map(finding => <blockquote key={finding.id}><strong>{finding.blocking ? 'Blocking' : finding.severity}: {finding.title}</strong><p>{finding.evidence}</p><p>{finding.suggestion}</p></blockquote>)}</div>)}</section>}
    {goal.verification && <section className="orch-card" aria-label="Combined verification"><h3>Combined verification</h3>{goal.verification ? <><p>Checked head <code>{goal.verification.headSha.slice(0, 12)}</code></p>{goal.verification.checks.map(check => <div key={check.id}><p><strong>{check.id}</strong> · {check.passed ? 'Passed' : 'Failed'}</p><CheckEvidence goalId={goal.id} artifactId={check.artifactId} /></div>)}</> : <p>No completed verification for the current combined head.</p>}</section>}
    {goal.verificationRuns?.length > 0 && <section className="orch-card"><h3>Verification runs</h3>{goal.verificationRuns.map(run => <section key={run.operationId}><h4>{run.attemptId ? `Worker check · ${run.attemptId}` : run.waveId ? `Wave ${run.waveId}` : 'Combined output'} · plan {run.revision}</h4><p>{run.status} · worker {run.workerState}{run.current ? '' : ' · historical'} · <code>{run.headSha.slice(0, 12)}</code></p>{run.verification?.checks.map(check => <div key={check.id}><p><strong>{check.id}</strong> · {check.passed ? 'Passed' : 'Failed'}</p><CheckEvidence goalId={goal.id} artifactId={check.artifactId} /></div>)}</section>)}</section>}
    {!goal.verification && goal.reviews.length === 0 && !goal.reviewRound && goal.reviewRounds.length === 0 && <section className="orch-card"><h3>No review or verification evidence yet</h3><p>Results will appear here as the goal progresses.</p></section>}
    </section>
    <section className="goal-technical-section"><GoalActivity goalId={goal.id} version={goal.version} /></section>
  </div>;
}
