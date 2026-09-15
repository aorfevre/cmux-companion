import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureToken,
  isAuthorized,
  isSessionAuthorized,
  isSafeOrigin,
  parseCookies,
  sessionCookie,
  sessionValue,
} from "../server/security.mjs";

test("creates and reuses a private pairing token", () => {
  const root = mkdtempSync(join(tmpdir(), "cmux-companion-test-"));
  const path = join(root, "config", "token");
  const first = ensureToken(path);
  const second = ensureToken(path);
  assert.equal(first, second);
  assert.equal(readFileSync(path, "utf8").trim(), first);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("authorizes only the pairing bearer or signed session cookie", () => {
  const token = "a-secure-pairing-token-that-is-long-enough";
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(isAuthorized({ headers: { cookie: `cmux_session=${sessionValue(token)}` } }, token), true);
  assert.equal(isSessionAuthorized({ headers: { cookie: `cmux_session=${sessionValue(token)}` } }, token), true);
  assert.equal(isSessionAuthorized({ headers: { authorization: `Bearer ${token}` } }, token), false);
  assert.equal(isAuthorized({ headers: { authorization: "Bearer wrong" } }, token), false);
  assert.equal(isAuthorized({ headers: { "tailscale-user-login": "owner@example.com" } }, token), false);
});

test("issues a secure one-year session cookie", () => {
  const cookie = sessionCookie({ headers: { host: "mac.tail.test", "x-forwarded-proto": "https" }, raw: { socket: { remoteAddress: "127.0.0.1" } }, protocol: "http" }, "a-secure-pairing-token-that-is-long-enough");
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});

test("malformed cookies do not break valid session or bearer authentication", () => {
  const token = "a-secure-pairing-token-that-is-long-enough";
  for (const malformed of ["broken=%", "%E0%A4%A=value", "cmux_session=%E0%A4%A"]) {
    assert.deepEqual(parseCookies(`${malformed}; valid=hello%20world`), { valid: "hello world" });
    assert.equal(isSessionAuthorized({ headers: { cookie: malformed } }, token), false);
    assert.equal(isAuthorized({ headers: { cookie: malformed, authorization: `Bearer ${token}` } }, token), true);
    assert.equal(isSessionAuthorized({ headers: { cookie: `${malformed}; cmux_session=${sessionValue(token)}` } }, token), true);
  }
});

test("parses cookies and validates same-origin mutations", () => {
  assert.deepEqual(parseCookies("one=1; encoded=hello%20world"), { one: "1", encoded: "hello world" });
  assert.equal(isSafeOrigin({ headers: { origin: "https://mac.tail.test", host: "mac.tail.test" }, protocol: "https" }), true);
  assert.equal(isSafeOrigin({ headers: { origin: "https://evil.test", host: "mac.tail.test" } }), false);
  assert.equal(isSafeOrigin({ headers: {} }), true);
});


test('origin comparison checks scheme, port and only trusts loopback forwarded headers', () => {
  const request = { headers: { host: 'bridge.local:3210', 'x-forwarded-host': 'mac.tail.test:8443', 'x-forwarded-proto': 'https', origin: 'https://mac.tail.test:8443' }, raw: { socket: { remoteAddress: '127.0.0.1' } } };
  assert.equal(isSafeOrigin(request), true);
  assert.match(sessionCookie(request, 'fixture'), /; Secure$/);
  for (const origin of ['http://mac.tail.test:8443', 'https://mac.tail.test:9443', 'https://evil.test', 'null', '', 'https://mac.tail.test:8443/path']) {
    assert.equal(isSafeOrigin({ ...request, headers: { ...request.headers, origin } }), false, origin);
  }
  const remote = { ...request, raw: { socket: { remoteAddress: '192.0.2.1' } } };
  assert.equal(isSafeOrigin(remote), false);
  assert.doesNotMatch(sessionCookie(remote, 'fixture'), /; Secure$/);
  assert.equal(isSafeOrigin({ ...remote, headers: { ...remote.headers, origin: 'http://bridge.local:3210' } }), true);
  for (const host of ['mac.tail.test@evil.test', 'mac.tail.test/path', 'mac.tail.test,evil.test']) {
    assert.equal(isSafeOrigin({ headers: { host, origin: 'http://evil.test' } }), false);
  }
  assert.equal(isSafeOrigin({ headers: { host: 'mac.tail.test:443', origin: 'https://mac.tail.test' }, protocol: 'https' }), true);
});
