"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type Preview = { id: string; workspaceId: string; repoId?: string | null; name: string; targetPort: number; publicPort?: number | null; sourceUrl: string; url?: string | null; status: "detected" | "active" | "stopped"; updatedAt: string };
type Capture = { dataUrl: string; viewport: { width: number; height: number }; sourceUrl: string };
type Point = { x: number; y: number };
type Stroke = { points: Point[] };

export function AppsView({ focusedId, onOpenWorkspace, onNotice, onFix }: { focusedId: string | null; onOpenWorkspace: (id: string) => void; onNotice: (message: string) => void; onFix?: (preview: Preview, prompt: string, queue: boolean) => Promise<void> }) {
  const [previews, setPreviews] = useState<Preview[]>([]); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [capture, setCapture] = useState<{ preview: Preview; value: Capture } | null>(null);
  const [filter, setFilter] = useState<"testable" | "history">("testable");
  const load = useCallback(async () => {
    try { const response = await fetch("/api/previews"); const body = await response.json(); if (!response.ok) throw new Error(body.error); setPreviews(body.previews || []); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Private previews unavailable"); }
  }, []);
  useEffect(() => { const timer = setTimeout(load, 0); const poll = setInterval(() => { if (document.visibilityState === "visible") load(); }, 8_000); return () => { clearTimeout(timer); clearInterval(poll); }; }, [load]);
  useEffect(() => { if (!focusedId) return; const timer = setTimeout(() => { const focused = previews.find((preview) => preview.id === focusedId); if (focused?.status === "stopped" && filter !== "history") { setFilter("history"); return; } document.querySelector(`[data-preview="${CSS.escape(focusedId)}"]`)?.scrollIntoView({ block: "center" }); }, 100); return () => clearTimeout(timer); }, [filter, focusedId, previews]);
  async function mutate(preview: Preview, action: "enable" | "stop" | "restart" | "remove") {
    setBusy(preview.id);
    try {
      const response = await fetch(action === "remove" ? `/api/previews/${preview.id}` : `/api/previews/${preview.id}/${action}`, { method: action === "remove" ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Preview action failed");
      await load(); onNotice(action === "enable" ? "Private preview is ready" : action === "stop" ? "Private preview stopped" : action === "restart" ? "Private preview link restarted" : "Preview removed");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Preview action failed"); }
    finally { setBusy(""); }
  }
  async function startFix(preview: Preview) {
    setBusy(preview.id);
    try {
      const response = await fetch(`/api/previews/${preview.id}/capture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ width: Math.min(430, Math.max(320, window.innerWidth)), height: Math.min(932, Math.max(600, window.innerHeight)) }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not capture preview");
      setCapture({ preview, value: body });
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not capture preview"); }
    finally { setBusy(""); }
  }
  async function clearHistory() {
    const stopped = previews.filter((preview) => preview.status === "stopped");
    if (!stopped.length || !confirm(`Remove ${stopped.length} stopped app${stopped.length === 1 ? "" : "s"} from history?`)) return;
    setBusy("history");
    try {
      for (const preview of stopped) {
        const response = await fetch(`/api/previews/${preview.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!response.ok) throw new Error("Could not clear all stopped apps");
      }
      await load(); onNotice("Stopped app history cleared");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not clear app history"); }
    finally { setBusy(""); }
  }
  const active = previews.filter((preview) => preview.status === "active");
  const detected = previews.filter((preview) => preview.status === "detected");
  const stopped = previews.filter((preview) => preview.status === "stopped");
  const visible = filter === "history" ? stopped : [...active, ...detected];
  return <section className="subpage apps-page"><div className="page-kicker"><div><p className="eyebrow">TAILNET-ONLY</p><h1>Local apps</h1></div><button className="text-button" onClick={load}>Refresh</button></div><p className="subpage-intro">Open apps running on your Mac through private HTTPS links. Nothing is published to the internet.</p>{error && <div className="apps-warning">{error}</div>}
    {!error && previews.length === 0 && <div className="empty-card"><span>⌁</span><strong>No local apps detected</strong><p>Start a development server in cmux. Localhost links in terminal output will appear here.</p></div>}
    {previews.length > 0 && <><div className="apps-status-summary"><div className="ready"><strong>{active.length}</strong><span>Ready to test</span><small>Open immediately</small></div><div className="detected"><strong>{detected.length}</strong><span>Setup needed</span><small>Running on your Mac</small></div><div><strong>{stopped.length}</strong><span>Offline</span><small>Kept in history</small></div></div><div className="apps-view-tabs" role="tablist" aria-label="App availability"><button role="tab" aria-selected={filter === "testable"} className={filter === "testable" ? "active" : ""} onClick={() => setFilter("testable")}>Testable <b>{active.length + detected.length}</b></button><button role="tab" aria-selected={filter === "history"} className={filter === "history" ? "active" : ""} onClick={() => setFilter("history")}>History <b>{stopped.length}</b></button>{filter === "history" && stopped.length > 0 && <button className="clear-preview-history" disabled={busy === "history"} onClick={clearHistory}>Clear history</button>}</div></>}
    {!error && previews.length > 0 && visible.length === 0 && <div className="empty-card"><span>✓</span><strong>{filter === "history" ? "No stopped apps" : "Nothing to test yet"}</strong><p>{filter === "history" ? "Stopped apps will appear here." : "Start a development server in cmux, then refresh this screen."}</p></div>}
    <div className="preview-list">{visible.map((preview) => <PreviewCard preview={preview} focused={preview.id === focusedId} busy={busy === preview.id} onMutate={mutate} onFix={onFix ? startFix : null} onOpenWorkspace={onOpenWorkspace} onNotice={onNotice} key={preview.id} />)}</div>
    {capture && onFix && <FixEditor preview={capture.preview} capture={capture.value} onClose={() => setCapture(null)} onFix={onFix} onNotice={onNotice} />}
  </section>;
}

function PreviewCard({ preview, focused, busy, onMutate, onFix, onOpenWorkspace, onNotice }: { preview: Preview; focused: boolean; busy: boolean; onMutate: (preview: Preview, action: "enable" | "stop" | "restart" | "remove") => Promise<void>; onFix: ((preview: Preview) => Promise<void>) | null; onOpenWorkspace: (id: string) => void; onNotice: (message: string) => void }) {
  const active = preview.status === "active";
  const detected = preview.status === "detected";
  const label = active ? "Ready to open" : detected ? "Running · setup needed" : "Offline";
  const guidance = active ? "Available from this device through your private Tailscale network." : detected ? "This app is running on your Mac. Create a private link to test it here." : "This app is not running, so it cannot be tested. Start it again from its cmux session.";
  return <article data-preview={preview.id} className={`preview-card ${preview.status} ${focused ? "focused" : ""}`}><header><span className={`preview-status ${preview.status}`} /><div><strong>{preview.name}</strong><small>localhost:{preview.targetPort} · {relativePreviewTime(preview.updatedAt)}</small></div><em>{label}</em></header><p className="preview-state-copy">{guidance}</p>
    {active && preview.url && <a className="preview-primary" href={preview.url} target="_blank" rel="noreferrer">Open app <b>↗</b></a>}
    {detected && <button className="preview-primary" disabled={busy} onClick={() => onMutate(preview, "enable")}>{busy ? "Creating link…" : "Create private link"}</button>}
    <div className="preview-secondary">{preview.status !== "stopped" && onFix && <button className="fix-preview-button" disabled={busy} onClick={() => onFix(preview)}>{busy ? "Capturing…" : "◎ Fix this"}</button>}<button disabled={busy} onClick={() => onOpenWorkspace(preview.workspaceId)}>Open session</button><details className="preview-more"><summary>More</summary><div>{active && <><button disabled={busy} onClick={() => navigator.clipboard.writeText(preview.url || "").then(() => onNotice("Preview link copied"))}>Copy link</button><button disabled={busy} onClick={() => onMutate(preview, "restart")}>Restart link</button><button className="deny" disabled={busy} onClick={() => onMutate(preview, "stop")}>Stop link</button></>}{!active && <button className="muted-action" disabled={busy} onClick={() => onMutate(preview, "remove")}>Remove from {detected ? "list" : "history"}</button>}</div></details></div>
  </article>;
}

function relativePreviewTime(value: string) {
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "now";
  const minutes = Math.floor(milliseconds / 60_000); if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function FixEditor({ preview, capture, onClose, onFix, onNotice }: { preview: Preview; capture: Capture; onClose: () => void; onFix: (preview: Preview, prompt: string, queue: boolean) => Promise<void>; onNotice: (message: string) => void }) {
  const [strokes, setStrokes] = useState<Stroke[]>([]); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const drawing = useRef(false);
  function point(event: ReactPointerEvent<SVGSVGElement>) { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; }
  function begin(event: ReactPointerEvent<SVGSVGElement>) { event.preventDefault(); drawing.current = true; event.currentTarget.setPointerCapture(event.pointerId); setStrokes((current) => [...current, { points: [point(event)] }]); }
  function move(event: ReactPointerEvent<SVGSVGElement>) { if (!drawing.current) return; const next = point(event); setStrokes((current) => current.map((stroke, index) => index === current.length - 1 ? { points: [...stroke.points, next] } : stroke)); }
  function end() { drawing.current = false; }
  async function submit(queue: boolean) {
    setBusy(true);
    try {
      const annotated = await annotatedDataUrl(capture.dataUrl, strokes);
      const response = await fetch("/api/attachments/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl: annotated, name: `fix-${preview.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "preview"}.png` }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not save annotation");
      const prompt = [
        "Please fix the issue shown in this annotated mobile preview.",
        note.trim() ? `Feedback: ${note.trim()}` : "Inspect the marked area and correct the visual or interaction problem.",
        `Preview: ${capture.sourceUrl}`,
        `Mobile viewport: ${capture.viewport.width}×${capture.viewport.height}`,
        `Annotated image:\n- ${body.image.path}`,
        "After the change, verify it in the local preview.",
      ].join("\n\n");
      await onFix(preview, prompt, queue);
      onClose();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not send visual feedback"); }
    finally { setBusy(false); }
  }
  return <section className="fix-editor" role="dialog" aria-modal="true" aria-label="Annotate preview"><header><button disabled={busy} onClick={onClose}>Cancel</button><div><strong>Fix this</strong><span>Draw over the problem</span></div><button disabled={busy || strokes.length === 0} onClick={() => setStrokes((current) => current.slice(0, -1))}>Undo</button></header><div className="fix-canvas"><img src={capture.dataUrl} alt={`${preview.name} mobile preview`} draggable={false} /><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>{strokes.map((stroke, index) => stroke.points.length === 1 ? <circle key={index} cx={stroke.points[0].x * 1000} cy={stroke.points[0].y * 1000} r="18" /> : <polyline key={index} points={stroke.points.map((value) => `${value.x * 1000},${value.y * 1000}`).join(" ")} />)}</svg></div><label className="fix-note"><span>What should change?</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2_000} rows={3} placeholder="Optional—circle or draw on the issue, then add context here…" /></label><footer><button disabled={busy} onClick={() => submit(true)}>{busy ? "Saving…" : "Queue fix"}</button><button className="primary-button" disabled={busy} onClick={() => submit(false)}>{busy ? "Sending…" : "Send now"}</button></footer></section>;
}

function annotatedDataUrl(source: string, strokes: Stroke[]) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d"); if (!context) { reject(new Error("Annotation is unavailable")); return; }
      context.drawImage(image, 0, 0); context.strokeStyle = "#ff3b5c"; context.fillStyle = "#ff3b5c"; context.lineWidth = Math.max(8, image.naturalWidth * 0.012); context.lineCap = "round"; context.lineJoin = "round";
      for (const stroke of strokes) {
        if (stroke.points.length === 1) { const value = stroke.points[0]; context.beginPath(); context.arc(value.x * canvas.width, value.y * canvas.height, context.lineWidth * 1.4, 0, Math.PI * 2); context.fill(); continue; }
        context.beginPath(); stroke.points.forEach((value, index) => { const x = value.x * canvas.width; const y = value.y * canvas.height; if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }); context.stroke();
      }
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Could not prepare the preview annotation"));
    image.src = source;
  });
}
