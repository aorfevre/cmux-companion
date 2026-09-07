"use client";

import { FormEvent, useState } from "react";
import type { PlanSummary } from "./worktree-planner";
import { DEFAULT_FOLLOWUP_AGENT, GOAL_FOLLOWUP_ACTIONS, GOAL_FOLLOWUP_AGENTS, MAX_FOLLOWUP_TEXT, normalizeFollowupRequest } from "../server/goal-followup-actions.mjs";

type FollowupAgent = "claude" | "codex";
export type FollowupSubmission = { actions: string[]; question?: string; custom?: string; agent: FollowupAgent };

export function FollowupSheet({ plan, busy, onClose, onSubmit }: { plan: PlanSummary; busy: boolean; onClose: () => void; onSubmit: (submission: FollowupSubmission) => Promise<void> }) {
  const [actions, setActions] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [custom, setCustom] = useState("");
  const [agent, setAgent] = useState<FollowupAgent>(DEFAULT_FOLLOWUP_AGENT as FollowupAgent);
  const [error, setError] = useState("");

  function toggleAction(id: string, checked: boolean) {
    setActions((current) => checked ? [...current, id] : current.filter((action) => action !== id));
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const normalized = normalizeFollowupRequest({ actions, question, custom, agent }) as { actions: string[]; question: string; custom: string; agent: FollowupAgent };
      await onSubmit({ actions: normalized.actions, ...(normalized.question ? { question: normalized.question } : {}), ...(normalized.custom ? { custom: normalized.custom } : {}), agent: normalized.agent });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this follow-up");
    }
  }

  return <><button type="button" className="session-menu-backdrop" aria-label="Close follow-up actions" disabled={busy} onClick={onClose} /><form className="worktree-launcher goal-followup-sheet" role="dialog" aria-modal="true" aria-label={`More actions for ${plan.goal}`} onSubmit={submit}>
    <header><div><strong>More actions</strong><span>{plan.goal}</span></div><button type="button" aria-label="Close follow-up actions" disabled={busy} onClick={onClose}>×</button></header>
    <div className="goal-followup-options">{GOAL_FOLLOWUP_ACTIONS.map((action) => {
      const checked = actions.includes(action.id);
      return <div className={checked ? "selected" : ""} key={action.id}>
        <label className="goal-followup-option" aria-label={`${action.label}: ${action.description}`}><input type="checkbox" checked={checked} onChange={(event) => toggleAction(action.id, event.target.checked)} /><span><strong>{action.label}</strong><small>{action.description}</small></span></label>
        {checked && action.requiresText && <label className="goal-followup-text"><span>{action.label}</span><textarea aria-label={`${action.label} details`} value={action.textKey === "question" ? question : custom} maxLength={MAX_FOLLOWUP_TEXT} rows={4} onChange={(event) => { if (action.textKey === "question") setQuestion(event.target.value); else setCustom(event.target.value); setError(""); }} /></label>}
      </div>;
    })}</div>
    <fieldset className="goal-followup-agents"><legend>Agent</legend>{GOAL_FOLLOWUP_AGENTS.map((option) => <label className={agent === option ? "selected" : ""} key={option}><input type="radio" name="followup-agent" value={option} checked={agent === option} onChange={() => { setAgent(option as FollowupAgent); setError(""); }} /><span>{option.slice(0, 1).toUpperCase() + option.slice(1)}</span></label>)}</fieldset>
    {error && <p className="worktree-action-error" role="alert">{error}</p>}
    <div className="goal-followup-submit"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "Starting follow-up…" : "Submit follow-up"}</button></div>
  </form></>;
}
