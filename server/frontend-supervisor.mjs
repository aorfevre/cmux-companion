import { setTimeout as delay } from "node:timers/promises";

function bounded(work, ms, message) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Owns one frontend and one bridge, from readiness through final shutdown.
// It never exits the host process, which makes lifecycle failures testable.
export async function superviseFrontend({ frontend, url, startBridge, startupTimeoutMs = 20_000, requestTimeoutMs = 1_000, shutdownTimeoutMs = 5_000 }) {
  const startup = new AbortController();
  let startupFailure = null;
  let started = false;
  let exited = false;
  let bridge;
  let stopping;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });

  async function stop(signal = "SIGTERM", code = 0, error = null) {
    if (stopping) return stopping;
    stopping = (async () => {
      startup.abort();
      if (!exited) frontend.kill(signal);
      const outcomes = await Promise.allSettled([
        bridge ? bounded(Promise.resolve().then(() => bridge.app.close()), shutdownTimeoutMs, "Bridge did not stop in time") : Promise.resolve(),
        bounded(exit, shutdownTimeoutMs, "Frontend did not stop in time").catch(async () => {
          if (!exited) frontend.kill("SIGKILL");
          await bounded(exit, shutdownTimeoutMs, "Frontend did not exit after SIGKILL");
        }),
      ]);
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      const result = { code: failure ? 1 : code, error: failure?.reason || error };
      resolveClosed(result);
      return result;
    })();
    return stopping;
  }

  function failed(error) {
    startupFailure ??= error;
    startup.abort();
    if (started && !stopping) void stop("SIGTERM", 1, error);
  }
  frontend.once("error", error => failed(error));
  frontend.once("exit", (code, signal) => {
    exited = true;
    resolveExit();
    if (!stopping) failed(new Error(`Frontend exited unexpectedly (code=${code}, signal=${signal})`));
  });
  // Failed spawn emits close without exit.
  frontend.once("close", () => { exited = true; resolveExit(); });
  const timer = setTimeout(() => {
    startupFailure = new Error("Frontend did not become ready before the startup deadline");
    startup.abort();
  }, startupTimeoutMs);

  try {
    while (!startup.signal.aborted) {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([startup.signal, AbortSignal.timeout(requestTimeoutMs)]) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch {
        // Failed/slow attempts remain bounded by the overall startup deadline.
      }
      if (!startup.signal.aborted) await delay(100, undefined, { signal: startup.signal }).catch(() => {});
    }
    if (startup.signal.aborted) throw startupFailure || new Error("Frontend startup cancelled");
    clearTimeout(timer);
    bridge = await startBridge({ frontendUpstream: url });
    if (startupFailure) throw startupFailure;
    started = true;
    return { bridge, stop, closed };
  } catch (error) {
    clearTimeout(timer);
    await stop("SIGTERM", 1, error);
    throw error;
  }
}
