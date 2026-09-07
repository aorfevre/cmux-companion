// Contract: MoonshotAI/kimi-cli src/kimi_cli/ui/shell/usage.py.
// Kimi Code subscriptions expose usage; Moonshot API billing is separate.
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";

export async function kimiUsage({ key = process.env.CMUX_COMPANION_KIMI_API_KEY, fetcher = fetch } = {}) {
  if (!key) return { available: false, accounts: [], quotas: [], message: "Kimi sessions are supported. To show Kimi Code usage, set CMUX_COMPANION_KIMI_API_KEY on the Mac and restart the companion." };
  const accounts = [{ id: "kimi-code", nickname: "Kimi Code", tier: "Subscription" }];
  try {
    const response = await fetcher(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12_000), redirect: "error",
    });
    if (!response.ok) throw new Error("Usage unavailable");
    const windows = exactKimiWindows(await response.json());
    return { available: true, accounts, quotas: [{ account: "kimi-code", quota: { success: true, windows, lastUpdated: Date.now() } }] };
  } catch {
    return { available: false, accounts, quotas: [], message: "Kimi Code usage is unavailable. Check the subscription key on the Mac, then refresh." };
  }
}

export function exactKimiWindows(payload, now = Date.now()) {
  const rows = [];
  if (payload?.usage) rows.push({ detail: payload.usage, cadence: "weekly", label: "Weekly limit" });
  if (Array.isArray(payload?.limits)) payload.limits.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const detail = item.detail || item;
    const duration = number(item.window?.duration ?? item.duration ?? detail.duration);
    const unit = item.window?.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "";
    const seconds = duration * (String(unit).includes("MINUTE") ? 60 : String(unit).includes("HOUR") ? 3600 : String(unit).includes("DAY") ? 86400 : 1);
    const cadence = seconds === 18000 ? "5h" : seconds === 86400 ? "daily" : seconds === 604800 ? "weekly" : "other";
    rows.push({ detail, cadence, label: item.name || item.title || detail.name || detail.title || (cadence === "5h" ? "5 hours" : `Limit ${index + 1}`) });
  });
  return rows.flatMap(({ detail, cadence, label }) => {
    const limit = number(detail.limit);
    const used = number(detail.used);
    const remaining = Number.isFinite(used) ? limit - used : number(detail.remaining);
    if (!(limit > 0) || !Number.isFinite(limit) || !Number.isFinite(remaining)) return [];
    let resetAt = detail.reset_at ?? detail.resetAt ?? detail.reset_time ?? detail.resetTime ?? null;
    if (!resetAt) {
      const seconds = number(detail.reset_in ?? detail.resetIn ?? detail.ttl);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds < 31_536_000) resetAt = new Date(now + seconds * 1000).toISOString();
    }
    return [{ cadence, label, category: "usage", remainingPercent: Math.round(Math.max(0, Math.min(100, remaining / limit * 100))), resetAt }];
  });
}

function number(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
}
