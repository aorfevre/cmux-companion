import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { capturePreview, validatePreviewUrl } from "../server/preview-capture.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("restricts preview capture to the registered localhost origin", () => {
  assert.equal(validatePreviewUrl("http://localhost:3000/path?mode=phone#section", 3000).href, "http://localhost:3000/path?mode=phone");
  assert.equal(validatePreviewUrl("http://127.0.0.1:4100/", 4100).hostname, "127.0.0.1");
  assert.throws(() => validatePreviewUrl("https://example.com/", 443), /restricted to its registered localhost port/);
  assert.throws(() => validatePreviewUrl("http://localhost:3001/", 3000), /restricted to its registered localhost port/);
  assert.throws(() => validatePreviewUrl("file:///etc/passwd", 3000), /restricted to its registered localhost port/);
});

test("captures a real loopback app at a bounded mobile viewport", { skip: !existsSync(CHROME) }, async (t) => {
  const server = createServer((_request, response) => response.end("<!doctype html><title>Private preview</title><h1>Captured locally</h1>"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await capturePreview({ sourceUrl: `http://127.0.0.1:${address.port}/`, targetPort: address.port, width: 200, height: 2_000, executablePath: CHROME });
  assert.deepEqual(result.viewport, { width: 320, height: 1_200 });
  assert.equal(result.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(result.buffer.length > 1_000);
});
