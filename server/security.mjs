import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** @param {string} path */
export function ensureToken(path, explicitToken = process.env.CMUX_COMPANION_TOKEN) {
  if (explicitToken) return explicitToken.trim();
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token.length >= 32) return token;
  } catch {
    // The token file does not exist yet; create it below.
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** @param {string} token */
export function sessionValue(token) {
  return createHash("sha256").update("cmux-companion-session\0").update(token).digest("base64url");
}

/** @param {unknown} [header] */
export function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part) => {
        const index = part.indexOf("=");
        try {
          return [index < 0
            ? [decodeURIComponent(part), ""]
            : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))]];
        } catch {
          // An invalid cookie must not break pairing or other valid cookies.
          return [];
        }
      }),
  );
}

/** @param {unknown} left @param {unknown} right */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param {{headers: Record<string, string | string[] | undefined>; protocol?: string}} request @param {string} token */
export function isAuthorized(request, token) {
  if (isSessionAuthorized(request, token)) return true;

  return isBearerAuthorized(request, token);
}

/** @param {{headers: Record<string, string | string[] | undefined>}} request @param {string} token */
export function isBearerAuthorized(request, token) {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ") && safeEqual(authorization.slice(7), token);
}

/** @param {{headers: Record<string, string | string[] | undefined>; protocol?: string}} request @param {string} token */
export function isSessionAuthorized(request, token) {
  const cookie = parseCookies(request.headers.cookie).cmux_session;
  return Boolean(cookie && safeEqual(cookie, sessionValue(token)));
}

/** @param {{headers: Record<string, string | string[] | undefined>}} request */
export function tailscaleIdentity(request) {
  return {
    login: header(request, "tailscale-user-login"),
    name: header(request, "tailscale-user-name"),
    profilePicture: header(request, "tailscale-user-profile-pic"),
  };
}

/** @typedef {{headers: Record<string, string | string[] | undefined>; protocol?: string; raw?: {socket: {remoteAddress?: string; encrypted?: boolean}}}} OriginRequest */

/** Only the loopback transport proxy may supply the public host/protocol.
 * Never use forwarded values based on a caller-controlled header alone.
 * @param {OriginRequest} request */
function requestOrigin(request) {
  const socket = request.raw?.socket;
  const trustedProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket?.remoteAddress || '');
  const forwardedHost = trustedProxy ? request.headers['x-forwarded-host'] : undefined;
  const forwardedProto = trustedProxy ? request.headers['x-forwarded-proto'] : undefined;
  const host = forwardedHost ?? request.headers.host;
  const protocol = forwardedProto ?? (socket ? socket.encrypted ? 'https' : 'http' : request.protocol || 'http');
  if (typeof host !== 'string' || typeof protocol !== 'string' || !['http', 'https'].includes(protocol)) throw new Error('Invalid request origin');
  if (/[\s/@?#\\]/.test(host)) throw new Error('Invalid request host');
  const url = new URL(`${protocol}://${host}`);
  if (!url.hostname) throw new Error('Invalid request host');
  return url;
}

/** Origin-less non-browser HTTP clients remain supported. WebSocket cookie
 * clients additionally require an Origin at their upgrade boundary.
 * @param {OriginRequest} request */
export function isSafeOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    if (typeof origin !== 'string') return false;
    const supplied = new URL(origin);
    return supplied.origin === origin && supplied.origin === requestOrigin(request).origin;
  } catch { return false; }
}

/** @param {OriginRequest} request @param {string} token */
export function sessionCookie(request, token) {
  let secure = false;
  try { secure = requestOrigin(request).protocol === 'https:'; } catch { /* Invalid origins cannot pair. */ }
  return [
    `cmux_session=${encodeURIComponent(sessionValue(token))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=31536000",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

/** @param {{headers: Record<string, string | string[] | undefined>}} request @param {string} name */
function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] || null : value || null;
}
