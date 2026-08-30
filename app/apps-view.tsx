"use client";

import { useCallback, useEffect, useState } from "react";

export type Preview = { id: string; workspaceId: string; repoId?: string | null; name: string; targetPort: number; publicPort?: number | null; sourceUrl: string; url?: string | null; status: "detected" | "active" | "stopped"; updatedAt: string };

export function AppsView({ focusedId, onOpenWorkspace, onNotice }: { focusedId?: string | null; onOpenWorkspace: (id: string) => void; onNotice: (message: string) => void }) {
  const [previews, setPreviews] = useState<Preview[]>([]); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { const response = await fetch("/api/previews"); const body = await response.json(); if (!response.ok) throw new Error(body.error); setPreviews(body.previews || []); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Private previews unavailable"); }
  }, []);
  useEffect(() => { const kickoff = setTimeout(load, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") load(); }, 5_000); return () => { clearTimeout(kickoff); clearInterval(poll); }; }, [load]);
  async function mutate(preview: Preview, action: "enable" | "stop" | "restart" | "remove") {
    setBusy(preview.id);
    try {
      const response = await fetch(action === "remove" ? `/api/previews/${preview.id}` : `/api/previews/${preview.id}/${action}`, { method: action === "remove" ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Preview action failed");
      await load(); onNotice(action === "enable" ? "Private preview is ready" : action === "stop" ? "Private preview stopped" : action === "restart" ? "Private preview link restarted" : "Preview removed");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Preview action failed"); }
    finally { setBusy(""); }
  }
  return <section className="subpage apps-page"><div className="page-kicker"><div><p className="eyebrow">TAILNET-ONLY</p><h1>Local apps</h1></div><button className="text-button" onClick={load}>Refresh</button></div><p className="subpage-intro">Open apps running on your Mac through temporary private HTTPS links. Nothing is published to the internet.</p>
    {error && <div className="apps-warning">{error}</div>}
    {!error && previews.length === 0 && <div className="empty-card"><span>⌁</span><strong>No local apps detected</strong><p>Start a development server in cmux. Localhost links in terminal output will appear here.</p></div>}
    <div className="preview-list">{previews.map((preview) => <article className={`preview-card ${preview.id === focusedId ? "focused" : ""}`} key={preview.id}><header><span className={`preview-status ${preview.status}`} /><div><strong>{preview.name}</strong><small>localhost:{preview.targetPort}</small></div><em>{preview.status}</em></header>{preview.url && <a className="preview-url" href={preview.url} target="_blank" rel="noreferrer">{preview.url}<b>↗</b></a>}<div className="preview-actions">{preview.status !== "active" ? <button className="approve" disabled={busy === preview.id} onClick={() => mutate(preview, "enable")}>Make private link</button> : <><a href={preview.url || "#"} target="_blank" rel="noreferrer">Open</a><button disabled={busy === preview.id} onClick={() => navigator.clipboard.writeText(preview.url || "").then(() => onNotice("Preview link copied"))}>Copy</button><button disabled={busy === preview.id} onClick={() => mutate(preview, "restart")}>Restart link</button><button className="deny" disabled={busy === preview.id} onClick={() => mutate(preview, "stop")}>Stop</button></>}<button disabled={busy === preview.id} onClick={() => onOpenWorkspace(preview.workspaceId)}>Session</button>{preview.status !== "active" && <button className="muted-action" disabled={busy === preview.id} onClick={() => mutate(preview, "remove")}>Remove</button>}</div></article>)}</div>
    <div className="privacy-note"><strong>Private by default</strong><p>Links use Tailscale Serve and are available only inside your tailnet. Companion never enables Funnel. Stop links you no longer need.</p></div>
  </section>;
}
