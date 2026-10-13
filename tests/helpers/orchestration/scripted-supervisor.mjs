import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

/** Account-free deterministic agent used only by the disposable development
 * composition. It uses the real credential-scoped API, never workflow storage.
 * It is transport/journey evidence, not evidence of a native model's behavior. */
export async function runScriptedSupervisor({ bridge, contract, signal }) {
  let asked = false;
  const state = async () => {
    for (;;) {
      signal.throwIfAborted();
      try { return await bridge.status(); }
      catch (error) {
        if (error.code !== 'FORBIDDEN') throw error;
        // The fake process starts before its launch acknowledgement commits.
        await delay(50, undefined, { signal });
      }
    }
  };
  const send = async (action, payload) => {
    for (;;) {
      const goal = await state();
      if (goal.conversation.paused) { await delay(100, undefined, { signal }); continue; }
      const command = { id: randomUUID(), goalId: goal.id, expectedVersion: goal.version, type: `supervisor_${action}`, payload };
      try { return await bridge.submit(command); }
      catch (error) { if (error.code !== 'VERSION_CONFLICT') throw error; }
    }
  };
  while (!signal.aborted) {
    const goal = await state();
    if (goal.conversation.paused) { await delay(100, undefined, { signal }); continue; }
    const queued = goal.conversation.messages.filter(message => message.author === 'user' && message.delivery === 'queued');
    for (const message of queued) {
      await send('ack', { through: message.sequence });
      if (!asked && goal.revision === 0) {
        asked = true;
        await send('question', { message: 'Shall I use the disposable module fixture to demonstrate this goal?', replyTo: message.sequence });
      } else {
        await send('reply', { message: 'Received your guidance in the same supervisor conversation.', replyTo: message.sequence });
        if (/revise|change the plan/i.test(message.text) && goal.revision) await send('revise', { message: message.text });
        const latest = await state();
        if (latest.status === 'discovering') await send('propose', { contract });
      }
    }
    const latest = await state();
    if (latest.recovery?.state === 'strategy') await send('recovery_strategy', { holdId: latest.hold.id, strategy: 'reconstruct', rationale: 'Reconstruct from the saved contract and failure evidence instead of repeating the previous attempt.' });
    else if (latest.status === 'discovering' && latest.planningRequest && !queued.length) await send('propose', { contract });
    else if (latest.status === 'building' && !latest.hold && !latest.conversation.dispatchApproved) await send('dispatch', {});
    else if (!latest.conversation.waiting) await send('wait', { throughWake: latest.conversation.wake });
    await delay(100, undefined, { signal });
  }
  signal.throwIfAborted();
}
