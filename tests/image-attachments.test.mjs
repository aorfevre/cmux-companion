import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImageAttachments } from "../server/image-attachments.mjs";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("stores validated images privately for local agent access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ImageAttachments({ directory: root });
  const image = await store.save(`data:image/png;base64,${ONE_PIXEL_PNG}`, "screen.png");
  assert.equal(image.name, "screen.png");
  assert.equal(image.mime, "image/png");
  assert.equal((await stat(image.path)).mode & 0o777, 0o600);
  assert.equal((await readFile(image.path)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("rejects disguised and oversized image payloads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmux-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ImageAttachments({ directory: root, maxBytes: 16 });
  await assert.rejects(() => store.save("data:image/png;base64,bm90IGFuIGltYWdl", "fake.png"), /PNG, JPEG/);
  await assert.rejects(() => store.save(`data:image/png;base64,${ONE_PIXEL_PNG}`, "large.png"), /smaller/);
});
