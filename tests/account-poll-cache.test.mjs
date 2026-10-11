import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPollCache, retryAfterAt } from '../server/account-poll-cache.mjs';

const instant = Date.parse('2026-10-11T21:00:00Z');

test('shares pending reads and enforces the minute even across identity changes and slow requests', async () => {
  let now = instant, calls = 0, finish;
  const cache = new AccountPollCache({ now: () => now });
  const load = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = cache.read('claude:usage:a', load);
  await Promise.resolve();
  now += 90_000;
  const concurrent = cache.read('claude:usage:a', load, { identity: 'rotated' });
  const value = { success: true, lastUpdated: instant };
  finish(value);
  assert.equal(await first, value); assert.equal(await concurrent, value);
  assert.equal(await cache.read('claude:usage:a', load, { identity: 'rotated' }), value);
  assert.equal(calls, 1);
  now += 59_999;
  assert.equal(await cache.read('claude:usage:a', load), value);
  now++;
  await cache.read('claude:usage:a', () => { calls++; return { success: true }; });
  assert.equal(calls, 2);
});

test('backs off independently by account until success, and honors longer provider delays', async () => {
  let now = instant, calls = 0;
  const cache = new AccountPollCache({ now: () => now });
  for (const minutes of [2, 4, 8, 16, 30, 30]) {
    const value = await cache.read('claude:usage:a', () => { calls++; return { success: false, failureReason: 'rate-limited', retryAfterAt: now + 1000 }; });
    const deadline = now + minutes * 60_000;
    assert.equal(value.retryAt, new Date(deadline).toISOString());
    now = deadline - 1;
    assert.equal(await cache.read('claude:usage:a', () => assert.fail('Cooldown bypassed'), { identity: 'changed' }), value);
    assert.equal((await cache.read('claude:usage:b', () => ({ success: true }))).success, true);
    now++;
  }
  assert.equal(calls, 6);
  const success = { success: true, lastUpdated: now };
  assert.equal(await cache.read('claude:usage:a', () => success), success);
  now += 60_000;
  const afterSuccess = await cache.read('claude:usage:a', () => ({ success: false, failureReason: 'rate-limited' }));
  assert.equal(Date.parse(afterSuccess.retryAt) - now, 2 * 60_000);
  now += 2 * 60_000;
  const long = await cache.read('claude:usage:a', () => ({ success: false, failureReason: 'rate-limited', retryAfterAt: now + 3_600_000 }));
  assert.equal(Date.parse(long.retryAt) - now, 3_600_000);
});

test('ordinary failures also consume the minute and cannot leak exceptions', async () => {
  let now = instant, calls = 0;
  const cache = new AccountPollCache({ now: () => now });
  const load = () => { calls++; throw new Error('private-token-detail'); };
  const value = await cache.read('codex:usage:a', load);
  assert.deepEqual(value, { success: false, windows: [] });
  now += 59_999;
  assert.equal(await cache.read('codex:usage:a', load), value);
  assert.equal(calls, 1);
  now++;
  await cache.read('codex:usage:a', load);
  assert.equal(calls, 2);
});

test('successful profile caching is longer but credential changes still respect the minute', async () => {
  let now = instant, calls = 0;
  const cache = new AccountPollCache({ now: () => now });
  const load = () => ({ success: true, plan: ++calls === 1 ? 'team' : 'max' });
  const options = { identity: 'first', cacheMs: 15 * 60_000 };
  await cache.read('claude:profile:a', load, options);
  now += 60_000;
  await cache.read('claude:profile:a', load, options);
  assert.equal(calls, 1);
  assert.equal((await cache.read('claude:profile:a', load, { ...options, identity: 'second' })).plan, 'max');
  assert.equal(calls, 2);
});

test('parses Retry-After delta seconds and dates without accepting invalid or past deadlines', () => {
  assert.equal(retryAfterAt('120', instant), instant + 120_000);
  assert.equal(retryAfterAt(' 90.5 ', instant), instant + 90_500);
  assert.equal(retryAfterAt('Sun, 11 Oct 2026 22:00:00 GMT', instant), instant + 3_600_000);
  for (const value of [null, undefined, '', 'invalid', '-3', '0', 'Infinity', '1e99', '999999999999999999999999', 'Sun, 11 Oct 2026 20:00:00 GMT']) {
    assert.equal(retryAfterAt(value, instant), null, String(value));
  }
});
