import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampServiceWorker } from "../scripts/stamp-service-worker.mjs";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
function worker(build = "fixture", shared = new Map()) {
  const handlers = {};
  let network = async () => new Response("current");
  let rejectWrites = false;
  const caches = {
    keys: async () => [...shared.keys()],
    delete: async key => shared.delete(key),
    open: async key => {
      if (!shared.has(key)) shared.set(key, new Map());
      const cache = shared.get(key);
      const keyOf = value => typeof value === "string" ? value : value.url;
      return {
        addAll: async urls => { for (const url of urls) cache.set(url, new Response("shell")); },
        put: async (key, response) => { if (rejectWrites) throw new Error("quota"); cache.set(keyOf(key), response); },
        match: async key => cache.get(keyOf(key))?.clone(),
      };
    },
  };
  vm.runInNewContext(source.replace('"__CMUX_BUILD_ID__"', JSON.stringify(build)), {
    self: { location: { origin: "https://fixture.test" }, addEventListener: (name, handler) => { handlers[name] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches, URL, Response, fetch: request => network(request),
  });
  return { shared, network: fn => { network = fn; }, rejectWrites: () => { rejectWrites = true; }, async dispatch(name, request) {
    const waits = []; let response;
    handlers[name]({ request, waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; } });
    const result = await response;
    await Promise.all(waits);
    return { response: result, waits: waits.length };
  } };
}
const navigation = { method: "GET", mode: "navigate", url: "https://fixture.test/?workspace=one" };

test("HTTP errors cannot poison the offline shell and cache writes belong to the event", async () => {
  const w = worker();
  await w.dispatch("install");
  const good = await w.dispatch("fetch", navigation);
  assert.equal(good.waits, 1);
  w.network(async () => new Response("broken", { status: 503 }));
  assert.equal((await w.dispatch("fetch", navigation)).response.status, 503);
  w.network(async () => { throw new Error("offline"); });
  assert.equal(await (await w.dispatch("fetch", navigation)).response.text(), "current");
});

test("updates isolate caches, survive worker restart, and preserve unrelated caches", async () => {
  const shared = new Map([["unrelated-app", new Map()]]);
  const old = worker("old", shared);
  await old.dispatch("install");
  await old.dispatch("fetch", navigation);
  const next = worker("new", shared);
  await next.dispatch("install");
  await next.dispatch("activate");
  assert.deepEqual([...shared.keys()].sort(), ["cmux-companion-new", "unrelated-app"]);
  const restarted = worker("new", shared);
  restarted.network(async () => { throw new Error("offline"); });
  assert.equal(await (await restarted.dispatch("fetch", navigation)).response.text(), "shell");
});

test("cache failure does not hide a valid response, APIs and development bypass caching", async () => {
  const w = worker();
  w.rejectWrites();
  assert.equal(await (await w.dispatch("fetch", navigation)).response.text(), "current");
  assert.equal((await w.dispatch("fetch", { ...navigation, url: "https://fixture.test/api/bootstrap" })).response, undefined);
  const dev = worker("__CMUX_BUILD_ID__");
  assert.equal((await dev.dispatch("fetch", navigation)).response, undefined);
});

test("build stamping is reproducible and changes when client content changes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "companion-sw-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "entry.js"), "version one");
  const first = await stampServiceWorker(directory);
  assert.match(await readFile(join(directory, "sw.js"), "utf8"), /const BUILD_ASSETS = \["\/entry.js"\]/);
  assert.equal(await stampServiceWorker(directory), first);
  await writeFile(join(directory, "entry.js"), "version two");
  assert.notEqual(await stampServiceWorker(directory), first);
  assert.doesNotMatch(await readFile(join(directory, "sw.js"), "utf8"), /const BUILD_ID = "__CMUX_BUILD_ID__"/);
});
