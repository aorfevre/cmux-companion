"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { resolveAssetPath, resolveMarkdownPath } from "./context-links.mjs";

type MarkdownFile = { repo: { id: string; name: string; path: string }; path: string; name: string; content: string };

export function MarkdownViewer({ repoId, path, onClose, onAsk, onOpenWorkspace }: { repoId: string; path: string; onClose: () => void; onAsk: (file: MarkdownFile) => void; onOpenWorkspace: (repoId: string) => void }) {
  const [file, setFile] = useState<MarkdownFile | null>(null);
  const [currentPath, setCurrentPath] = useState(path);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`/api/repos/${encodeURIComponent(repoId)}/markdown?file=${encodeURIComponent(currentPath)}`)
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Markdown file unavailable"); return body; })
      .then((value) => { if (active) setFile(value); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Markdown file unavailable"); });
    return () => { active = false; };
  }, [repoId, currentPath]);
  const headings = useMemo(() => file ? [...file.content.matchAll(/^(#{1,3})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, title: match[2].replace(/\s+#+$/, "").trim(), id: slug(match[2]) })).slice(0, 40) : [], [file]);
  function openMarkdown(href: string) {
    const next = resolveMarkdownPath(file?.path || currentPath, href);
    if (!next) { setNotice("That link points outside this repository"); return; }
    setFile(null); setError(""); setCurrentPath(next); setRaw(false); window.scrollTo(0, 0);
    history.replaceState(null, "", `/?repo=${encodeURIComponent(repoId)}&file=${encodeURIComponent(next)}`);
  }
  async function copyLink() {
    await navigator.clipboard.writeText(location.href);
    setNotice("Document link copied");
  }
  return <main className="document-shell">
    <header className="document-header"><button onClick={onClose}>‹ Back</button><div><strong>{file?.name || currentPath.split("/").pop()}</strong><span>{file ? `${file.repo.name} · ${file.path}` : "Opening document…"}</span></div><button className="document-menu" onClick={() => setRaw((value) => !value)}>{raw ? "Read" : "Raw"}</button></header>
    {notice && <button className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
    {error ? <section className="document-error"><strong>Could not open document</strong><p>{error}</p><button onClick={onClose}>Go back</button></section> : !file ? <div className="document-loading">Reading Markdown…</div> : <>
      <nav className="document-actions"><button onClick={() => onAsk(file)}>Ask agent</button><button onClick={() => onOpenWorkspace(repoId)}>Open session</button><button onClick={copyLink}>Copy link</button></nav>
      {headings.length > 2 && <details className="document-toc"><summary>Contents · {headings.length} sections</summary>{headings.map((heading, index) => <button style={{ paddingLeft: `${10 + (heading.level - 1) * 13}px` }} onClick={() => document.getElementById(heading.id)?.scrollIntoView({ behavior: "smooth" })} key={`${heading.id}-${index}`}>{heading.title}</button>)}</details>}
      {raw ? <pre className="document-raw">{file.content}</pre> : <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{
        a: ({ href = "", children }) => {
          const target = resolveMarkdownPath(file.path, href);
          if (target) return <button className="markdown-link" onClick={() => openMarkdown(href)}>{children}</button>;
          if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          return <span>{children}</span>;
        },
        img: ({ src = "", alt = "" }) => {
          const target = resolveAssetPath(file.path, src);
          return target ? <img src={`/api/repos/${encodeURIComponent(repoId)}/assets?file=${encodeURIComponent(target)}`} alt={alt} /> : <span className="broken-image">Image unavailable: {alt}</span>;
        },
        h1: ({ children }) => <h1 id={slug(String(children))}>{children}</h1>,
        h2: ({ children }) => <h2 id={slug(String(children))}>{children}</h2>,
        h3: ({ children }) => <h3 id={slug(String(children))}>{children}</h3>,
      }}>{file.content}</ReactMarkdown></article>}
    </>}
  </main>;
}

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80); }
