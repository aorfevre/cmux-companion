"use client";
import { useState } from 'react';
import type { Goal } from './goal-board';
export function attention(goal: Goal) {
  if (goal.status === 'aborted' || goal.status === 'merged') return null;
  if (goal.status === 'delivered' && goal.mergeSync?.state === 'closed') return 'The PR was closed without merging. Review it on GitHub.';
  if (goal.status === 'ready_to_publish' && !goal.publication?.approved) return 'Review the evidence and approve PR publication.';
  if (goal.startup?.status === 'failed') return goal.startup.error || 'Could not prepare the base branch. Retry startup.';
  if (goal.clarification && !goal.clarification.answer) return goal.clarification.question;
  const latest = new Map(goal.attempts.filter(attempt => attempt.current).map(attempt => [JSON.stringify([attempt.role, attempt.taskId, attempt.target]), attempt]));
  const failed = [...latest.values()].find(attempt => attempt.workerState === 'unknown' || attempt.status === 'failed');
  if (failed) return failed.error || (failed.workerState === 'unknown' ? 'Agent ownership needs reconciliation.' : 'An agent needs a retry.');
  if (goal.tasks.some(task => task.status === 'failed')) return 'A task needs attention.';
  if (goal.status === 'awaiting_approval') return goal.approvalBlocked || 'Your plan is ready to approve.';
  if (goal.verification?.checks.some(check => !check.passed)) return 'Verification needs attention.';
  return null;
}
const taskColumns = ['To do', 'Running', 'Review', 'Done'] as const;
export function taskColumn(status: Goal['tasks'][number]['status']) { return status === 'integrated' ? 'Done' : status === 'in_review' || status === 'accepted' ? 'Review' : status === 'running' ? 'Running' : 'To do'; }
export function TaskKanban({ goal }: { goal: Goal }) {
  const [column, setColumn] = useState<string>('To do');
  if (!goal.tasks.length) return null;
  return <section className="orch-card" aria-label="Task board"><h3>Tasks</h3><nav className="orch-column-picker" aria-label="Task columns">{taskColumns.map(name => <button key={name} aria-pressed={column === name} onClick={() => setColumn(name)}>{name} ({goal.tasks.filter(task => taskColumn(task.status) === name).length})</button>)}</nav><div className="orch-kanban-columns orch-task-columns">{taskColumns.map(name => <section className="orch-kanban-column" data-active={column === name} key={name} aria-label={`Tasks ${name}`}><h4>{name}</h4>{goal.tasks.filter(task => taskColumn(task.status) === name).map(task => <div className="orch-task-card" key={task.id} data-task={task.id}><strong>{task.id} · {task.title}</strong><span className="orch-state"> · {task.status.replaceAll('_', ' ')}</span><p>{task.dependsOn.length ? `Depends on ${task.dependsOn.join(', ')}` : 'Independent task'}</p><small>{goal.attempts.filter(attempt => attempt.current && attempt.taskId === task.id).map(attempt => `${attempt.role}: ${attempt.status}`).join(' · ') || 'Agent not assigned yet'}</small>{['failed', 'repair_required'].includes(task.status) && <p className="orch-attention">Needs attention · {task.status.replaceAll('_', ' ')}</p>}{task.dependsOn.some(id => goal.tasks.find(entry => entry.id === id)?.status !== 'integrated') && <p className="project-context">Waiting for dependencies</p>}</div>)}</section>)}</div><details><summary>Dependency graph</summary><ol>{goal.tasks.map(task => <li key={task.id}><strong>{task.id}</strong> ← {task.dependsOn.join(', ') || 'No dependencies'} · {task.status.replaceAll('_', ' ')}</li>)}</ol></details></section>;
}
