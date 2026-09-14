import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';
import { LocalSettingsPanel, type Settings } from '../app/settings/settings-panel';
const defaults = (): Settings => ({ devRepos: [], projects: [], provider: 'claude', providers: { claude: { executable: 'ccs', args: ['claude'], model: 'default' }, codex: { executable: 'ccs', args: ['codex'], model: 'default' } }, tools: { cmux: 'cmux', tailscale: 'tailscale', chrome: 'chrome' }, execution: { global: 4, perGoal: 4, planners: 2, ceilingMs: 1800000, idleMs: 240000, maxOutputBytes: 1048576, killGraceMs: 5000 }, previews: { portStart: 8500, portEnd: 8599 }, onboarding: { completed: true } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function fixture(category = 'agents', settings = defaults()) {
  history.replaceState(null, '', `/settings#${category}`);
  const state = { saved: { revision: 3, settings, imported: false }, fail: false, paired: true, scanError: false, gitFolder: false, validation: { ready: true, reason: '', resolution: { message: '' } }, calls: [] as { url: string; method?: string; body: Record<string, unknown> }[] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    state.calls.push({ url, method: init?.method, body });
    if (url.endsWith('/pair')) { state.paired = true; return json({ paired: true }); }
    if (!state.paired) return json({ error: 'Pair this device' }, 401);
    if (url.endsWith('/reconcile')) return json({ ...structuredClone(state.saved), scans: {} });
    if (url.endsWith('/scan')) {
      if (state.scanError) return json({ error: 'Directory unavailable' }, 400);
      const root = state.saved.settings.devRepos?.find(root => url.includes(root.id));
      const entry = { path: '/projects/karven/example', name: 'Example', github: 'example/repo', remote: 'git@github.com:example/repo.git' };
      if (!state.saved.settings.projects.some(project => project.path === entry.path)) { state.saved.settings.projects.push({ ...entry, id: 'example', devRepoId: root?.id, enabled: true, checks: [] }); state.saved.revision++; }
      return json({ repositories: [entry], partial: true, reason: 'Partial scan', snapshot: structuredClone(state.saved) });
    }
    if (url.endsWith('/folders')) return json({ macName: 'Fixture Mac', path: body.path || '/projects', name: body.path ? 'karven' : 'projects', parent: body.path ? '/projects' : null, roots: [{ name: 'Home', path: '/projects' }], breadcrumbs: [{ name: 'Home', path: '/projects' }], folders: body.path ? [] : [{ name: 'karven', path: '/projects/karven' }], partial: false, examined: 1 });
    if (url.endsWith('dev-repos/inspect')) return state.gitFolder ? json({ error: 'Choose a folder containing repositories, or use Add individual repository for a Git root' }, 400) : json({ path: '/projects/karven' });
    if (url.endsWith('projects/inspect')) return json({ path: String(body.path), name: 'Example', github: 'example/repo', remote: 'git@github.com:example/repo.git', suggestedChecks: [{ id: 'test', executable: 'npm', args: ['run', 'test'], script: 'node --test' }] });
    if (url.endsWith('/validate')) return json(state.validation);
    if (url === '/api/bootstrap') return json({ connected: true, host: { mac_display_name: 'Fixture Mac' } });
    if (url === '/api/updater/updates') return json({ available: false });
    if (init?.method === 'PATCH' || init?.method === 'PUT') {
      if (state.fail) return json({ error: 'Save failed' }, 500);
      assert.equal(body.expectedRevision, state.saved.revision);
      state.saved = { ...state.saved, revision: state.saved.revision + 1, settings: body.settings ?? { ...state.saved.settings, ...body.changes } };
    }
    return json(structuredClone(state.saved));
  }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  return state;
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function saved() { await screen.findByText('Saved on this Mac.'); }

test('agent editor uses direct CLI/profile choices, saves only edited fields and retains unrelated concurrent changes', async () => {
  const state = fixture(); render(<LocalSettingsPanel />); await screen.findByLabelText('Default provider');
  change('codex connection', 'direct'); change('codex executable', '/opt/bin/codex'); change('Default provider', 'codex');
  click('Validate codex'); await screen.findByText('Ready for new goals');
  state.saved.settings.execution.global = 9; state.saved.revision++;
  click('Save changes'); await saved();
  assert.equal(state.saved.settings.execution.global, 9); assert.equal(state.saved.settings.provider, 'codex'); assert.equal(state.saved.settings.providers.codex.args.length, 0);
  change('codex connection', 'ccs'); change('codex profile', 'personal'); click('Discard changes'); assert.equal((screen.getByLabelText('codex connection') as HTMLSelectElement).value, 'direct');
});
test('same-field conflict preserves draft and shows saved values before an explicit retry', async () => {
  const state = fixture(); render(<LocalSettingsPanel />); await screen.findByLabelText('claude executable');
  change('claude executable', '/opt/bin/ccs'); state.saved.settings.providers.claude.executable = '/new/bin/ccs'; state.saved.revision++;
  click('Save changes'); await screen.findByText('Review changes'); assert.equal((screen.getByLabelText('claude executable') as HTMLInputElement).value, '/opt/bin/ccs');
  assert.ok(screen.getByText(/Saved on this Mac/)); click('Keep draft for another review'); click('Save changes'); await saved(); assert.equal(state.saved.settings.providers.claude.executable, '/opt/bin/ccs');
});
test('failed saves preserve draft; conflict can instead accept saved settings', async () => {
  const state = fixture(); render(<LocalSettingsPanel />); await screen.findByLabelText('claude executable');
  change('claude executable', '/opt/bin/ccs'); state.fail = true; click('Save changes'); await screen.findByText('Save failed'); assert.equal((screen.getByLabelText('claude executable') as HTMLInputElement).value, '/opt/bin/ccs');
  state.fail = false; state.saved.settings.providers.claude.executable = '/new/bin/ccs'; state.saved.revision++; click('Save changes'); await screen.findByText('Review changes'); click('Use saved settings'); assert.equal((screen.getByLabelText('claude executable') as HTMLInputElement).value, '/new/bin/ccs');
});
test('pairing resumes setup; navigation guards unsaved fields and completion uses validated server operation', async () => {
  const settings = defaults(); settings.onboarding.completed = false; const state = fixture('agents', settings); state.paired = false;
  render(<LocalSettingsPanel onboarding />); { await screen.findByLabelText('Pairing code'); change('Pairing code', 'private-code'); click('Pair this device'); }
  await screen.findByLabelText('Default provider'); change('Default provider', 'codex'); vi.mocked(window.confirm).mockReturnValueOnce(false);
  click('Advanced'); assert.ok(screen.getByLabelText('Default provider')); click('Save changes'); await saved(); click('Complete setup'); await screen.findByText('Setup complete. You can start a goal.'); assert.equal(state.saved.settings.onboarding.completed, true);
});
test('Dev repo journey validates canonical path, saves a named group, automatically tracks and configures repositories', async () => {
  const state = fixture('dev-repos'); render(<LocalSettingsPanel />); await screen.findByText('Your repositories, organized');
  click('Add Dev repo'); change('Directory on this Mac', '~/Developers/karven'); click('Validate directory'); await screen.findByText('/projects/karven'); click('Save Dev repo and discover');
  await screen.findByText(/Partial scan/); assert.equal(screen.queryByRole('button', { name: 'Add selected repositories' }), null);
  assert.equal(state.saved.settings.projects.length, 1); click(/Example.*Repository ready/); await screen.findByText('node --test'); fireEvent.click(screen.getByRole('checkbox', { name: /npm run test/ })); change('Repository name', 'Renamed'); click('Save changes'); await saved(); assert.equal(state.saved.settings.projects[0].checks.length, 1);
  change('Search repositories', 'not-found'); assert.equal(screen.queryByRole('button', { name: /Renamed.*Repository ready/ }), null); change('Search repositories', 'example');
  change('Rename karven', 'Karven'); click('Save changes'); await saved();
  click('Remove Dev repo'); click('Save changes'); await saved(); assert.equal(state.saved.settings.devRepos?.length, 0); assert.equal(state.saved.settings.projects[0].devRepoId, undefined);
});
test('individual repository editor preserves explicit check argv, disable state and editable destinations', async () => {
  const state = fixture('dev-repos'); render(<LocalSettingsPanel />); await screen.findByText('Your repositories, organized'); click('Add individual repository'); change('Project directory', '/projects/repo'); click('Validate and add project'); await screen.findByLabelText('Repository name');
  change('GitHub destination', 'owner/new'); change('Git remote', 'git@github.com:owner/new.git');
  click('Add verification command'); change('Check name', 'verify'); change('Check executable', 'node'); change('Check arguments (one per line)', '--test\ntests'); fireEvent.click(screen.getByRole('switch', { name: 'Enabled for new work' })); click('Save changes'); await saved();
  assert.deepEqual(state.saved.settings.projects[0].checks[0], { id: 'verify', executable: 'node', args: ['--test', 'tests'] }); assert.equal(state.saved.settings.projects[0].enabled, false);
  click('Remove check'); click('Discard changes');
});
test('advanced preferences convert human units, save all owning fields and support category navigation', async () => {
  const state = fixture('advanced'); render(<LocalSettingsPanel />); await screen.findByLabelText('Background agents');
  change('Background agents', '6'); change('Agents per goal', '2'); change('Concurrent planners', '1'); change('Execution timeout (minutes)', '10'); change('Idle timeout (seconds)', '60'); change('Stop grace period (seconds)', '3'); change('Output limit (KiB)', '512'); change('cmux executable', '/bin/cmux'); change('First preview port', '8600'); change('Last preview port', '8699'); click('Save changes'); await saved();
  assert.equal(state.saved.settings.execution.ceilingMs, 600000); assert.equal(state.saved.settings.execution.maxOutputBytes, 524288);
  click('General'); await screen.findByText('Fixture Mac'); fireEvent.click(screen.getByRole('switch', { name: /Protect terminal input/ })); await screen.findByText('Saved on this device');
  click('Notifications'); await screen.findByText('Background alerts'); click('Updates'); await screen.findByText('Update controls are unavailable. An installed bundled updater is required.');
  click('← All settings'); assert.ok(screen.getByText('Make Companion yours'));
});
test('failed group discovery is actionable and duplicate individual additions do not duplicate settings', async () => {
  const settings = defaults(); settings.devRepos = [{ id: 'karven', name: 'karven', path: '/projects/karven' }]; settings.projects = [{ id: 'one', name: 'One', path: '/projects/one', enabled: true, github: null, remote: null, checks: [] }];
  const state = fixture('dev-repos', settings); state.scanError = true; render(<LocalSettingsPanel />); await screen.findByText('karven'); click('Open / Refresh'); await screen.findByText('Directory unavailable'); click('Add individual repository'); change('Project directory', '/projects/one'); click('Validate and add project'); await screen.findByText('This repository is already added.'); assert.equal(state.saved.settings.projects.length, 1);
});

async function chooseKarven() {
  click('Choose folder'); fireEvent.click(await screen.findByRole('button', { name: 'karven' }));
  await screen.findByText('No visible subfolders. You can use this folder or go back.'); click('Use this folder');
}
test('folder picker prefills a unique name, preserves failed saves and needs no typed paths', async () => {
  const settings = defaults(); settings.devRepos = [{ id: 'existing', name: 'karven', path: '/different' }];
  const state = fixture('dev-repos', settings); render(<LocalSettingsPanel />); await screen.findByText('/different'); click('Add Dev repo'); await chooseKarven();
  assert.equal((await screen.findByLabelText('Dev repo name') as HTMLInputElement).value, 'karven 2');
  state.fail = true; click('Save Dev repo and discover'); await screen.findByText('Save failed'); assert.equal((screen.getByLabelText('Dev repo name') as HTMLInputElement).value, 'karven 2');
  state.fail = false; click('Save Dev repo and discover'); await screen.findByText(/Partial scan/); assert.equal(state.saved.settings.devRepos?.length, 2);
});
test('Git-root selection offers the individual flow without automatically adding execution permission', async () => {
  const state = fixture('dev-repos'); state.gitFolder = true; render(<LocalSettingsPanel />); await screen.findByText('Your repositories, organized'); click('Add Dev repo'); await chooseKarven();
  await screen.findByText(/This is one repository/); assert.equal(state.saved.settings.projects.length, 0); click('Add this individual repository'); click('Validate and add project'); await screen.findByLabelText('Repository name'); assert.equal(state.saved.settings.projects.length, 0);
});
test('cancelling the folder explorer leaves the Dev repo editor unchanged and restores focus', async () => {
  fixture('dev-repos'); render(<LocalSettingsPanel />); await screen.findByText('Your repositories, organized'); click('Add Dev repo');
  const trigger = screen.getByRole('button', { name: 'Choose folder' }); trigger.focus(); click('Choose folder'); fireEvent.click(await screen.findByRole('button', { name: 'karven' })); await screen.findByText('No visible subfolders. You can use this folder or go back.');
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true })); assert.equal(screen.queryByRole('dialog'), null); assert.equal(document.activeElement, trigger); assert.equal(screen.queryByLabelText('Dev repo name'), null);
  click('Choose folder'); await screen.findByText('No visible subfolders. You can use this folder or go back.');
});

test('late automatic discovery preserves an edited draft and offers the saved version for review', async () => {
  const settings = defaults(); settings.devRepos = [{ id: 'karven', name: 'karven', path: '/projects/karven' }];
  const state = fixture('dev-repos', settings), original = globalThis.fetch;
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/reconcile') ? new Promise<Response>(resolve => { finish = resolve; }) : original(url, init)));
  render(<LocalSettingsPanel />); await screen.findByLabelText('Rename karven');
  change('Rename karven', 'My unsaved name');
  const next = structuredClone(state.saved); next.revision++;
  next.settings.projects.push({ id: 'new', name: 'Discovered', path: '/projects/karven/new', enabled: true, devRepoId: 'karven', github: null, remote: null, checks: [] });
  finish(json({ ...next, scans: {} }));
  await screen.findByText('Review changes'); assert.equal((screen.getByLabelText('Rename My unsaved name') as HTMLInputElement).value, 'My unsaved name');
  click('Use saved settings'); await screen.findByRole('button', { name: /Discovered.*Check GitHub remote/ });
});

test('Goals links open the matching repository editor with GitHub details summarized and checks as optional defaults', async () => {
  const settings = defaults(); settings.projects = [{ id: 'example', name: 'Example', path: '/projects/example', enabled: true, github: 'example/repo', remote: 'git@github.com:example/repo.git', checks: [] }];
  fixture('dev-repos', settings); history.replaceState(null, '', '/settings?repository=example#dev-repos');
  render(<LocalSettingsPanel />); await screen.findByRole('heading', { name: 'Verification defaults (optional)' });
  await screen.findByText('node --test');
  assert.equal((screen.getByLabelText('Repository name') as HTMLInputElement).value, 'Example');
  assert.ok(screen.getByText('Used for goals and pull requests. No additional destination is needed.'));
  const details = screen.getByText('Advanced Git settings').closest('details'); assert.equal(details?.open, false);
  assert.equal((screen.getByRole('checkbox', { name: /npm run test/ }) as HTMLInputElement).checked, false);
});

test('terminal command entry stays stable while typing and preserves the selected model', async () => {
  const settings = defaults(); settings.providers.claude.model = 'sonnet';
  const state = fixture('agents', settings); render(<LocalSettingsPanel />); await screen.findByLabelText('claude connection');
  change('claude connection', 'terminal');
  change('claude terminal command', 'ccs');
  assert.equal((screen.getByLabelText('claude connection') as HTMLSelectElement).value, 'terminal');
  change('claude terminal command', 'xclaude');
  click('Save changes'); await saved();
  assert.deepEqual(state.saved.settings.providers.claude, { executable: 'xclaude', args: [], model: 'sonnet' });
});

test('terminal command save failures stay beside Save and preserve both drafts', async () => {
  const state = fixture(); render(<LocalSettingsPanel />); await screen.findByLabelText('claude connection');
  change('claude connection', 'terminal'); change('claude terminal command', 'xclaude');
  change('codex connection', 'terminal'); change('codex terminal command', 'xcodex');
  state.fail = true; click('Save changes');
  const failure = await screen.findByText('Save failed');
  assert.ok(failure.closest('.settings-save'));
  assert.equal((screen.getByLabelText('claude terminal command') as HTMLInputElement).value, 'xclaude');
  assert.equal((screen.getByLabelText('codex terminal command') as HTMLInputElement).value, 'xcodex');
  assert.deepEqual(state.saved.settings.providers, defaults().providers);
});


test('Save validates only changed providers and reports safe alias resolution', async () => {
  const state = fixture(); state.validation.resolution.message = 'Resolved xclaude to ccsxp claude. Permission bypass flags are ignored.';
  render(<LocalSettingsPanel />); await screen.findByLabelText('claude connection');
  change('claude connection', 'terminal'); change('claude terminal command', 'xclaude'); click('Save changes'); await saved();
  assert.ok(screen.getByText(/Permission bypass flags are ignored/));
  const validations = state.calls.filter(call => call.url.endsWith('/validate'));
  assert.equal(validations.length, 1); assert.equal(validations[0].body.provider, 'claude');
});

test('an unsupported terminal alias blocks save with actionable visible failure', async () => {
  const state = fixture(); state.validation = { ready: false, reason: 'Complex shell aliases are unsupported', resolution: { message: 'Managed permission flags are retained.' } };
  render(<LocalSettingsPanel />); await screen.findByLabelText('claude connection');
  change('claude connection', 'terminal'); change('claude terminal command', 'xclaude'); click('Save changes');
  await screen.findByText('Claude: Complex shell aliases are unsupported');
  assert.ok(screen.getByText(/Managed permission flags are retained/));
  assert.equal(state.calls.some(call => call.method === 'PATCH'), false);
  assert.equal((screen.getByLabelText('claude terminal command') as HTMLInputElement).value, 'xclaude');
});
