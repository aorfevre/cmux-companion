import { join } from 'node:path';
import { JournalConsumer } from '../orchestration/event-consumers.mjs';
import { NotificationStore, digest } from './store.mjs';
import { createPushTransport } from './transport.mjs';
import { registerNotificationRoutes } from './routes.mjs';

export function attention(goal) {
  if (!goal || ['merged','aborted','delivered'].includes(goal.status)) return null;
  if (goal.hold) return `hold:${goal.hold.id}`;
  if (goal.startup?.status === 'failed') return `startup:${goal.generation}`;
  if (goal.clarification && goal.clarification.answer === undefined) return `question:${goal.generation}`;
  if (goal.status === 'awaiting_approval') return `plan:${goal.revision}`;
  if (goal.status === 'ready_to_publish') return `publish:${goal.integrationHead}`;
  return null;
}
const relevant = new Set(['clarification_requested','contract_published','publication_approval_requested','goal_dispatch_held','goal_startup_failed','review_completed','pr_merged']);
export class Notifications {
  constructor({ store, goals, updateStatus = () => null, send = createPushTransport(), now = Date.now }) {
    this.store = store; this.goals = goals; this.updateStatus = updateStatus; this.send = send; this.now = now; this.pending = null; this.stopped = false;
    // Reset core databases cannot silently attach new goals to old device baselines.
    if (store.meta('journal') && store.meta('journal') !== goals.journalId) store.revokeAll();
    store.setMeta('journal', goals.journalId);
  }
  event(event) {
    if (!relevant.has(event.kind)) return;
    const goal = this.goals.get(event.goalId); if (!goal) return;
    const milestone = attention(goal), complete = event.kind === 'pr_merged' && goal.status === 'merged';
    if (!milestone && !complete) return;
    const kind = complete ? 'complete' : 'attention';
    const created = Date.parse(event.createdAt);
    const age = Math.max(0, this.now() - (Number.isFinite(created) ? created : this.now()));
    const lifetime = (complete ? 86400000 : 3600000) - age;
    if (lifetime <= 0) return;
    this.store.enqueue({ key: `${this.goals.journalId}:${goal.id}:${complete ? 'merged' : milestone}${milestone?.startsWith('startup:') ? `:${event.id}` : ''}`, kind, reference: goal.id, milestone: complete ? 'merged' : milestone, event: { id: event.id, journal: this.goals.journalId }, lifetime });
  }
  observeUpdates() {
    const state = this.updateStatus(); if (!state?.available) return;
    const candidate = state.candidate?.sha ?? null;
    const result = ['succeeded','failed','recovery_required'].includes(state.request?.status) ? `${state.request.id}:${state.request.status}` : null;
    const next = { candidate, result }, previous = this.store.meta('updates');
    if (previous) {
      if (candidate && candidate !== previous.candidate) this.store.enqueue({ key: `candidate:${candidate}`, kind: 'updates', reference: candidate, milestone: 'candidate' });
      if (result && result !== previous.result) this.store.enqueue({ key: `update:${result}`, kind: 'updates', reference: result, milestone: state.request.status, lifetime: 86400000 });
    }
    this.store.setMeta('updates', next);
  }
  payload(row, device) {
    const tag = `companion-${digest(row.event_key).slice(0,32)}`;
    if (row.kind === 'test') return { title: 'Companion test notification', body: 'Background notifications are working on this device.', url: '/settings#notifications', tag };
    if (!device.preferences[row.kind]) return null;
    if (row.kind === 'updates') {
      const state = this.updateStatus();
      if (row.milestone === 'candidate' && state?.candidate?.sha !== row.reference) return null;
      if (row.milestone !== 'candidate' && `${state?.request?.id}:${state?.request?.status}` !== row.reference) return null;
      return { title: row.milestone === 'candidate' ? 'Companion update available' : row.milestone === 'succeeded' ? 'Companion updated' : 'Companion update needs attention', body: 'Open Companion to review update status.', url: '/settings#updates', tag };
    }
    const goal = this.goals.get(row.reference);
    if (!goal || (row.kind === 'complete' ? goal.status !== 'merged' : attention(goal) !== row.milestone)) return null;
    const title = row.kind === 'complete' ? 'Companion goal complete' : 'Companion needs your attention';
    // Only the deliberately enabled title field may leave the Mac; no descriptions,
    // question/error text, repository paths or terminal output enters the payload.
    const name = String(goal.title || '').replace(/[\p{C}\u202a-\u202e\u2066-\u2069]/gu, '').slice(0,120);
    return { title, body: !device.preferences.discreet && name ? name : 'Open Companion to see the latest status.', url: `/orchestration?goal=${encodeURIComponent(goal.id)}`, tag };
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.sweep().finally(() => { this.pending = null; }); return this.pending;
  }
  async sweep() {
    this.observeUpdates();
    for (let i = 0; i < 8 && !this.stopped; i++) {
      const row = this.store.claim(); if (!row) break;
      const device = this.store.get(row.device), payload = device && this.payload(row, device);
      if (!payload || !this.store.active(row)) { this.store.discard(row); continue; }
      let result;
      try { result = await this.send(device.subscription, payload, this.store.meta('identity'), (row.expires - this.now()) / 1000); }
      catch { result = { status: 503 }; }
      this.store.finish(row, result);
    }
  }
  start() { this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 5000); this.timer.unref(); }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.pending; }
}
export async function attachNotifications({ runtime, directory, token, updateStatus, send, now, contact }) {
  let store, service;
  try {
    store = new NotificationStore({ directory: join(directory, 'notifications'), token, now });
    service = new Notifications({ store, goals: runtime.store, updateStatus, send: send ?? createPushTransport({ contact }), now });
  } catch {
    store?.close();
    await runtime.app.register(app => registerNotificationRoutes(app, { service: null, token }));
    return null;
  }
  const consumer = new JournalConsumer({ id: 'background-push-v1', from: runtime.store.cursor(), store: runtime.store, handle: event => service.event(event) });
  runtime.subscribers.push(consumer);
  await runtime.app.register(app => registerNotificationRoutes(app, { service, token }));
  runtime.app.addHook('onListen', async () => { service.start(); });
  const close = runtime.close.bind(runtime);
  let closing, closed = false;
  runtime.close = () => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => { await consumer.stop(); await service.stop(); await close(); store.close(); closed = true; })().finally(() => { closing = null; });
    return closing;
  };
  return service;
}
