import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, requireValue } from '../domain/contracts.mjs';

/** @typedef {{ endpoint: string; credential: string }} NativeActivation */
/** A supervisor may exist before record_dispatch commits. It cannot start the
 * provider until the owning service confirms current scoped authority. No response
 * body, redirect, prompt, credential or provider error is logged or reflected.
 * @param {NativeActivation} activation @param {AbortSignal} signal */
export async function awaitNativeActivation(activation, signal) {
  const url = new URL(activation.endpoint);
  requireValue(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
    && typeof activation.credential === 'string' && activation.credential.length >= 32 && activation.credential.length <= 128, 'Invalid private activation configuration');
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DomainError('ABORTED', 'Native activation was aborted');
    let response;
    try {
      response = await fetch(new URL('/api/orchestration/agent/ready', url), {
        redirect: 'error', headers: { authorization: `Bearer ${activation.credential}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now())))]),
      });
    } catch { /* A service restart may temporarily refuse the loopback connection. */ }
    if (response) {
      await response.body?.cancel();
      if (response.status === 204) return;
      requireValue(response.status === 409 || response.status === 503, 'Native dispatch authority was denied', 'FORBIDDEN');
    }
    await delay(50, undefined, { signal }).catch(() => {});
  }
  throw new DomainError('ACTIVATION_TIMEOUT', 'Native dispatch identity did not become ready');
}
