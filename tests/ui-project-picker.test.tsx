import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectPicker } from '../app/orchestration/project-picker';
import { ApiError, request } from '../app/api-request';
vi.mock('../app/api-request', async original => ({ ...await original<typeof import('../app/api-request')>(), request: vi.fn() }));
const api = vi.mocked(request), select = vi.fn();
const repositories = [{ id: 'b', name: 'Beta', devRepoName: 'rekord', github: 'owner/beta' }, { id: 'a', name: 'Alpha', devRepoName: 'karven' }, { id: 'c', name: 'Alpha', devRepoName: 'rekord' }, { id: 'd' }];
let ids: string[], revision: number;
beforeEach(() => { ids = ['b']; revision = 1; select.mockReset(); api.mockReset().mockImplementation(async (_url, init) => { if (init) { const body = JSON.parse(String(init.body)); ids = body.favorite ? [...ids, 'a'] : ids.filter(id => id !== 'b'); revision++; } return { revision, ids }; }); });
afterEach(cleanup);
async function open(selected = '', disabled = false) {
  render(<ProjectPicker repositories={repositories} selected={selected} onSelect={select} disabled={disabled} />);
  fireEvent.click(screen.getByRole('button', { name: /^Project / }));
  await waitFor(() => expect(screen.queryByText('Loading favorites…')).toBeNull());
}
test('favorites first, explicit reveal, scoped search and selection independent from stars', async () => {
  await open();
  expect(screen.getByRole('button', { name: 'Beta rekord' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Alpha karven' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'Alpha' } });
  expect(screen.getByText('No matching favorites.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show all projects (3)' }));
  expect(screen.getAllByRole('button', { name: /^Alpha / })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Add to favorites: Alpha (karven)' }));
  await screen.findByText('Saved on this Mac.'); expect(select).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledWith('/api/settings/projects/a/favorite', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 1, favorite: true }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide other projects' }));
  expect(screen.queryByRole('button', { name: 'Alpha rekord' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Alpha karven' }));
  expect(select).toHaveBeenCalledWith('a'); expect(screen.queryByLabelText('Search projects')).toBeNull();
});
test('empty favorites do not select hidden projects; reopening resets disclosure and Escape restores focus', async () => {
  ids = []; await open('a');
  expect(screen.getByText(/No favorite projects yet/)).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Show all projects/ }));
  fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'missing' } });
  expect(screen.getByText('No other matching projects.')).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText('Search projects'), { key: 'Escape' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Project Alpha karven' }));
  fireEvent.click(document.activeElement!);
  expect(screen.queryByRole('button', { name: 'Alpha rekord' })).toBeNull();
  expect(screen.getByLabelText('Search projects')).toHaveProperty('value', '');
  fireEvent.click(screen.getByRole('button', { name: 'Project Alpha karven' }));
  expect(screen.queryByLabelText('Search projects')).toBeNull();
});
test('failed star preserves confirmed state and stale revision refresh permits deliberate retry', async () => {
  await open();
  api.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' }));
  await screen.findByText(/Favorite could not be saved/);
  expect(screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' }).getAttribute('aria-pressed')).toBe('true');
  api.mockRejectedValueOnce(new ApiError('stale', 409, null));
  fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' }));
  await screen.findByText(/Settings changed/);
  fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' }));
  await screen.findByText('Saved on this Mac.'); expect(screen.queryByRole('button', { name: 'Beta rekord' })).toBeNull();
});
test('load and conflict-refresh failures remain recoverable without losing selection', async () => {
  api.mockRejectedValueOnce(new Error('offline')); await open('b');
  await screen.findByText(/Favorites could not be loaded/);
  fireEvent.click(screen.getByRole('button', { name: /Show all projects/ }));
  expect(screen.getByRole('button', { name: 'Add to favorites: Beta (rekord)' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Beta rekord' })); expect(select).toHaveBeenCalledWith('b');
  fireEvent.click(screen.getByRole('button', { name: 'Project Beta rekord' }));
  await screen.findByRole('button', { name: 'Remove from favorites: Beta (rekord)' });
  api.mockRejectedValueOnce(new ApiError('stale', 409, null)).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' }));
  await screen.findByText(/Favorites could not be refreshed/);
});
test('read-only disables the trigger', () => {
  render(<ProjectPicker repositories={repositories} selected="" onSelect={select} disabled />);
  expect(screen.getByRole('button', { name: 'Project Choose a project' })).toHaveProperty('disabled', true);
});

test('a pending save blocks duplicate stars until the confirmed result arrives', async () => {
  await open();
  let finish!: (value: { revision: number; ids: string[] }) => void;
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const star = screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' });
  fireEvent.click(star); fireEvent.click(star);
  expect(screen.getByText('Saving…')).toBeTruthy(); expect(star).toHaveProperty('disabled', true);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  finish({ revision: 2, ids: [] });
  await screen.findByText('Saved on this Mac.');
  expect(screen.queryByRole('button', { name: 'Beta rekord' })).toBeNull();
});

test('reopening during a save cannot let an older read undo the confirmed star', async () => {
  await open();
  let finishSave!: (value: { revision: number; ids: string[] }) => void;
  let finishRead!: (value: { revision: number; ids: string[] }) => void;
  api.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove from favorites: Beta (rekord)' }));
  fireEvent.keyDown(screen.getByLabelText('Search projects'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Project Choose a project' }));
  await act(async () => { finishSave({ revision: 2, ids: [] }); });
  await screen.findByText('Saved on this Mac.');
  await act(async () => { finishRead({ revision: 1, ids: ['b'] }); });
  expect(screen.queryByRole('button', { name: 'Beta rekord' })).toBeNull();
});
