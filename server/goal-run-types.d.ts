export type PlannerRunStage = "writing_spec" | "review_spec" | "discussing";
export type PlannerRunPhase = "running" | "done" | "failed" | "aborted";
export type PlannerRun = {
  planId: string;
  kind: string;
  phase: PlannerRunPhase;
  stage: PlannerRunStage;
  step: string;
  error: string;
  startedAt: number;
  finishedAt: number | null;
  at: number;
};
