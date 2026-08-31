import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const CACHE_MS = 60_000;
const PROVIDERS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "OpenAI Codex" },
];

export class AccountUsage {
  constructor({ sourceLoader = loadCcsSource, cacheMs = CACHE_MS } = {}) {
    this.sourceLoader = sourceLoader;
    this.cacheMs = cacheMs;
    this.cache = null;
    this.pending = null;
  }

  async snapshot({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.value;
    if (this.pending) return this.pending;
    this.pending = this.#load();
    try {
      const value = await this.pending;
      this.cache = { at: Date.now(), value };
      return value;
    } finally {
      this.pending = null;
    }
  }

  async #load() {
    try {
      const source = await this.sourceLoader();
      const metadata = Object.fromEntries(PROVIDERS.map(({ id }) => [id, safeAccounts(source.getProviderAccounts, id)]));
      const fetched = await Promise.allSettled([
        source.fetchAllClaudeQuotas(false),
        source.fetchAllCodexQuotas(false),
      ]);
      const providers = PROVIDERS.map((provider, index) => normalizeProvider(
        provider,
        metadata[provider.id],
        fetched[index].status === "fulfilled" ? fetched[index].value : [],
        fetched[index].status === "fulfilled",
      ));
      return response(providers, true);
    } catch {
      return response(PROVIDERS.map((provider) => ({ ...provider, available: false, accounts: [] })), false);
    }
  }
}

function response(providers, available) {
  const accounts = providers.flatMap((provider) => provider.accounts);
  const summary = { ready: 0, low: 0, exhausted: 0, reconnect: 0, unavailable: 0 };
  for (const account of accounts) summary[account.status] += 1;
  return {
    generatedAt: new Date().toISOString(),
    source: "CCS",
    available,
    summary,
    providers,
  };
}

function safeAccounts(getProviderAccounts, provider) {
  try {
    const accounts = getProviderAccounts(provider);
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

function normalizeProvider(provider, metadata, fetched, available) {
  const quotas = new Map((Array.isArray(fetched) ? fetched : [])
    .filter((item) => item && typeof item.account === "string")
    .map((item) => [item.account, item.quota || {}]));
  const accounts = new Map(metadata
    .filter((account) => account && typeof account.id === "string")
    .map((account) => [account.id, account]));
  for (const accountId of quotas.keys()) {
    if (!accounts.has(accountId)) accounts.set(accountId, { id: accountId });
  }
  return {
    ...provider,
    available,
    accounts: [...accounts.values()].map((account) => normalizeAccount(provider.id, account, quotas.get(account.id), available)),
  };
}

function normalizeAccount(provider, account, quota = null, providerAvailable = true) {
  const windows = quota?.success ? normalizeWindows(provider, quota.windows) : [];
  const remaining = windows.filter((window) => window.category === "usage").map((window) => window.remainingPercent);
  let status = "unavailable";
  if (quota?.needsReauth) status = "reconnect";
  else if (quota?.success && remaining.some((value) => value <= 0)) status = "exhausted";
  else if (quota?.success && remaining.some((value) => value <= 20)) status = "low";
  else if (quota?.success && remaining.length > 0) status = "ready";

  return {
    id: createHash("sha256").update(`${provider}:${account.id}`).digest("hex").slice(0, 20),
    label: cleanText(account.nickname) || cleanText(account.email) || cleanText(account.id) || "Account",
    email: cleanText(account.email) || cleanText(account.id) || null,
    plan: cleanPlan(quota?.planType || account.tier),
    isDefault: Boolean(account.isDefault),
    paused: Boolean(account.paused),
    status,
    message: status === "reconnect"
      ? "Reconnect this account in CCS"
      : !providerAvailable || !quota?.success
        ? "Quota is currently unavailable"
        : remaining.length === 0
          ? "No core usage window was reported"
          : null,
    updatedAt: safeDate(quota?.lastUpdated),
    windows,
  };
}

function normalizeWindows(provider, value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((window, index) => {
    const remainingPercent = finitePercent(window?.remainingPercent);
    if (remainingPercent === null) return [];
    const category = window?.category === "additional" || window?.category === "code-review" ? window.category : "usage";
    const cadence = cadenceFor(provider, window);
    return [{
      id: `${category}-${cadence}-${index}`,
      cadence,
      label: cleanText(window?.featureLabel) || cleanText(window?.label) || cadenceLabel(cadence),
      category,
      remainingPercent,
      resetAt: safeDate(window?.resetAt),
      reported: true,
    }];
  });
}

function cadenceFor(provider, window) {
  if (["5h", "daily", "weekly", "monthly"].includes(window?.cadence)) return window.cadence;
  const raw = `${window?.rateLimitType || ""} ${window?.label || ""}`.toLowerCase();
  if (raw.includes("five_hour") || raw.includes("5h") || raw.includes("session")) return "5h";
  if (raw.includes("seven_day") || raw.includes("weekly") || raw.includes("week")) return "weekly";
  if (raw.includes("daily") || raw.includes("day")) return "daily";
  if (raw.includes("monthly") || raw.includes("month")) return "monthly";
  return provider === "codex" && window?.label === "Primary" ? "5h" : "other";
}

function cadenceLabel(cadence) {
  return ({ "5h": "5-hour limit", daily: "Daily limit", weekly: "Weekly limit", monthly: "Monthly limit" })[cadence] || "Other limit";
}

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

function cleanPlan(value) {
  const plan = cleanText(value);
  return plan && plan !== "unknown" ? plan.toLowerCase() : null;
}

function safeDate(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function findCcsPackageRoot({ ccsBin = process.env.CCS_BIN, pathValue = process.env.PATH } = {}) {
  const candidates = [];
  if (ccsBin) candidates.push(resolve(ccsBin));
  for (const folder of String(pathValue || "").split(delimiter).filter(Boolean)) candidates.push(join(folder, "ccs"));
  const nvmVersions = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmVersions)) {
    for (const version of readdirSync(nvmVersions).sort().reverse()) candidates.push(join(nvmVersions, version, "bin", "ccs"));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      accessSync(candidate, constants.X_OK);
      let folder = dirname(realpathSync(candidate));
      for (let level = 0; level < 8; level += 1) {
        const manifest = join(folder, "package.json");
        if (existsSync(manifest)) {
          const parsed = JSON.parse(readFileSync(manifest, "utf8"));
          if (parsed?.name === "@kaitranntt/ccs") return folder;
        }
        const parent = dirname(folder);
        if (parent === folder) break;
        folder = parent;
      }
    } catch {
      // Try the next installed CCS executable.
    }
  }
  throw new Error("CCS is not installed");
}

export async function loadCcsSource() {
  const root = findCcsPackageRoot();
  const require = createRequire(import.meta.url);
  const accounts = require(join(root, "dist", "cliproxy", "accounts", "account-manager.js"));
  const claude = require(join(root, "dist", "cliproxy", "quota", "quota-fetcher-claude.js"));
  const codex = require(join(root, "dist", "cliproxy", "quota", "quota-fetcher-codex.js"));
  if (typeof accounts.getProviderAccounts !== "function" || typeof claude.fetchAllClaudeQuotas !== "function" || typeof codex.fetchAllCodexQuotas !== "function") {
    throw new Error("Installed CCS does not expose quota support");
  }
  return {
    getProviderAccounts: accounts.getProviderAccounts,
    fetchAllClaudeQuotas: claude.fetchAllClaudeQuotas,
    fetchAllCodexQuotas: async () => Promise.all(accounts.getProviderAccounts("codex").map(async (account) => ({
      account: account.id,
      quota: await fetchExactCodexQuota(account.id, codex),
    }))),
  };
}

async function fetchExactCodexQuota(accountId, codex) {
  const auth = codex.readCodexAuthData(accountId);
  if (!auth || auth.isExpired || !auth.accountId) return codex.fetchCodexQuota(accountId, false);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-Id": auth.accountId,
        "User-Agent": "codex_cli_rs/0.76.0 cmux-companion",
      },
    });
    if (!response.ok) return codex.fetchCodexQuota(accountId, false);
    const payload = await response.json();
    return {
      success: true,
      windows: exactCodexWindows(payload),
      planType: cleanPlan(payload?.plan_type || payload?.planType),
      lastUpdated: Date.now(),
      accountId,
    };
  } catch {
    return codex.fetchCodexQuota(accountId, false);
  } finally {
    clearTimeout(timeout);
  }
}

export function exactCodexWindows(payload) {
  const windows = [];
  const add = (label, raw, category, featureLabel = null) => {
    if (!raw || typeof raw !== "object") return;
    const usedPercent = Number(raw.used_percent ?? raw.usedPercent);
    if (!Number.isFinite(usedPercent)) return;
    const remainingPercent = finitePercent(100 - usedPercent);
    if (remainingPercent === null) return;
    const duration = Number(raw.limit_window_seconds ?? raw.limitWindowSeconds);
    const resetEpoch = Number(raw.reset_at ?? raw.resetAt);
    const resetSeconds = Number(raw.reset_after_seconds ?? raw.resetAfterSeconds);
    const resetAt = Number.isFinite(resetEpoch) && resetEpoch > 0
      ? new Date(resetEpoch * 1000).toISOString()
      : Number.isFinite(resetSeconds) && resetSeconds > 0
        ? new Date(Date.now() + resetSeconds * 1000).toISOString()
        : null;
    windows.push({
      label,
      featureLabel,
      category,
      cadence: cadenceFromDuration(duration),
      remainingPercent,
      resetAt,
    });
  };
  const rateLimit = payload?.rate_limit || payload?.rateLimit;
  add("Primary usage", rateLimit?.primary_window || rateLimit?.primaryWindow, "usage");
  add("Secondary usage", rateLimit?.secondary_window || rateLimit?.secondaryWindow, "usage");
  const review = payload?.code_review_rate_limit || payload?.codeReviewRateLimit;
  add("Code Review", review?.primary_window || review?.primaryWindow, "code-review", "Code Review");
  add("Code Review", review?.secondary_window || review?.secondaryWindow, "code-review", "Code Review");
  const additional = payload?.additional_rate_limits || payload?.additionalRateLimits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const feature = cleanText(item?.limit_name || item?.limitName) || "Additional usage";
      const limit = item?.rate_limit || item?.rateLimit;
      add(feature, limit?.primary_window || limit?.primaryWindow, "additional", feature);
      add(feature, limit?.secondary_window || limit?.secondaryWindow, "additional", feature);
    }
  }
  return windows;
}

export function cadenceFromDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "other";
  if (seconds >= 16_200 && seconds <= 21_600) return "5h";
  if (seconds >= 82_800 && seconds <= 90_000) return "daily";
  if (seconds >= 518_400 && seconds <= 691_200) return "weekly";
  if (seconds >= 2_332_800 && seconds <= 2_764_800) return "monthly";
  return "other";
}
