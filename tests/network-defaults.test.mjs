import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { CONNECT_ATTEMPT_TIMEOUT_MS, ensureConnectAttemptTimeout } from '../server/network-defaults.mjs';

test('raises the Node per-address connect attempt timeout above slow provider handshakes', t => {
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));
  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  ensureConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), CONNECT_ATTEMPT_TIMEOUT_MS);
  assert.ok(CONNECT_ATTEMPT_TIMEOUT_MS >= 1000);
});

test('keeps a larger operator-provided connect attempt timeout', t => {
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS + 3000);
  ensureConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), CONNECT_ATTEMPT_TIMEOUT_MS + 3000);
});
