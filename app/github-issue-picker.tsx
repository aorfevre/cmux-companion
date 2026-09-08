"use client";
import { useEffect, useState } from "react";
import { request } from "./api-request";
import type { GitHubIssueCard } from "./github-issue-types";

export function GitHubIssuePicker({ repository, onClose, onStart }: { repository: { id: string; name: string }; onClose: () => void; onStart: (issue: GitHubIssueCard) => Promise<boolean | void> }) {
  const [issues, setIssues] = useState<GitHubIssueCard[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ issues: GitHubIssueCard[] }>(`/api/github-issues/repository/${encodeURIComponent(repository.id)}`).then((result) => { if (active) setIssues(result.issues); }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [repository.id]);
  return <><div className="session-menu-backdrop" /><section className="worktree-launcher worktree-planner-sheet" role="dialog" aria-modal="true" aria-label="GitHub issues">
    <header><strong>GitHub issues · {repository.name}</strong><button type="button" aria-label="Close GitHub issues" onClick={onClose}>×</button></header>
    <p>Choose an issue to continue through the same interactive goal conversation used everywhere in Companion.</p>
    {error && <p role="alert">{error}</p>}
    {!issues && !error && <p role="status">Reading GitHub issues…</p>}
    {issues?.length === 0 && <p>No open issues.</p>}
    {issues?.map((issue) => <article key={issue.number}><h3>#{issue.number} · {issue.title}</h3><button type="button" disabled={busy} onClick={async () => { setBusy(true); try { if (await onStart(issue) !== false) onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this goal"); } finally { setBusy(false); } }}>Continue discovery for #{issue.number}</button></article>)}
  </section></>;
}
