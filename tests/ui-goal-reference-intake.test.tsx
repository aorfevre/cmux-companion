import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GoalBoard } from '../app/orchestration/goal-board';
import { ApiError, request } from '../app/api-request';
import { IMAGE_EXTENSIONS, REFERENCE_LIMIT_ERROR, UNSUPPORTED_IMAGE_ERROR, UNSUPPORTED_IMAGE_TYPES, filesFromDataTransfer, nameReferenceFile, transferHasFiles, validateReferenceFiles } from '../app/orchestration/reference-files';
vi.mock('../app/api-request', async importOriginal => ({ ...await importOriginal<typeof import('../app/api-request')>(), request: vi.fn() }));
const api = vi.mocked(request);
const config = { readOnly: false, terminal: false, limits: { global: 4, perGoal: 2, planners: 1 }, capabilities: [{ role: 'planner', mode: 'interactive' }], repositories: [{ id: 'repo', baseBranch: 'main', baseSha: 'a'.repeat(40), error: null }] };
let readOnly = false;
let stream: { close: ReturnType<typeof vi.fn>; listeners: Record<string, () => void> };
beforeEach(() => {
  readOnly = false;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.stubGlobal('EventSource', class {
    listeners: Record<string, () => void> = {}; close = vi.fn();
    constructor() { stream = { close: this.close, listeners: this.listeners }; }
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
  });
  api.mockReset().mockImplementation(async (url, options) => {
    if (url.endsWith('/favorites')) return { revision: 0, ids: [] };
    if (url.endsWith('/configuration')) return { ...config, readOnly };
    if (url.endsWith('/snapshot')) return { goals: [], cursor: 0, journalId: 'journal', readOnly };
    if (options?.method === 'POST') return {};
    throw new ApiError(`Unexpected ${url}`, 500, 'UNEXPECTED');
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
async function start() {
  render(<GoalBoard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start a goal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project Choose a project' }));
  fireEvent.click(await screen.findByRole('button', { name: /Show all projects/ }));
  fireEvent.click(screen.getAllByRole('button', { name: /^(repo Individual project|Example karven)$/ })[0]);
  fireEvent.change(screen.getByLabelText('What should we accomplish?'), { target: { value: 'A useful goal' } });
  return document.getElementById('goal-create') as HTMLFormElement;
}
const png = (bytes = 'fake png bytes', name = 'image.png') => new File([bytes], name, { type: 'image/png' });
const clipboard = (file: File) => ({ files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => new File([file], file.name, { type: file.type }) }], types: ['Files'] });
const removeButtons = () => screen.queryAllByRole('button', { name: /^Remove / });

describe('reference-files helpers', () => {
  test('generic clipboard names become pasted-image-N with an extension matching the MIME type', () => {
    const taken = new Set<string>();
    expect(nameReferenceFile(png(), taken)).toBe('pasted-image-1.png');
    taken.add('pasted-image-1.png');
    expect(nameReferenceFile(png(), taken)).toBe('pasted-image-2.png');
    expect(nameReferenceFile(new File(['j'], 'blob', { type: 'image/jpeg' }), new Set())).toBe('pasted-image-1.jpg');
    expect(nameReferenceFile(new File(['w'], '', { type: 'image/webp' }), new Set())).toBe('pasted-image-1.webp');
    expect(nameReferenceFile(new File(['t'], 'image.png', { type: '' }), new Set())).toBe('pasted-image-1.png');
    expect(nameReferenceFile(new File(['t'], 'blob', { type: 'text/plain' }), new Set())).toBe('pasted-image-1');
  });
  test('real filenames are kept when their extension already matches the server type', () => {
    expect(nameReferenceFile(new File(['j'], 'photo.jpeg', { type: 'image/jpeg' }), new Set())).toBe('photo.jpeg');
    expect(nameReferenceFile(new File(['p'], 'Screenshot.PNG', { type: 'image/png' }), new Set())).toBe('Screenshot.PNG');
    expect(nameReferenceFile(new File(['p'], 'capture.heic', { type: 'image/png' }), new Set())).toBe('capture.heic.png');
    expect(nameReferenceFile(new File(['s'], 'design.svg', { type: 'image/svg+xml' }), new Set())).toBe('design.svg');
    expect(nameReferenceFile(new File(['t'], 'notes.txt', { type: 'text/plain' }), new Set())).toBe('notes.txt');
    expect(nameReferenceFile(new File(['t'], '../dir/na\x00me.txt', { type: 'text/plain' }), new Set())).toBe('..dirname.txt');
    expect(nameReferenceFile(new File(['t'], '..', { type: 'text/plain' }), new Set())).toBe('pasted-image-1');
  });
  test('validation rejects the whole batch on limits or unsupported raster images and lets SVG pass', () => {
    expect(validateReferenceFiles([new File([], 'empty.txt')], 0)).toEqual({ files: [], error: REFERENCE_LIMIT_ERROR });
    expect(validateReferenceFiles([new File(['a'.repeat(1024 * 1024 + 1)], 'big.txt')], 0)).toEqual({ files: [], error: REFERENCE_LIMIT_ERROR });
    expect(validateReferenceFiles([new File(['a'], 'ninth.txt')], 8)).toEqual({ files: [], error: REFERENCE_LIMIT_ERROR });
    expect(validateReferenceFiles([png(), new File(['g'], 'anim.gif', { type: 'image/gif' })], 0)).toEqual({ files: [], error: UNSUPPORTED_IMAGE_ERROR });
    const svg = new File(['<svg/>'], 'design.svg', { type: 'image/svg+xml' });
    expect(validateReferenceFiles([svg], 7)).toEqual({ files: [svg], error: null });
    expect(validateReferenceFiles([new File(['<p>'], 'page.html', { type: 'text/html' }), new File(['?'], 'unknown.bin')], 0).error).toBeNull();
    expect(IMAGE_EXTENSIONS['image/jpeg']).toBe('jpg');
    expect(UNSUPPORTED_IMAGE_TYPES).toContain('image/vnd.microsoft.icon');
    expect(UNSUPPORTED_IMAGE_TYPES).not.toContain('image/svg+xml');
  });
  test('filesFromDataTransfer prefers files and falls back to items only when files is empty', () => {
    const fileA = png('same bytes', 'same.png');
    expect(filesFromDataTransfer({ files: [fileA], items: [{ kind: 'file', getAsFile: () => new File(['same bytes'], 'same.png', { type: 'image/png' }) }] })).toEqual([fileA]);
    const fromItem = png('item bytes');
    expect(filesFromDataTransfer({ files: [], items: [{ kind: 'string', getAsFile: () => png() }, { kind: 'file', getAsFile: () => null }, { kind: 'file', getAsFile: () => fromItem }, { kind: 'file' }] })).toEqual([fromItem]);
    expect(filesFromDataTransfer(null)).toEqual([]);
    expect(filesFromDataTransfer(undefined)).toEqual([]);
    expect(filesFromDataTransfer({})).toEqual([]);
  });
  test('transferHasFiles recognises Files types, file lists and file items', () => {
    expect(transferHasFiles(null)).toBe(false);
    expect(transferHasFiles({ types: ['text/plain'] })).toBe(false);
    expect(transferHasFiles({ types: ['Files'] })).toBe(true);
    expect(transferHasFiles({ files: [png()] })).toBe(true);
    expect(transferHasFiles({ items: [{ kind: 'file' }] })).toBe(true);
    expect(transferHasFiles({ items: [{ kind: 'string' }] })).toBe(false);
  });
});

describe('goal form intake', () => {
  test('pasting a PNG adds exactly one generated reference and submits it as base64 alongside picker files', async () => {
    await start();
    fireEvent.change(screen.getByLabelText('Reference files'), { target: { files: [new File(['hi'], 'brief.txt', { type: 'text/plain' })] } });
    await screen.findByRole('button', { name: 'Remove brief.txt' });
    const textarea = screen.getByLabelText('What should we accomplish?');
    expect(fireEvent.paste(textarea, { clipboardData: clipboard(png()) })).toBe(false);
    await screen.findByRole('button', { name: 'Remove pasted-image-1.png' });
    expect(removeButtons()).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Selected references' }).textContent).toContain('pasted-image-1.png');
    fireEvent.paste(textarea, { clipboardData: clipboard(png('second')) });
    await screen.findByRole('button', { name: 'Remove pasted-image-2.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove brief.txt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted-image-2.png' }));
    expect(removeButtons()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/orchestration/commands', expect.objectContaining({ method: 'POST' })));
    const body = JSON.parse(String(api.mock.calls.find(([url]) => url.endsWith('/commands'))![1]!.body));
    expect(body.payload.attachments).toEqual([{ name: 'pasted-image-1.png', data: btoa('fake png bytes') }]);
    expect(body.payload.description).toBe('A useful goal');
  });
  test('pasting plain text is not intercepted and adds no reference', async () => {
    await start();
    const textarea = screen.getByLabelText('What should we accomplish?');
    expect(fireEvent.paste(textarea, { clipboardData: { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], types: ['text/plain'], getData: () => 'plain' } })).toBe(true);
    expect(fireEvent.paste(textarea)).toBe(true);
    expect(removeButtons()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Selected references' })).toBeNull();
  });
  test('dropping files adds each once and the form shows a drop-target state that survives child dragLeave', async () => {
    const form = await start();
    expect(form.className).not.toContain('orch-dropzone-active');
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'], files: [], items: [] } });
    expect(form.className).toContain('orch-dropzone-active');
    const childLeave = createEvent.dragLeave(form);
    Object.defineProperty(childLeave, 'relatedTarget', { value: screen.getByLabelText('Title (optional)') });
    fireEvent(form, childLeave);
    expect(form.className).toContain('orch-dropzone-active');
    fireEvent.dragOver(form, { dataTransfer: { types: ['Files'] } });
    expect(form.className).toContain('orch-dropzone-active');
    const outsideLeave = createEvent.dragLeave(form);
    Object.defineProperty(outsideLeave, 'relatedTarget', { value: null });
    fireEvent(form, outsideLeave);
    expect(form.className).not.toContain('orch-dropzone-active');
    expect(fireEvent.dragEnter(form, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
    expect(fireEvent.dragOver(form, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
    expect(form.className).not.toContain('orch-dropzone-active');
    expect(fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } })).toBe(false);
    const svg = new File(['<svg>reference only</svg>'], 'design.svg', { type: 'image/svg+xml' });
    const note = new File(['note'], 'notes.txt', { type: 'text/plain' });
    expect(fireEvent.drop(form, { dataTransfer: { files: [svg, note], items: [svg, note].map(file => ({ kind: 'file', type: file.type, getAsFile: () => new File([file], file.name, { type: file.type }) })), types: ['Files'] } })).toBe(false);
    expect(form.className).not.toContain('orch-dropzone-active');
    await screen.findByRole('button', { name: 'Remove design.svg' });
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    expect(removeButtons()).toHaveLength(2);
    fireEvent.drop(form, { dataTransfer: { files: [], items: [{ kind: 'file', type: 'image/webp', getAsFile: () => new File(['w'], 'blob', { type: 'image/webp' }) }], types: ['Files'] } });
    await screen.findByRole('button', { name: 'Remove pasted-image-1.webp' });
    expect(removeButtons()).toHaveLength(3);
    fireEvent.drop(form, { dataTransfer: { files: [], items: [], types: [] } });
    expect(removeButtons()).toHaveLength(3);
  });
  test('dropping text onto the brief is not intercepted and adds no reference', async () => {
    const form = await start();
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } });
    expect(form.className).toContain('orch-dropzone-active');
    const textTransfer = { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], types: ['text/plain'], getData: () => 'dragged text' };
    expect(fireEvent.drop(screen.getByLabelText('What should we accomplish?'), { dataTransfer: textTransfer })).toBe(true);
    expect(form.className).not.toContain('orch-dropzone-active');
    expect(removeButtons()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Selected references' })).toBeNull();
  });
  test('GIF paste and oversized drops are rejected with a clear error and nothing from the batch is added', async () => {
    const form = await start();
    fireEvent.paste(screen.getByLabelText('What should we accomplish?'), { clipboardData: clipboard(new File(['gif'], 'anim.gif', { type: 'image/gif' })) });
    await screen.findByText(UNSUPPORTED_IMAGE_ERROR);
    expect(removeButtons()).toHaveLength(0);
    fireEvent.drop(form, { dataTransfer: { files: [png('ok'), new File([], 'empty.txt')], types: ['Files'] } });
    await screen.findByText(REFERENCE_LIMIT_ERROR);
    expect(removeButtons()).toHaveLength(0);
    fireEvent.drop(form, { dataTransfer: { files: [png('recovers')], types: ['Files'] } });
    await screen.findByRole('button', { name: 'Remove pasted-image-1.png' });
    expect(screen.queryByText(REFERENCE_LIMIT_ERROR)).toBeNull();
  });
  test('a picker read failure keeps the existing error handling', async () => {
    await start();
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { this.dispatchEvent(new Event('error')); });
    fireEvent.change(screen.getByLabelText('Reference files'), { target: { files: [new File(['x'], 'broken.txt')] } });
    await screen.findByText('Could not read the selected file.');
    expect(removeButtons()).toHaveLength(0);
  });
  test('read-only mode ignores paste and drop', async () => {
    const form = await start();
    readOnly = true;
    stream.listeners.resync();
    await screen.findByText('Read-only mode · controls are disabled.');
    const textarea = screen.getByLabelText('What should we accomplish?');
    expect(textarea).toHaveProperty('disabled', true);
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } });
    expect(form.className).not.toContain('orch-dropzone-active');
    fireEvent.drop(form, { dataTransfer: { files: [png()], types: ['Files'] } });
    fireEvent.paste(textarea, { clipboardData: clipboard(png('other')) });
    await waitFor(() => expect(screen.queryByText('Reading files…')).toBeNull());
    expect(removeButtons()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Selected references' })).toBeNull();
  });
  test('while the request is pending the form ignores paste and drop', async () => {
    const form = await start();
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (url, options) => { if (url.endsWith('/commands')) throw new Error('Network disconnected'); return original(url, options); });
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
    await screen.findByRole('button', { name: 'Retry pending request' });
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } });
    expect(form.className).not.toContain('orch-dropzone-active');
    fireEvent.drop(form, { dataTransfer: { files: [png()], types: ['Files'] } });
    fireEvent.paste(screen.getByLabelText('What should we accomplish?'), { clipboardData: clipboard(png('other')) });
    await waitFor(() => expect(screen.queryByText('Reading files…')).toBeNull());
    expect(removeButtons()).toHaveLength(0);
  });
});
