import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, test, vi } from 'vitest';
import { UpdateNotice, UpdateSettings, type Updates } from '../app/updates';
const sha = 'a'.repeat(40);
const initial = (): Updates => ({ available: true, revision: 0, automatic: false, candidate: { sha, changesUrl: `https://github.com/example/repo/compare/base...${sha}` }, deployedSha: 'b'.repeat(40), observedSha: sha, lastCheckAt: '2026-09-13T10:00:00Z', checkError: null, checking: false, maintenance: false, request: null });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
function api(value = initial(), fail = false) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      const body = JSON.parse(String(init.body)); calls.push({ path, body });
      if (fail) return new Response(JSON.stringify({ error: 'Settings changed; refresh' }), { status: 409 });
      if (path.endsWith('preferences')) { value.automatic = body.automatic; value.revision++; }
      if (path.endsWith('requests') || path.endsWith('retry')) value.request = { ...body, source: 'manual', status: 'queued', phase: 'waiting', error: null };
      if (path.endsWith('cancel')) value.request!.status = 'cancelled';
      if (path.endsWith('check')) value.checking = true;
    }
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
test('automatic installation starts unchecked and requires unlocking before a revision-checked opt-in', async () => {
  const calls = api(); render(<UpdateSettings />);
  const toggle = await screen.findByRole('switch', { name: 'Automatic installation' });
  assert.equal((toggle as HTMLInputElement).checked, false); assert.equal((toggle as HTMLInputElement).disabled, true);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Allow update changes on this device' }));
  await userEvent.click(toggle); await waitFor(() => assert.equal((toggle as HTMLInputElement).checked, true));
  assert.deepEqual(calls[0], { path: '/api/updater/preferences', body: { revision: 0, automatic: true } });
  await userEvent.click(toggle); await waitFor(() => assert.equal((toggle as HTMLInputElement).checked, false));
  assert.equal(calls[1].body.revision, 1);
});
test('manual installation pins the displayed commit, requires confirmation, then offers cancellation', async () => {
  const calls = api(); render(<UpdateSettings readOnly={false} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Update when idle' })); assert.equal(calls.length, 0);
  assert.ok(screen.getByRole('group', { name: 'Confirm update' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' })); assert.equal(calls.length, 0);
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirm installation' }));
  assert.equal(calls[0].body.sha, sha); assert.equal(calls[0].body.whenIdle, false);
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel queued update' }));
  assert.equal(calls[1].body.id, calls[0].body.id); assert.ok(await screen.findByText(/Queued update cancelled/));
});
test('Later persists per candidate without disabling notifications or automatic installation', async () => {
  api(); render(<UpdateNotice />);
  assert.equal((await screen.findByRole('link', { name: 'View update' })).getAttribute('href'), '/settings#updates');
  await userEvent.click(screen.getByRole('button', { name: 'Later' }));
  assert.equal(screen.queryByRole('complementary'), null); assert.equal(localStorage.getItem('cmux-update-dismissed'), sha);
});
test('read-only controls cannot mutate; API errors are actionable; unavailable installer remains explicit', async () => {
  const calls = api(); const view = render(<UpdateSettings readOnly />);
  assert.equal((await screen.findByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled, true); assert.equal(calls.length, 0);
  view.unmount(); api(initial(), true); const failed = render(<UpdateSettings readOnly={false} />);
  await userEvent.click(await screen.findByRole('switch', { name: 'Automatic installation' })); assert.ok(await screen.findByRole('alert'));
  failed.unmount(); vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))); render(<UpdateSettings />);
  assert.ok(await screen.findByText(/installed bundled updater is required/));
});
test('check, retry, automatic waiting, recovery and pending-CI states are explained', async () => {
  const state = initial(); state.request = { id: 'failed-001', sha, source: 'manual', status: 'failed', phase: 'failed', error: 'Previous version restored' };
  const calls = api(state); const view = render(<UpdateSettings readOnly={false} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Retry update' })); await userEvent.click(screen.getByRole('button', { name: 'Confirm installation' })); assert.equal(calls[0].path, '/api/updater/retry');
  await userEvent.click(screen.getByRole('button', { name: 'Check for updates' })); assert.ok(await screen.findByRole('button', { name: 'Checking for updates…' }));
  view.unmount(); state.request = { ...state.request!, source: 'automatic', status: 'queued' }; api(state); const queued = render(<UpdateSettings readOnly={false} />); assert.ok(await screen.findByText('Queued by automatic installation.')); queued.unmount();
  state.request = { ...state.request, status: 'running', phase: 'restarting' }; api(state); const running = render(<UpdateSettings readOnly={false} />); assert.ok(await screen.findByText(/This transaction has started/)); running.unmount();
  state.candidate = null; state.request = null; state.checkError = null; api(state); render(<UpdateSettings readOnly={false} />); assert.ok(await screen.findByText('A newer main commit is awaiting successful checks.'));
});
