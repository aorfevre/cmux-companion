'use client';
import { useSyncExternalStore } from 'react';
import { request } from './api-request';
const noticeKey = 'cmux-companion-update-notices';
const proofKey = 'cmux-companion-push-device';
function subscribe(callback: () => void) { window.addEventListener('storage', callback); window.addEventListener('companion-notifications', callback); return () => { window.removeEventListener('storage', callback); window.removeEventListener('companion-notifications', callback); }; }
function current() { try { return localStorage.getItem(noticeKey) !== 'false'; } catch { return true; } }
export function useUpdateNotices() { return useSyncExternalStore(subscribe, current, () => true); }
export function saveUpdateNotices(enabled: boolean) { localStorage.setItem(noticeKey, String(enabled)); window.dispatchEvent(new Event('companion-notifications')); }
export function deviceProof(create = false): string | null {
  const existing = localStorage.getItem(proofKey); if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  if (!create) return null;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem(proofKey, value); return value;
}
export function pushHeaders(create = false): Record<string, string> { const proof = deviceProof(create); return proof ? { 'x-companion-push-device': proof } : {}; }
export async function disablePush({ serverRevoked = false }: { serverRevoked?: boolean } = {}): Promise<void> {
  const errors: string[] = [];
  let proof: string | null = null;
  try { proof = deviceProof(); } catch { errors.push('Cannot read this browser’s push management key.'); }
  if (proof && !serverRevoked) {
    try { await request('/api/notifications/subscription', { method: 'DELETE', headers: { 'x-companion-push-device': proof } }); }
    catch { errors.push('Server revocation failed. Retry while connected, or revoke all subscriptions from another paired device.'); }
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.('/');
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription && !proof && !serverRevoked) errors.push('The device management key is missing. Revoke all subscriptions to finish server cleanup.');
    if (subscription && !(await subscription.unsubscribe())) throw new Error('Unsubscribe failed');
  } catch { errors.push('Browser unsubscription failed. Disable notifications in browser settings and retry.'); }
  if (errors.length) throw new Error(errors.join(' '));
}
