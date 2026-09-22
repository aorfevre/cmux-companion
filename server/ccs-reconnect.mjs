import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { findCcsPackageRoot } from "./account-usage.mjs";

const ALLOWED_PROVIDERS = new Set(["claude", "codex"]);
const SESSION_TTL_MS = 10 * 60_000;
const TOKEN_GRACE_MS = 15_000;

export class CcsReconnectManager {
  constructor({ accountUsage, sourceLoader = loadCcsReconnectSource, now = Date.now, sessionTtlMs = SESSION_TTL_MS, tokenGraceMs = TOKEN_GRACE_MS } = {}) {
    if (!accountUsage) throw new Error("Account usage is required");
    this.accountUsage = accountUsage;
    this.sourceLoader = sourceLoader;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.tokenGraceMs = tokenGraceMs;
    this.sessions = new Map();
    this.accountOperations = new Set();
  }

  async #withAccountOperation(id, operation) {
    if (this.accountOperations.has(id)) throw Object.assign(new Error("An account change is already in progress"), { statusCode: 409 });
    this.accountOperations.add(id);
    try { return await operation(); } finally { this.accountOperations.delete(id); }
  }

  async removeConnection(id) {
    return this.#withAccountOperation(id, async () => {
      this.#prune();
      if ([...this.sessions.values()].some(session => session.opaqueAccountId === id && (session.pending || ["waiting", "processing"].includes(session.status)))) {
        throw Object.assign(new Error("Close the active reconnect before deleting this connection"), { statusCode: 409 });
      }
      return this.accountUsage.removeConnection(id);
    });
  }

  async start(opaqueAccountId) {
    return this.#withAccountOperation(opaqueAccountId, () => this.#start(opaqueAccountId));
  }

  async #start(opaqueAccountId) {
    this.#prune();
    const target = await this.accountUsage.resolveReconnectTarget(opaqueAccountId);
    if (!target || !ALLOWED_PROVIDERS.has(target.provider)) throw requestError("That account does not need to reconnect", 404);
    const existing = [...this.sessions.values()].find((session) => session.opaqueAccountId === opaqueAccountId && !["success", "error", "expired", "cancelled"].includes(session.status));
    if (existing) return publicSession(existing);

    const source = await this.sourceLoader();
    const started = await source.start(target.provider);
    const authUrl = safeAuthorizationUrl(started?.authUrl);
    const oauthState = cleanState(started?.state) || stateFromUrl(authUrl);
    if (!authUrl || !oauthState || stateFromUrl(authUrl) !== oauthState) throw serviceError("CCS could not start a secure login");
    const session = {
      id: randomUUID(), opaqueAccountId, provider: target.provider, expectedAccountId: target.accountId,
      nickname: target.nickname, authUrl, oauthState, knownTokens: source.listTokens(target.provider),
      createdAt: this.now(), expiresAt: this.now() + this.sessionTtlMs, status: "waiting", message: "Complete the provider login",
      source, pending: null,
    };
    this.sessions.set(session.id, session);
    return publicSession(session);
  }

  async submitCallback(sessionId, callbackUrl) {
    const session = this.#require(sessionId);
    if (!["waiting", "processing"].includes(session.status)) return publicSession(session);
    const validationError = validateCallbackUrl(callbackUrl, session.authUrl);
    if (validationError) throw requestError(validationError, 400);
    if (session.pending) await session.pending;
    if (session.status === "waiting") {
      session.status = "processing";
      session.message = "Finishing reconnect on your Mac…";
      session.pending = this.#completeFromCallback(session, callbackUrl);
    }
    await Promise.race([session.pending, Promise.resolve()]);
    return publicSession(session);
  }

  async status(sessionId) {
    const session = this.#require(sessionId);
    if (session.status === "waiting" && !session.pending) {
      session.pending = this.#pollAutomaticCompletion(session);
    }
    if (session.pending) await Promise.race([session.pending, new Promise((resolve) => setTimeout(resolve, 100))]);
    return publicSession(session);
  }

  cancel(sessionId) {
    const session = this.#require(sessionId);
    if (!["success", "error", "expired"].includes(session.status)) {
      session.status = "cancelled";
      session.message = "Reconnect cancelled";
    }
    return publicSession(session);
  }

  async #pollAutomaticCompletion(session) {
    try {
      const status = await session.source.poll(session.oauthState);
      if (status === "ok") await this.#registerWhenReady(session);
    } catch {
      // A transient CCS status failure should not destroy a usable login session.
    } finally {
      session.pending = null;
    }
  }

  async #completeFromCallback(session, callbackUrl) {
    try {
      await session.source.submitCallback(session.provider, callbackUrl);
      await this.#registerWhenReady(session);
    } catch {
      session.status = "error";
      session.message = "Reconnect could not be completed. Start a new login and try again.";
    } finally {
      session.pending = null;
    }
  }

  async #registerWhenReady(session) {
    const deadline = this.now() + this.tokenGraceMs;
    let token = null;
    while (this.now() <= deadline) {
      token = session.source.findChangedToken(session.provider, session.knownTokens, session.expectedAccountId);
      if (token) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!token) throw new Error("Token was not saved");
    if (!["waiting", "processing"].includes(session.status)) return;
    const account = session.source.register(session.provider, session.nickname, session.expectedAccountId || token.file);
    if (!account) throw new Error("Account was not registered");
    session.status = "success";
    session.message = "Account reconnected";
    this.accountUsage.invalidate();
  }

  #require(sessionId) {
    this.#prune();
    if (typeof sessionId !== "string") throw requestError("Unknown reconnect session", 404);
    const session = this.sessions.get(sessionId);
    if (!session) throw requestError("Unknown or expired reconnect session", 404);
    return session;
  }

  #prune() {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now > session.expiresAt && !["success", "error", "cancelled"].includes(session.status)) {
        session.status = "expired";
        session.message = "Reconnect session expired";
      }
      if (now > session.expiresAt + this.sessionTtlMs) this.sessions.delete(session.id);
    }
  }
}

export function validateCallbackUrl(callbackUrl, authUrl) {
  let callback;
  let authorization;
  try {
    callback = new URL(callbackUrl);
    authorization = new URL(authUrl);
  } catch {
    return "Paste the full localhost callback URL";
  }
  const redirect = authorization.searchParams.get("redirect_uri");
  let expected;
  try { expected = new URL(redirect || ""); } catch { return "The active login has no valid callback"; }
  if (!isLoopback(callback.hostname) || callback.origin !== expected.origin || callback.pathname !== expected.pathname) return "That callback URL does not match this login";
  if (!callback.searchParams.get("code")) return "The callback URL is missing its authorization code";
  const expectedState = authorization.searchParams.get("state");
  if (!expectedState || callback.searchParams.get("state") !== expectedState) return "That callback belongs to a different login";
  return null;
}

async function loadCcsReconnectSource() {
  const root = findCcsPackageRoot();
  const require = createRequire(import.meta.url);
  const proxy = require(`${root}/dist/cliproxy/proxy/proxy-target-resolver.js`);
  const authTypes = require(`${root}/dist/cliproxy/auth/auth-types.js`);
  const tokens = require(`${root}/dist/cliproxy/auth/token-manager.js`);
  const target = proxy.getProxyTarget();
  if (target.isRemote) throw serviceError("Reconnect is available only for CCS running on this Mac");
  const request = async (path, options = {}) => {
    const response = await fetch(proxy.buildProxyUrl(target, path), {
      ...options,
      headers: proxy.buildManagementHeaders(target, options.headers || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.status === "error") throw new Error("CCS OAuth request failed");
    return body;
  };
  return {
    start: async (provider) => {
      if (!ALLOWED_PROVIDERS.has(provider)) throw requestError("Unsupported provider", 400);
      const body = await request(authTypes.getManagementAuthUrlPath(provider));
      return { authUrl: body.url || body.auth_url, state: body.state };
    },
    poll: async (state) => (await request(`/v0/management/get-auth-status?state=${encodeURIComponent(state)}`)).status,
    submitCallback: async (provider, redirectUrl) => request(authTypes.getManagementOAuthCallbackPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: authTypes.CLIPROXY_CALLBACK_PROVIDER_MAP[provider] || provider, redirect_url: redirectUrl }),
    }),
    listTokens: (provider) => tokens.listProviderTokenSnapshots(provider),
    findChangedToken: (provider, known, expected) => tokens.findNewTokenSnapshot(tokens.listProviderTokenSnapshots(provider), known, expected),
    register: (provider, nickname, expected) => tokens.registerAccountFromToken(provider, tokens.getProviderTokenDir(provider), nickname, false, expected),
  };
}

function publicSession(session) {
  return {
    sessionId: session.id, provider: session.provider, status: session.status, message: session.message,
    authUrl: session.status === "waiting" || session.status === "processing" ? session.authUrl : null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}
function safeAuthorizationUrl(value) { try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : null; } catch { return null; } }
function stateFromUrl(value) { try { return new URL(value).searchParams.get("state"); } catch { return null; } }
function cleanState(value) { return typeof value === "string" && /^[A-Za-z0-9._~-]{8,512}$/.test(value) ? value : null; }
function isLoopback(host) { return ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(host.replace(/^\[|\]$/g, "").toLowerCase()); }
function requestError(message, statusCode) { const error = new TypeError(message); error.statusCode = statusCode; return error; }
function serviceError(message) { const error = new Error(message); error.statusCode = 503; return error; }
