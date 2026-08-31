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
  const cookie = sessionCookie({ headers: { "x-forwarded-proto": "https" }, protocol: "http" }, "a-secure-pairing-token-that-is-long-enough");
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});

test("parses cookies and validates same-origin mutations", () => {
  assert.deepEqual(parseCookies("one=1; encoded=hello%20world"), { one: "1", encoded: "hello world" });
  assert.equal(isSafeOrigin({ headers: { origin: "https://mac.tail.test", host: "mac.tail.test" } }), true);
  assert.equal(isSafeOrigin({ headers: { origin: "https://evil.test", host: "mac.tail.test" } }), false);
  assert.equal(isSafeOrigin({ headers: {} }), true);
});
