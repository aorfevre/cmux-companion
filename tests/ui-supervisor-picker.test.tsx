import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SupervisorPicker } from '../app/orchestration/supervisor-picker';
import { request } from '../app/api-request';
vi.mock('../app/api-request', () => ({ request: vi.fn() }));
const api = vi.mocked(request);
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const choices = { recommendedId: 'claude', capturedAt: 'now', profiles: ['claude', 'codex'].map(id => ({ id, label: id, model: 'fixture', ready: true, reason: 'CCS ready', capacity: { reason: 'Capacity unknown' } })) };
function Picker() {
  const [selected, onSelect] = useState(''), [ready, onReady] = useState(false);
  return <><SupervisorPicker {...{ selected, onSelect, onReady }} disabled={false} /><button disabled={!ready}>Start</button></>;
}
test('selects the recommendation, preserves explicit choice and refreshes readiness', async () => {
  api.mockResolvedValue(choices);
  render(<Picker />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Supervisor') as HTMLSelectElement).value).toBe('claude');
  fireEvent.change(screen.getByLabelText('Supervisor'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check supervisor readiness' }));
  await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/orchestration/supervisors?refresh=1'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Supervisor') as HTMLSelectElement).value).toBe('codex');
});
test('blocks unavailable choices and recovers from a readiness error', async () => {
  api.mockRejectedValueOnce(new Error('Launcher probe failed')).mockResolvedValueOnce({ ...choices, profiles: choices.profiles.map(profile => ({ ...profile, ready: false })) }).mockResolvedValueOnce(choices);
  render(<Picker />);
  expect((await screen.findByRole('alert')).textContent).toContain('Launcher probe failed');
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check supervisor readiness' }));
  await screen.findByText('Unavailable supervisors');
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check supervisor readiness' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false));
});
