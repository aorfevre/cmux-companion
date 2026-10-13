import { randomUUID } from 'node:crypto';
import timers from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { requireValue } from '../domain/contracts.mjs';

/** Native turn framing is transport evidence, never goal completion authority.
 * Only assistant prose reaches the visible terminal; tool/config frames remain
 * private. A successful final frame must name the original native session.
 * @param {AsyncIterable<Buffer>} stream @param {string} conversationId
 * @param {(text:string)=>void} display
 * @param {{provider?:'claude'|'codex'; sessionId?:()=>string}} [options] */
export async function readSupervisorTurn(stream, conversationId, display, { provider = 'claude', sessionId } = {}) {
  const decoder = new StringDecoder('utf8'); let pending = '', complete = false, firstFrame = true, started = false, nativeSession = '';
  /** @param {string} text */
  const prose = text => display([...text].filter(char => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('') + '\n');
  /** @param {string} line */
  const frame = (line) => {
    if (!line.trim()) return;
    const initial = firstFrame; firstFrame = false;
    if (initial && /^\[i\] Joined existing CLIProxy on port [0-9]{1,5} \(https?\)\r?$/.test(line)) return;
    const value = JSON.parse(line);
    requireValue(!complete, 'Native supervisor emitted data after its final result', 'SUPERVISOR_PROTOCOL_FAILED');
    if (provider === 'codex') {
      requireValue(value.type !== 'error' && value.type !== 'turn.failed', 'Native supervisor turn failed', 'SUPERVISOR_PROTOCOL_FAILED');
      if (value.type === 'thread.started') {
        requireValue(!started && typeof value.thread_id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.thread_id), 'Native supervisor thread changed', 'SUPERVISOR_PROTOCOL_FAILED');
        started = true; nativeSession = value.thread_id;
      } else {
        requireValue(started, 'Native supervisor thread is missing', 'SUPERVISOR_PROTOCOL_FAILED');
        if (value.type === 'item.completed' && value.item?.type === 'agent_message' && typeof value.item.text === 'string') prose(value.item.text);
        if (value.type === 'turn.completed') {
          // SessionStart may finish after thread.started; validate its receipt
          // at turn completion, before the runner can release or resume work.
          requireValue(nativeSession === sessionId?.(), 'Native supervisor thread changed', 'SUPERVISOR_PROTOCOL_FAILED');
          complete = true;
        }
      }
      return;
    }
    if (value.type === 'assistant') for (const part of value.message?.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') prose(part.text);
    }
    if (value.type === 'result') {
      requireValue(value.session_id === conversationId && value.subtype === 'success' && value.is_error !== true,
        'Native supervisor turn did not finish in its recorded session', 'SUPERVISOR_PROTOCOL_FAILED');
      complete = true;
    }
  };
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    requireValue(Buffer.byteLength(pending) <= 2 * 1024 * 1024, 'Native supervisor frame exceeds limit', 'SUPERVISOR_PROTOCOL_FAILED');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) { frame(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
  }
  pending += decoder.end(); if (pending) frame(pending);
  requireValue(complete, 'Native supervisor ended without a final session result', 'SUPERVISOR_PROTOCOL_FAILED');
}

/** Retry uncertain command delivery with its exact receipt. Service downtime
 * never becomes another model turn. @param {ReturnType<import('../bridge.mjs').createBridge>} bridge
 * @param {'supervisor_turn_start'|'supervisor_turn_idle'|'supervisor_turn_defer'} type @param {AbortSignal} signal */
export async function supervisorTurnCommand(bridge, type, signal) {
  /** @type {import('../types.d.ts').Command | null} */ let command = null;
  for (;;) {
    signal.throwIfAborted();
    try {
      const state = await bridge.status(signal);
      if (type === 'supervisor_turn_start' && state.conversation.paused) {
        if (!state.conversation.capacityReleased) await supervisorTurnCommand(bridge, 'supervisor_turn_defer', signal);
        command = null; await timers.setTimeout(1000, undefined, { signal }); continue;
      }
      command ??= { id: randomUUID(), goalId: state.id, expectedVersion: state.version, type, payload: { throughWake: state.conversation.wake } };
      await bridge.submit(command);
      return await bridge.status(signal);
    } catch (error) {
      signal.throwIfAborted();
      const rawCode = /** @type {{code?:unknown}} */ (error).code;
      const code = typeof rawCode === 'string' ? rawCode : undefined;
      if (code === 'VERSION_CONFLICT' || code === 'CAPACITY_FULL' || code === 'NOT_READY' && type !== 'supervisor_turn_idle') command = null;
      else if (code && code !== 'REQUEST_FAILED') throw error;
      await timers.setTimeout(1000, undefined, { signal });
    }
  }
}
