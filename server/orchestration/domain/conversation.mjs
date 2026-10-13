import { integer, requireValue, text } from './contracts.mjs';

/** @typedef {import('../types.d.ts').Goal} Goal */
/** @typedef {import('../types.d.ts').Attempt} Attempt */

/** A supervisor keeps its original immutable native identity across plan revisions.
 * Only the explicitly scoped conversation commands accept that identity.
 * @param {Goal} goal @param {Attempt | undefined} attempt */
export function isSupervisor(goal, attempt) {
  return Boolean(goal.experienceVersion === 2 && attempt?.role === 'planner'
    && goal.conversation?.supervisorAttemptId === attempt.id);
}

/** Physical supervisor ownership is still accounted for and reconciled. Only
 * execution barriers may exclude this read-only conversational role.
 * @param {Goal} goal @param {Attempt} attempt */
export const ownsExecution = (goal, attempt) => attempt.workerState !== 'stopped' && !(isSupervisor(goal, attempt) && attempt.workerState === 'running' && attempt.status === 'running');

export const SUPERVISOR_COMMANDS = new Set(['supervisor_reply', 'supervisor_question',
  'supervisor_recovery_strategy',
  'supervisor_ack', 'supervisor_turn_start', 'supervisor_turn_idle', 'supervisor_turn_defer', 'supervisor_activate', 'supervisor_wait', 'supervisor_propose', 'supervisor_revise', 'supervisor_dispatch']);
export const CONVERSATION_COMMANDS = new Set(['send_goal_message', 'pause_goal', 'resume_goal',
  'supervisor_reply', 'supervisor_question', 'supervisor_ack', 'supervisor_turn_start', 'supervisor_turn_idle', 'supervisor_turn_defer', 'supervisor_activate', 'supervisor_wait', 'supervisor_dispatch']);

/** @param {Goal} goal @param {string} id @param {import('../types.d.ts').GoalMessage['author']} author
 * @param {import('../types.d.ts').GoalMessage['kind']} kind @param {string} content @param {number} [replyTo] */
export function appendMessage(goal, id, author, kind, content, replyTo) {
  const conversation = goal.conversation;
  requireValue(conversation, 'This goal uses the original experience', 'NOT_READY');
  requireValue(conversation.messages.length < 4000, 'Conversation message limit reached', 'CONVERSATION_FULL');
  const message = { id, sequence: conversation.messages.length + 1, author, kind,
    text: text(content, 12000), revision: goal.revision,
    delivery: /** @type {import('../types.d.ts').GoalMessage['delivery']} */ (author === 'user' ? 'queued' : 'delivered'),
    ...(replyTo === undefined ? {} : { replyTo }) };
  conversation.messages.push(message);
  return message;
}

/** @param {Goal} goal @param {import('../types.d.ts').Command} command
 * @param {import('../types.d.ts').Authority} authority @returns {import('../types.d.ts').DomainEvent} */
export function conversationCommand(goal, command, authority) {
  const conversation = goal.conversation;
  requireValue(goal.experienceVersion === 2 && conversation, 'This goal uses the original experience', 'NOT_READY');
  const input = /** @type {Record<string,unknown>} */ (command.payload);
  if (SUPERVISOR_COMMANDS.has(command.type)) {
    requireValue(authority.kind === 'agent' && isSupervisor(goal, goal.attempts.find(attempt => attempt.id === authority.attemptId)), 'Supervisor authority required', 'FORBIDDEN');
  } else requireValue(authority.kind === 'user', 'User authority required', 'FORBIDDEN');
  let kind = command.type;
  switch (command.type) {
    case 'send_goal_message':
      appendMessage(goal, command.id, 'user', 'message', text(input.message, 8000));
      conversation.wake++; conversation.waiting = false; kind = 'goal_message_queued'; break;
    case 'pause_goal':
    case 'resume_goal': {
      const paused = command.type === 'pause_goal';
      requireValue(conversation.paused !== paused, paused ? 'Goal is already paused' : 'Goal is not paused', 'NOT_READY');
      conversation.paused = paused; conversation.wake++;
      appendMessage(goal, command.id, 'service', 'decision', paused ? 'Paused new work. Active work may finish; its evidence is retained.' : 'Resumed goal.');
      kind = paused ? 'goal_paused' : 'goal_resumed'; break;
    }
    case 'supervisor_ack': {
      const through = integer(input.through, 1);
      requireValue(through <= conversation.messages.length, 'Unknown message sequence');
      for (const message of conversation.messages) if (message.sequence <= through && message.author === 'user' && message.delivery === 'queued') message.delivery = 'delivered';
      kind = 'goal_messages_delivered'; break;
    }
    case 'supervisor_reply':
    case 'supervisor_question': {
      requireValue(!conversation.paused, 'Goal is paused', 'NOT_READY');
      const replyTo = input.replyTo === undefined ? undefined : integer(input.replyTo, 1);
      if (replyTo !== undefined) {
        const message = conversation.messages.find(entry => entry.sequence === replyTo && entry.author === 'user');
        requireValue(message, 'Reply does not identify a user message');
        message.delivery = 'answered';
      }
      appendMessage(goal, command.id, 'supervisor', command.type === 'supervisor_question' ? 'question' : 'message', text(input.message, 8000), replyTo);
      kind = command.type === 'supervisor_question' ? 'supervisor_question_asked' : 'supervisor_replied'; break;
    }
    case 'supervisor_turn_defer':
      requireValue(conversation.paused, 'Only an unstarted paused native turn can defer', 'NOT_READY');
      conversation.capacityReleased = true; kind = 'supervisor_turn_deferred'; break;
    case 'supervisor_turn_start':
      requireValue(!conversation.paused && integer(input.throughWake) === conversation.wake, 'Supervisor turn wake changed', 'NOT_READY');
      conversation.turnManaged = true; conversation.turnWake = conversation.wake;
      conversation.capacityReleased = false; kind = 'supervisor_turn_started'; break;
    case 'supervisor_turn_idle':
      requireValue(conversation.turnManaged && conversation.turnWake !== undefined && conversation.seenWake >= conversation.turnWake, 'Supervisor must record idle before finishing its native turn', 'SUPERVISOR_TURN_UNSETTLED');
      conversation.capacityReleased = true; kind = 'supervisor_turn_idle'; break;
    case 'supervisor_activate':
      requireValue(!conversation.paused && integer(input.throughWake) === conversation.wake && conversation.wake > conversation.seenWake, 'No actionable wake is available', 'NOT_READY');
      conversation.capacityReleased = false;
      kind = 'supervisor_activated'; break;
    case 'supervisor_wait': {
      const seen = integer(input.throughWake);
      requireValue(seen <= conversation.wake && seen >= conversation.seenWake, 'Conversation cursor changed', 'STALE_TARGET');
      conversation.seenWake = seen; conversation.waiting = seen === conversation.wake;
      conversation.capacityReleased = !conversation.turnManaged;
      kind = 'supervisor_waiting'; break;
    }
    case 'supervisor_dispatch':
      requireValue(!conversation.paused && !goal.hold && goal.status === 'building' && goal.approvedRevision === goal.revision, 'Approve the current proposal before dispatch', 'NOT_READY');
      requireValue(!conversation.dispatchApproved, 'Execution is already admitted', 'NOT_READY');
      conversation.dispatchApproved = true;
      appendMessage(goal, command.id, 'supervisor', 'progress', 'Starting the approved work.');
      kind = 'supervisor_dispatched'; break;
    default: throw new Error('Unsupported conversation command');
  }
  return { kind, payload: {} };
}

const WAKE_EVENTS = new Set(['goal_approved', 'revision_requested', 'attempt_stopped',
  'agent_recovery_adopted', 'agent_recovery_scheduled', 'agent_recovery_applied', 'recovery_budget_extended',
  'candidate_verified', 'task_integrated', 'review_completed', 'verification_recorded', 'attempt_failed',
  'integration_failed', 'integration_conflict', 'integration_repaired', 'verification_uncertain',
  'goal_dispatch_held', 'goal_recovery_authorized', 'goal_base_pinned', 'goal_startup_failed',
  'contract_published', 'pr_observed', 'pr_merged', 'publication_approval_requested']);

/** Actionable lifecycle changes wake the supervisor; its own polling/acknowledgements
 * do not create a model loop. @param {Goal} goal @param {import('../types.d.ts').DomainEvent[]} events */
export function wakeConversation(goal, events) {
  if (goal.conversation && events.some(event => WAKE_EVENTS.has(event.kind))) {
    goal.conversation.wake++; goal.conversation.waiting = false;
  }
}
