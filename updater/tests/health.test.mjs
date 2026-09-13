import assert from "node:assert/strict";
import test from "node:test";
import { checkCompanionHealth } from "../src/engine.mjs";

const SHA = "a".repeat(40);
const HEALTH = "http://127.0.0.1:3210/api/health";

function response(body, { status = 200, type = "text/plain" } = {}) {
  return new Response(body, { status, headers: { "content-type": type } });
}

function frontendFetch({ cssStatus = 200, cssType = "text/css", jsStatus = 200, jsType = "application/javascript" } = {}) {
  return async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/health") return response(JSON.stringify({ ok: true, version: { gitSha: SHA } }), { type: "application/json" });
    if (url.pathname === "/") return response('<link rel="stylesheet" href="/_next/static/app.css"><script src="/_next/static/app.js"></script>', { type: "text/html" });
    if (url.pathname.endsWith("app.css")) return response("body{}", { status: cssStatus, type: cssType });
    if (url.pathname.endsWith("app.js")) return response("export{}", { status: jsStatus, type: jsType });
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("accepts health only when the frontend root and referenced assets load", async () => {
  const result = await checkCompanionHealth(HEALTH, SHA, { fetchImpl: frontendFetch() });
  assert.equal(result.version.gitSha, SHA);
});

test("rejects a healthy process whose frontend asset is missing", async () => {
  await assert.rejects(
    () => checkCompanionHealth(HEALTH, SHA, { fetchImpl: frontendFetch({ cssStatus: 500, cssType: "application/json" }) }),
    /\/_next\/static\/app.css returned 500/,
  );
});

test("rejects a stylesheet served with the generic JSON error MIME type", async () => {
  await assert.rejects(
    () => checkCompanionHealth(HEALTH, SHA, { fetchImpl: frontendFetch({ cssType: "application/json" }) }),
    /\/_next\/static\/app.css returned application\/json/,
  );
});
