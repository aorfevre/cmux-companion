"use client";

import { ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// The planner writes its task prompts in Markdown: `##` headings, `-` lists,
// backticked paths and a numbered finish step. A monospace block showed every
// marker literally, so the reviewer read syntax instead of a plan.
//
// rehypeHighlight is deliberately absent. A planner prompt quotes a path or a
// command in inline backticks and never opens a fenced code block, so the
// highlighter would cost a pass over every prompt and colour nothing. Add it
// here if the planner ever starts to emit fenced code.
//
// ReactMarkdown renders no raw HTML unless rehypeRaw is added, and it is not
// added. A prompt that holds `<script>` therefore reads as text.
function PromptMarkdown({ text }: { text: string }) {
  return <div className="planner-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    // The sheet has no repository resolver, so only an absolute web link can be
    // followed. Every other href — a relative path, an issue reference, a mail
    // link — renders as inert text, the same refusal markdown-viewer.tsx makes
    // for an href it cannot resolve.
    a: ({ href = "", children }) => /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
      : <span>{children}</span>,
  }}>{text}</ReactMarkdown></div>;
}

// The exact text still has to be readable, because this is what the agent
// receives. The Raw button mirrors the document viewer's, so the two surfaces
// behave the same way.
export function PromptDisclosure({ label, summary, text, children }: { label: string; summary: ReactNode; text: string; children?: ReactNode }) {
  const [raw, setRaw] = useState(false);
  return <details className="planner-prompt">
    <summary aria-label={label}>{summary}</summary>
    <div className="planner-prompt-body">
      {/* Inside <details> but outside <summary>, so this never collapses the card. */}
      <button type="button" className="planner-raw-toggle" aria-label={raw ? `Show ${label} as Markdown` : `Show ${label} as raw text`} onClick={() => setRaw((value) => !value)}>{raw ? "Rendered" : "Raw"}</button>
      {raw ? <pre className="planner-prompt-raw">{text}</pre> : <PromptMarkdown text={text} />}
      {children}
    </div>
  </details>;
}
