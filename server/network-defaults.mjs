import net from "node:net";

// Node 22 gives each resolved address only 250 ms before it tries the next one.
// Provider APIs (api.anthropic.com, chatgpt.com) can take ~280 ms to accept a
// TCP connection, and when the IPv6 fallback is unreachable every fetch fails
// with ETIMEDOUT although curl connects fine.
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;

export function ensureConnectAttemptTimeout() {
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_TIMEOUT_MS) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
  }
}
