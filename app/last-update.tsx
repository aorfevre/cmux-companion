'use client';
import { useEffect, useState } from 'react';
import { request as api } from './api-request';
export function updatedAgo(at: number, now = Date.now()) { const seconds = Math.max(0, Math.round((now - at) / 1000)); if (seconds < 60) return "just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }

export function LastUpdateStamp() {
  const [iso, setIso] = useState<string | null>(null); const [, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const status = await api<{ available?: boolean; lastSuccessAt?: string | null }>("/api/updater/status"); if (status?.available && status.lastSuccessAt) { if (active) setIso(status.lastSuccessAt); return; } } catch { /* fall back to the build stamp */ }
      try { const health = await api<{ version?: { builtAt?: string | null } | null }>("/api/health"); if (active) setIso(health?.version?.builtAt || null); } catch { if (active) setIso(null); }
    };
    load(); const poll = setInterval(load, 300_000); const tick = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => { active = false; clearInterval(poll); clearInterval(tick); };
  }, []);
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!iso || !Number.isFinite(at)) return null;
  return <time className="last-update" dateTime={iso} title={iso}>Updated {updatedAgo(at)}</time>;
}


