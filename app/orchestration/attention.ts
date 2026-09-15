"use client";
import type { Goal } from './goal-board';
export function attention(goal: Goal) {
  if (goal.status === 'aborted' || goal.status === 'merged') return null;
  if (goal.hold) return 'On hold · ' + goal.hold.reasons.map(reason => reason.message).join(' ');
  if (goal.team?.assignments.some(assignment => !assignment.profileId)) return 'Choose an eligible team profile to continue.';
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
