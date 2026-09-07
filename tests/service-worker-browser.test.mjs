import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
test("a real browser installs, updates and reopens the private shell offline", { skip: !existsSync(chrome) }, async t => {
  let version = "one";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(source.replace('"__CMUX_BUILD_ID__"', JSON.stringify(version)).replace("const BUILD_ASSETS = [];", 'const BUILD_ASSETS = ["/entry.js"];'));
    } else if (request.url === "/entry.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(`document.querySelector('h1').textContent = 'Shell ${version}';`);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><h1>Loading shell…</h1><script src="/entry.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  });
  await context.setOffline(true);
  await page.goto(`${url}/?offline=one`);
  assert.equal(await page.locator("h1").textContent(), "Shell one");
  await context.setOffline(false);
  version = "two";
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const changed = new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    await registration.update();
    await changed;
  });
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(`${url}/?offline=two`);
  assert.equal(await reopened.locator("h1").textContent(), "Shell two");
});
