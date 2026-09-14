import { createHash } from 'node:crypto';
import { JournalConsumer } from './event-consumers.mjs';
import { actionView } from './domain/action-view.mjs';

/** Read the current aggregate, not stale journal payloads: a question already
 * answered or plan already approved must not alert on restart.
 * @param {import('./types.d.ts').Goal | null} goal */
export function goalAttention(goal) {
  if (!goal || ['aborted', 'merged'].includes(goal.status)) return null;
  if (goal.clarification && !goal.clarification.answer) return {
    id: `question:${goal.generation}:${goal.revision}:${createHash('sha256').update(goal.clarification.question).digest('hex')}`,
    title: `${goal.title} needs your input`,
    body: goal.clarification.question,
  };
  if (actionView(goal).actions.some(action => action.type === 'approve')) return {
    id: `approval:${goal.generation}:${goal.revision}`,
    title: `${goal.title} is ready for approval`,
    body: 'Review the plan and its verification checks in Companion.',
  };
  return null;
}

/** Register before runtime.start/listen so the existing journal lifecycle owns
 * delivery and shutdown. Notification failures never grant workflow authority.
 * @param {{store: import('./storage/store.mjs').OrchestrationStore; subscribers: JournalConsumer[]}} runtime
 * @param {{goalAttention: (input: {journalId:string;goalId:string;attentionId:string;title:string;body:string}) => Promise<unknown>}} pushService */
export function attachGoalAttention(runtime, pushService) {
  const consumer = new JournalConsumer({
    store: runtime.store, id: 'goal-attention',
    handle: async event => {
      const goal = runtime.store.get(event.goalId), attention = goalAttention(goal);
      if (!goal || !attention) return;
      await pushService.goalAttention({ journalId: runtime.store.journalId, goalId: goal.id,
        attentionId: attention.id, title: attention.title, body: attention.body });
    },
  });
  runtime.subscribers.push(consumer);
  return consumer;
}
