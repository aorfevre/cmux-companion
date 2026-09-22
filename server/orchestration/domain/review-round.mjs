import { array, identifier, integer, object, requireValue, text } from './contracts.mjs';
import { ownedArea } from './graph.mjs';

export const MAX_REVIEW_THREADS = 200;
const ACTIONS = /** @type {const} */ (['fixed', 'declined', 'comment']);

/** Review threads are external untrusted evidence. They are stored literally and
 * bounded; they never grant scope, authority or a path outside the repository.
 * @param {unknown} value @returns {import('../types.d.ts').ReviewThread[]} */
export function parseReviewThreads(value) {
  const threads = array(value, MAX_REVIEW_THREADS).map((entry) => {
    const item = object(entry);
    requireValue(Object.keys(item).length === 6 && ['id', 'path', 'line', 'author', 'body', 'isBot'].every((key) => Object.hasOwn(item, key)), 'Unexpected review thread field');
    requireValue(typeof item.isBot === 'boolean', 'Missing thread author kind');
    return { id: identifier(item.id), path: item.path === null ? null : ownedArea(item.path), line: item.line === null ? null : integer(item.line, 1), author: text(item.author, 200), body: text(item.body, 16000), isBot: item.isBot };
  });
  requireValue(new Set(threads.map((thread) => thread.id)).size === threads.length, 'Duplicate review thread');
  return threads;
}

/** Exactly one reply per recorded thread, no unknown targets.
 * @param {unknown} value @param {import('../types.d.ts').ReviewThread[]} threads
 * @returns {import('../types.d.ts').ReviewReply[]} */
export function parseReviewReplies(value, threads) {
  const replies = array(value, MAX_REVIEW_THREADS).map((entry) => {
    const item = object(entry);
    requireValue(Object.keys(item).length === 3 && ['threadId', 'action', 'body'].every((key) => Object.hasOwn(item, key)), 'Unexpected reply field');
    requireValue(ACTIONS.includes(/** @type {typeof ACTIONS[number]} */ (item.action)), 'Unknown reply action');
    return { threadId: identifier(item.threadId), action: /** @type {typeof ACTIONS[number]} */ (item.action), body: text(item.body, 8000) };
  });
  requireValue(new Set(replies.map((reply) => reply.threadId)).size === replies.length, 'Duplicate reply thread');
  for (const reply of replies) requireValue(threads.some((thread) => thread.id === reply.threadId), 'Unknown thread in reply');
  requireValue(replies.length === threads.length, 'Replies must cover every thread');
  return replies;
}

/** @param {Pick<import('../types.d.ts').Goal, 'status' | 'reviewRound'>} goal */
export function activeReviewRound(goal) {
  return goal.status === 'addressing_review' && goal.reviewRound ? goal.reviewRound : null;
}

/** @param {import('../types.d.ts').ReviewRound} round */
export function reviewRoundPhase(round) {
  if (round.state === 'fetching') return 'Fetching review threads';
  if (round.state === 'fixing') return `Fixing ${round.threads.length} ${round.threads.length === 1 ? 'thread' : 'threads'}`;
  if (round.state === 'verifying') return 'Verifying fix';
  if (round.state === 'pushing' || round.state === 'replying') return 'Pushing and replying';
  return round.state === 'settled' ? 'Round complete' : round.state === 'unknown' ? 'Push outcome uncertain' : 'Round failed';
}
