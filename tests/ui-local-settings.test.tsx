import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';
import { LocalSettingsPanel, type Settings } from '../app/settings/settings-panel';
const defaults = (): Settings => ({ projects: [], provider: 'claude', providers: { claude: { executable: 'ccs', args: ['claude'], model: 'default' }, codex: { executable: 'ccs', args: ['codex'], model: 'default' } }, tools: { cmux: 'cmux', tailscale: 'tailscale', chrome: 'chrome' }, execution: { global: 4, perGoal: 4, planners: 2, ceilingMs: 1800000, idleMs: 240000, maxOutputBytes: 1048576, killGraceMs: 5000 }, previews: { portStart: 8500, portEnd: 8599 }, onboarding: { completed: false } });
afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
test('onboarding validates a project and persists editable provider commands with a revision', async () => {
  let saved = { revision: 3, settings: defaults(), imported: false };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/inspect')) return json({ path: '/projects/example', name: 'Example', github: null, remote: null });
    if (url.endsWith('/validate')) return json({ ready: true });
    if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); assert.equal(body.expectedRevision, 3); saved = { ...saved, settings: body.settings, revision: 4 }; }
    return json(saved);
  }));
  render(<LocalSettingsPanel onboarding />);
  await screen.findByRole('heading', { name: '1. Projects' });
  fireEvent.change(screen.getByLabelText('Project directory'), { target: { value: '/projects/example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate and add project' }));
  await screen.findByDisplayValue('Example');
  fireEvent.change(screen.getByLabelText('codex executable'), { target: { value: '/opt/bin/codex' } });
  fireEvent.change(screen.getByLabelText('codex arguments (one per line)'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Default provider'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate codex' }));
  await screen.findByText('Ready for new goals');
  fireEvent.click(screen.getByRole('button', { name: 'Complete setup' }));
  await screen.findByText('Setup complete. You can start a goal.');
  assert.equal(saved.settings.onboarding.completed, true);
  assert.deepEqual(saved.settings.providers.codex, { executable: '/opt/bin/codex', args: [], model: 'default' });
  assert.equal(saved.settings.projects[0].path, '/projects/example');
});
test('a stale save retains edits and offers an explicit reload of the current revision', async () => {
  let gets = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return json({ error: 'Settings changed on another device. Reload before saving.' }, 409);
    gets++; return json({ revision: gets, settings: defaults(), imported: false });
  }));
  render(<LocalSettingsPanel />); await screen.findByLabelText('claude executable');
  fireEvent.change(screen.getByLabelText('claude executable'), { target: { value: '/opt/bin/ccs' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByRole('alert'); assert.equal((screen.getByLabelText('claude executable') as HTMLInputElement).value, '/opt/bin/ccs');
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await waitFor(() => assert.equal((screen.getByLabelText('claude executable') as HTMLInputElement).value, 'ccs'));
});
test('unpaired setup requests a pairing code and resumes saved setup after pairing', async () => {
  let paired = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/pair')) { paired = true; return json({ paired }); }
    return paired ? json({ revision: 0, settings: defaults(), imported: false }) : json({ error: 'Pair this device' }, 401);
  }));
  render(<LocalSettingsPanel />);
  fireEvent.change(await screen.findByLabelText('Pairing code'), { target: { value: 'private-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
  await screen.findByRole('heading', { name: '1. Projects' });
  assert.equal(screen.queryByLabelText('Pairing code'), null);
});
