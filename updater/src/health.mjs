function expectedAssetType(path) {
  if (/\.css(?:\?|$)/.test(path)) return "text/css";
  if (/\.js(?:\?|$)/.test(path)) return "javascript";
  return null;
}

export async function checkCompanionHealth(url, sha, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(url, { signal });
  const body = await response.json();
  if (!response.ok || body.ok !== true || body.version?.gitSha !== sha) {
    throw new Error(`health reported ${body.version?.gitSha || "no SHA"}`);
  }

  const rootUrl = new URL("/", url);
  const rootResponse = await fetchImpl(rootUrl, { signal });
  if (!rootResponse.ok) throw new Error(`frontend root returned ${rootResponse.status}`);
  const html = await rootResponse.text();
  const references = [...html.matchAll(/(?:src|href)="([^"]+\.(?:css|js)(?:\?[^"]*)?)"/g)]
    .map((match) => new URL(match[1], rootUrl))
    .filter((assetUrl) => assetUrl.origin === rootUrl.origin);
  const assets = [...new Map(references.map((assetUrl) => [assetUrl.href, assetUrl])).values()];
  if (!assets.length) throw new Error("frontend root did not reference any CSS or JavaScript assets");
  await Promise.all(assets.map(async (assetUrl) => {
    const assetResponse = await fetchImpl(assetUrl, { signal });
    if (!assetResponse.ok) throw new Error(`${assetUrl.pathname} returned ${assetResponse.status}`);
    const expected = expectedAssetType(assetUrl.pathname);
    const actual = assetResponse.headers.get("content-type") || "";
    if (expected && !actual.toLowerCase().includes(expected)) throw new Error(`${assetUrl.pathname} returned ${actual || "no content type"}`);
  }));
  return body;
}

export async function health(url, sha, timeoutSeconds, { fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "health endpoint unavailable";
  while (Date.now() < deadline) {
    try {
      return await checkCompanionHealth(url, sha, { fetchImpl, signal: AbortSignal.timeout(2000) });
    } catch (error) { last = error.message; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Companion ${sha} did not become healthy: ${last}`);
}
