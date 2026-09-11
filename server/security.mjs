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

  const authorization = String(request.headers.authorization || "");
  if (authorization.startsWith("Bearer ") && safeEqual(authorization.slice(7), token)) return true;
  return false;
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

/** @param {{headers: Record<string, string | string[] | undefined>}} request */
export function isSafeOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(String(origin));
    const forwardedHost = header(request, "x-forwarded-host");
    const host = forwardedHost || request.headers.host;
    return Boolean(host) && originUrl.host === host;
  } catch {
    return false;
  }
}

/** @param {{headers: Record<string, string | string[] | undefined>; protocol?: string}} request @param {string} token */
export function sessionCookie(request, token) {
  const forwardedProto = header(request, "x-forwarded-proto");
  const secure = forwardedProto === "https" || request.protocol === "https";
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
