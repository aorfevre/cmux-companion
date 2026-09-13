import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FolderPicker, type FolderListing } from '../app/settings/folder-picker';
import { request } from '../app/api-request';
vi.mock('../app/api-request', () => ({ request: vi.fn() }));
const api = vi.mocked(request);
const root: FolderListing = { macName: 'Test Mac', path: '/home', name: 'home', parent: null, roots: [{ name: 'Home', path: '/home' }], breadcrumbs: [{ name: 'Home', path: '/home' }], folders: [{ name: 'karven', path: '/home/karven' }], partial: false, examined: 1 };
beforeEach(() => { api.mockReset().mockResolvedValue(root); HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });
afterEach(cleanup);
it('browses without typing, chooses explicitly and returns focus on cancel', async () => {
  const choose = vi.fn().mockResolvedValue(undefined), cancel = vi.fn();
  const { unmount } = render(<FolderPicker onChoose={choose} onCancel={cancel} />);
  fireEvent.click(await screen.findByRole('button', { name: 'karven' }));
  expect(choose).not.toHaveBeenCalled();
  await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/settings/folders', expect.objectContaining({ body: JSON.stringify({ path: '/home/karven', filter: '' }) })));
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' })); await waitFor(() => expect(choose).toHaveBeenCalledWith({ name: 'home', path: '/home' }, expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(cancel).toHaveBeenCalledOnce(); unmount();
});
it('handles errors and retry, empty and partial folders, navigation and filtering', async () => {
  api.mockRejectedValueOnce(new Error('Cannot open folder'));
  render(<FolderPicker onChoose={vi.fn()} onCancel={vi.fn()} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Cannot open folder');
  expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true);
  api.mockResolvedValue({ ...root, folders: [], partial: true, parent: '/home', roots: [...root.roots, { name: 'External', path: '/external' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText(/No visible subfolders/); expect(screen.getByRole('status').textContent).toContain('partial');
  fireEvent.change(screen.getByLabelText('Filter folder names'), { target: { value: 'none' } }); await screen.findByText(/No matching folders/);
  fireEvent.click(screen.getByRole('button', { name: 'External' })); await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/settings/folders', expect.objectContaining({ body: JSON.stringify({ path: '/external', filter: '' }) })));
  fireEvent.click(screen.getByRole('button', { name: '↑ Up one folder' })); await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/settings/folders', expect.objectContaining({ body: JSON.stringify({ path: '/home', filter: '' }) })));
});
it('ignores late replies, aborts cancelled loads and prevents double selection', async () => {
  let finish!: (value: FolderListing) => void;
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const choose = vi.fn().mockRejectedValue(new Error('Choose another folder'));
  const { unmount } = render(<FolderPicker onChoose={choose} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Home' })); await screen.findByRole('button', { name: 'karven' });
  finish({ ...root, macName: 'Late Mac' }); await waitFor(() => expect(screen.queryByText(/Late Mac/)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' })); fireEvent.click(screen.getByRole('button', { name: 'Checking folder…' }));
  await screen.findByText('Choose another folder'); expect(choose).toHaveBeenCalledOnce();
  const signal = api.mock.calls.at(-1)?.[1]?.signal; unmount(); expect(signal?.aborted).toBe(true);
});

it('allows cancellation while selection is being validated', async () => {
  const choose = vi.fn().mockImplementation(() => new Promise(() => {})), cancel = vi.fn();
  render(<FolderPicker onChoose={choose} onCancel={cancel} />); await screen.findByRole('button', { name: 'karven' });
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).toHaveBeenCalledOnce(); expect(choose.mock.calls[0][1].aborted).toBe(true);
});
