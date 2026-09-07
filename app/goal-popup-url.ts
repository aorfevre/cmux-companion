"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { request } from "./api-request";
import type { PlanDraft } from "./worktree-planner";
import { DEV_SETUP_GOAL } from "./dev-setup-goal";

type Repository = { id: string; name: string };
export type GoalPopupTarget = { repository: Repository; planId?: string; initialGoal?: string; initialDraft?: PlanDraft };
const CHANGED = "companion:goal-url";
const OWNED = "companionGoalPopup";

export function hasGoalPopup(search: string) {
  const query = new URLSearchParams(search);
  return Boolean(query.get("plan") || query.get("newGoal"));
}

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(CHANGED, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(CHANGED, listener); };
}

export function goalPopupUrl(target: { planId?: string; repositoryId?: string; devSetup?: boolean }, href = window.location.href) {
  const url = new URL(href);
  for (const key of ["plan", "newGoal", "goalTemplate", "workspace", "surface", "action", "repo", "file", "preview", "tab", "context"]) url.searchParams.delete(key);
  url.searchParams.set("view", "sessions");
  url.searchParams.set("mode", "worktrees");
  if (target.planId) url.searchParams.set("plan", target.planId);
  else if (target.repositoryId) {
    url.searchParams.set("newGoal", target.repositoryId);
    if (target.devSetup) url.searchParams.set("goalTemplate", "dev-setup");
  }
  return url;
}

export function openGoalPopup(target: GoalPopupTarget, replace = false) {
  const url = goalPopupUrl({ planId: target.planId, repositoryId: target.repository.id, devSetup: target.initialGoal === DEV_SETUP_GOAL });
  const state = { ...history.state, [OWNED]: replace ? history.state?.[OWNED] === true : true };
  history[replace ? "replaceState" : "pushState"](state, "", url);
  window.dispatchEvent(new Event(CHANGED));
}

export function closeGoalPopup() {
  if (history.state?.[OWNED]) { history.back(); return; }
  const url = new URL(location.href);
  for (const key of ["plan", "newGoal", "goalTemplate"]) url.searchParams.delete(key);
  history.replaceState(history.state, "", url);
  window.dispatchEvent(new Event(CHANGED));
}

// Saved goals resolve by durable ID, independently of board filters, pagination,
// repository visibility, or which home mode this browser last used.
export function useGoalPopup(repositories?: Repository[]) {
  const search = useSyncExternalStore(subscribe, () => location.search, () => "");
  const query = new URLSearchParams(search);
  const planId = query.get("plan") || "";
  const repositoryId = planId ? "" : query.get("newGoal") || "";
  const devSetup = query.get("goalTemplate") === "dev-setup";
  const key = JSON.stringify([planId, repositoryId, devSetup]);
  const repository = repositories?.find((item) => item.id === repositoryId);
  const repositoryName = repository?.name;
  const repositoriesLoaded = !planId && Boolean(repositories);
  const [resolved, setResolved] = useState<{ key: string; target?: GoalPopupTarget; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (!planId && !repositoryId) {
      void Promise.resolve().then(() => { if (active) setResolved(null); });
    } else if (planId) {
      request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(planId)}`).then((draft) => {
        if (!draft.planId || !draft.repositoryId) throw new Error("This goal link could not be resolved");
        if (active) setResolved({ key, target: { planId, repository: { id: draft.repositoryId, name: draft.repositoryName || "Goal repository" }, initialDraft: draft } });
      }).catch((cause) => { if (active) setResolved({ key, error: cause instanceof Error ? cause.message : "Could not open this goal" }); });
    } else if (repositoryId && repositoriesLoaded) {
      // Resolve on the next microtask, matching the asynchronous saved-goal path.
      void Promise.resolve().then(() => {
        if (active) setResolved(repositoryName
          ? { key, target: { repository: { id: repositoryId, name: repositoryName }, initialGoal: devSetup ? DEV_SETUP_GOAL : "" } }
          : { key, error: "The repository for this new-goal link is unavailable" });
      });
    }
    return () => { active = false; };
  }, [key, planId, repositoryId, repositoryName, repositoriesLoaded, devSetup]);
  return { open: Boolean(planId || repositoryId), target: resolved?.key === key ? resolved.target : undefined, error: resolved?.key === key ? resolved.error : undefined, key };
}
