import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

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

export function sessionValue(token) {
  return createHash("sha256").update("cmux-companion-session\0").update(token).digest("base64url");
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthorized(request, token) {
  const expected = sessionValue(token);
  const cookie = parseCookies(request.headers.cookie).cmux_session;
  if (cookie && safeEqual(cookie, expected)) return true;

  const authorization = String(request.headers.authorization || "");
  if (authorization.startsWith("Bearer ") && safeEqual(authorization.slice(7), token)) return true;
  return false;
}

export function tailscaleIdentity(request) {
  return {
    login: header(request, "tailscale-user-login"),
    name: header(request, "tailscale-user-name"),
    profilePicture: header(request, "tailscale-user-profile-pic"),
  };
}

export function isSafeOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = header(request, "x-forwarded-host");
    const host = forwardedHost || request.headers.host;
    return Boolean(host) && originUrl.host === host;
  } catch {
    return false;
  }
}

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

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] || null : value || null;
}
