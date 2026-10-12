import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeResetInventory, codexResetInventory, normalizeResetInventory } from '../server/reset-inventory.mjs';
const now = Date.parse('2026-10-12T12:00:00Z');
const future = '2026-10-22T16:00:00.000Z';
const past = '2026-10-01T00:00:00.000Z';
const grant = { id: 'private-redemption-handle', label: 'private-label', resets_left: 1, resets_total: 1, paused: false, starts_at: past, ends_at: future, usable_now: false };
const claude = grants => claudeResetInventory({ cedar_ember: { eligible: true, grants } }, now);

test('Claude inventory counts saved grants even when not usable now; omits spent, future, paused and expired grants', () => {
  const result = claude([grant, { ...grant, resets_left: 2, resets_total: 2, ends_at: null },
    { ...grant, paused: true }, { ...grant, starts_at: future }, { ...grant, ends_at: past }, { ...grant, ends_at: new Date(now).toISOString() }, { ...grant, resets_left: 0 }]);
  assert.equal(result.availableCount, 3);
  assert.deepEqual(result.grants, [{ count: 1, expiresAt: future, usableNow: false }, { count: 2, expiresAt: null, usableNow: false }]);
  assert.doesNotMatch(JSON.stringify(result), /private-|id|label|token/);
  assert.equal(claude([]).availableCount, 0);
  assert.equal(claude([{ ...grant, starts_at: undefined, ends_at: undefined, usable_now: undefined }]).grants[0].expiresAt, null);
});

test('missing, gated and malformed reset inventory never invents zero or an unbounded expiry', () => {
  for (const block of [null, {}, { eligible: false, grants: [] }, { eligible: true, grants: null }, { eligible: true, grants: Array(201).fill(grant) }]) {
    assert.equal(claudeResetInventory({ cedar_ember: block }, now), null);
  }
  for (const bad of [null, { resets_left: true }, { resets_left: -1 }, { resets_left: '1' }, { resets_left: 1.5 }, { resets_left: 10_001 }, { resets_total: 0 }, { resets_total: '1' }, { paused: 'false' }, { starts_at: false }, { ends_at: 'tomorrow' }, { ends_at: true }]) {
    assert.equal(claude([bad === null ? null : { ...grant, ...bad }]), null);
  }
  assert.equal(claudeResetInventory(null, now), null);
  assert.equal(claude([{ ...grant, resets_left: 6000, resets_total: 6000 }, { ...grant, resets_left: 6000, resets_total: 6000 }]), null);
});

test('Codex preserves authoritative counts with partial or failed details and strips redemption metadata', () => {
  const credit = { id: 'private-handle', reset_type: 'codex_rate_limits', status: 'available', expires_at: future, description: 'private-description' };
  const result = codexResetInventory({ available_count: 2 }, { available_count: 2, credits: [credit, { ...credit, status: 'redeemed' }] }, now);
  assert.equal(result.availableCount, 2);
  assert.deepEqual(result.grants, [{ count: 1, expiresAt: future, usableNow: null }]);
  assert.doesNotMatch(JSON.stringify(result), /private-|reset_type|description/);
  for (const details of [null, { available_count: 1, credits: [credit] }, { available_count: 2, credits: [{ ...credit, expires_at: 'invalid' }] }, { available_count: 2, credits: Array(201).fill(credit) }, { available_count: 2, credits: [credit, credit, credit] }]) {
    assert.equal(codexResetInventory({ available_count: 2 }, details, now).grants, null);
  }
  assert.equal(codexResetInventory({ available_count: 1 }, { available_count: 1, credits: [{ ...credit, expires_at: null }] }, now).grants[0].expiresAt, null);
  assert.deepEqual(codexResetInventory({ available_count: 0 }, null, now).grants, []);
  for (const value of [null, {}, { available_count: true }, { available_count: -1 }]) assert.equal(codexResetInventory(value, null, now), null);
});

test('normalized inventory is an allowlist and rejects invalid counts, expiry or observation timestamps', () => {
  const value = { availableCount: 1, grants: [{ count: 1, expiresAt: future, usableNow: true, id: 'private-id' }], updatedAt: new Date(now).toISOString(), token: 'private-token' };
  assert.doesNotMatch(JSON.stringify(normalizeResetInventory(value)), /private-/);
  for (const bad of [{ availableCount: null }, { updatedAt: true }, { updatedAt: 'invalid' }, { grants: [{ count: 2, expiresAt: future }] }, { grants: [{ count: -1 }] }, { grants: [{ count: 1, expiresAt: false }] }]) assert.equal(normalizeResetInventory({ ...value, ...bad }), null);
});
