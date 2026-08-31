import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export async function capturePreview({ sourceUrl, targetPort, width = 390, height = 844, executablePath = process.env.CMUX_COMPANION_CHROME_BIN || null } = {}) {
  const url = validatePreviewUrl(sourceUrl, targetPort);
  const viewport = {
    width: clampDimension(width, 320, 600, 390),
    height: clampDimension(height, 480, 1_200, 844),
  };
  const chrome = executablePath || CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome || !existsSync(chrome)) throw new TypeError("Chrome is required to capture a local app preview");
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 cmux-companion-preview",
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (["data:", "blob:", "about:"].includes(requestUrl.protocol) || (LOOPBACK_HOSTS.has(requestUrl.hostname) && Number(requestUrl.port || defaultPort(requestUrl.protocol)) === Number(targetPort))) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (!response || response.status() >= 500) throw new TypeError("The local app did not render successfully");
    await page.waitForTimeout(750);
    const buffer = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
    return { buffer, viewport, sourceUrl: url.href };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Could not capture that local app. Confirm it is still running.");
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function validatePreviewUrl(value, targetPort) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Invalid local preview URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || Number(url.port || defaultPort(url.protocol)) !== Number(targetPort)) {
    throw new TypeError("Preview capture is restricted to its registered localhost port");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

function defaultPort(protocol) { return protocol === "https:" ? 443 : 80; }
function clampDimension(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}
