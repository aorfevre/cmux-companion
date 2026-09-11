export type Role = 'planner' | 'implementer' | 'reviewer' | 'integrator';
export type Mode = 'interactive' | 'background';
export type GoalStatus = 'discovering' | 'awaiting_approval' | 'building' | 'ready_to_publish' | 'delivered' | 'merged' | 'aborted';
export type AttemptStatus = 'queued' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'running' | 'in_review' | 'repair_required' | 'accepted' | 'integrated' | 'failed';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Check { id: string; argv: string[] }
export interface Criterion { id: string; text: string; verification: string }
export interface TaskContract {
  id: string; title: string; prompt: string; dependsOn: string[]; ownedAreas: string[];
  criterionIds: string[]; integrationPolicy: 'serialize' | null;
}
export interface Contract {
  schemaVersion: 1; outcome: string; scope: string[]; exclusions: string[];
  criteria: Criterion[]; verification: Check[]; tasks: TaskContract[];
}
export interface Finding {
  id: string; severity: 'high' | 'medium' | 'low' | 'note'; blocking: boolean;
  title: string; evidence: string; suggestion: string;
}
export interface ReviewResult {
  schemaVersion: 1; target: string; disposition: 'accept' | 'request_changes'; findings: Finding[];
}
export interface Review extends ReviewResult { id: string; attemptId: string; kind: 'plan' | 'task' | 'integration'; taskId: string | null }
export interface Attempt {
  id: string; operationId: string; role: Role; mode: Mode; taskId: string | null;
  target: string; generation: number; revision: number; status: AttemptStatus;
  workerState: 'pending' | 'unknown' | 'running' | 'stopped'; identity: string | null; baseSha: string; worktree: string | null; branch: string | null;
  conversationId: string; error: string | null; retryRequested?: boolean;
}
export interface Task extends TaskContract {
  status: TaskStatus; candidateSha: string | null; candidateBase: string | null;
  integratedSha: string | null; repairCount: number; repairLimit: number;
}
export interface Verification {
  headSha: string; checks: { id: string; passed: boolean; artifactId: string }[];
}
export interface Goal {
  id: string; version: number; generation: number; repositoryId: string; title: string;
  status: GoalStatus; revision: number; approvedRevision: number | null;
  contracts: { revision: number; contract: Contract }[]; tasks: Task[];
  attempts: Attempt[]; reviews: Review[]; integrationHead: string;
  verification: Verification | null; finalRepairCount: number; finalRepairLimit: number;
  pr: { number: number; url: string; headSha: string } | null;
  integration: { operationId: string; taskId: string; expectedHead: string; candidateSha: string; baseSha: string; state: 'applying' | 'conflict' | 'failed' } | null;
  publication: { operationId: string; headSha: string; generation: number; revision: number } | null;
  planningRequest?: { message: string; basedOnRevision: number } | null;
  results?: { id: string; attemptId: string; artifactId: string; proofArtifactId?: string; status: 'pending' | 'accepted' | 'rejected'; code: string | null }[];
}
export interface EvidenceReference { path: string; line: number; description: string }
export type RoleOutput =
  | { role: 'planner'; output: { contract: Contract } }
  | { role: 'reviewer'; output: ReviewResult }
  | { role: 'implementer'; output: { headSha: string; summary: string; evidence: EvidenceReference[] } }
  | { role: 'integrator'; output: { headSha: string; operationId: string | null; summary: string; evidence: EvidenceReference[] } };
export type RoleResult = RoleOutput & { schemaVersion: 1; goalId: string; attemptId: string; operationId: string; generation: number; revision: number; target: string };
export type Authority = { kind: 'user' } | { kind: 'system' } | {
  kind: 'agent'; goalId: string; generation: number; revision: number; attemptId: string; role: Role;
};
export interface DomainEvent { kind: string; payload: Json }
export interface Intent {
  id: string; kind: 'launch' | 'terminate' | 'integrate' | 'publish'; goalId: string;
  generation: number; revision: number; attemptId: string | null; payload: Json;
}
export interface Transition { goal: Goal; events: DomainEvent[]; intents: Intent[] }
export interface Command {
  id: string; goalId: string; expectedVersion: number; type: string; payload: unknown;
}
export interface LaunchRequest { operationId: string; goalId: string; attempt: Attempt }
export interface AgentPort {
  capabilities: { role: Role; mode: Mode }[];
  launch(request: LaunchRequest): Promise<{ identity: string }>;
  observe(operationId: string): Promise<{ status: 'running' | 'stopped' | 'unknown'; identity: string | null }>;
  terminate(identity: string): Promise<void>;
}

export interface BackgroundPolicy { ceilingMs: number; idleMs: number; maxOutputBytes: number; killGraceMs: number }
export interface RuntimeClock { schedule(callback: () => void, delayMs: number): unknown; cancel(handle: unknown): void }
export interface ProcessOutcome {
  status: 'succeeded' | 'failed';
  workerState: 'stopped' | 'unknown';
  cause: null | { code: string; exitCode: number | null; signal: string | null };
  stdout: string; stderr: string;
}
export interface BackgroundHandle {
  identity: string; pid: number; result: Promise<ProcessOutcome>; terminate(): void;
}
export interface InteractiveAgentPort extends AgentPort {
  resume(request: LaunchRequest): Promise<{ identity: string }>;
}

export interface ClockPort { now(): string }
export interface IdentityPort { next(): string }
export interface RepositoryPort {
  provision(input: { operationId: string; repositoryId: string; branch: string; baseSha: string }): Promise<{ worktree: string; branch: string; baseSha: string }>;
  candidate(input: { repositoryId: string; attempt: Attempt; headSha: string; ownedAreas: string[] }): Promise<{ headSha: string; changedPaths: string[]; artifactId: string }>;
  integrate(input: { repositoryId: string; operationId: string; expectedHead: string; baseSha: string; candidateSha: string }): Promise<{ status: 'integrated'; headSha: string } | { status: 'conflict'; worktree: string }>;
  observeIntegration(operationId: string): Promise<{ status: 'integrated' | 'pending' | 'unknown'; headSha: string | null }>;
}
export interface VerificationPort {
  run(input: { repositoryId: string; headSha: string; checks: Check[] }): Promise<Verification>;
}
export interface PullRequestPort {
  publish(input: { operationId: string; goalId: string; repositoryId: string; headSha: string; branch: string; baseBranch: string }): Promise<{ number: number; url: string; headSha: string }>;
  observe(input: { goalId: string; repositoryId: string; branch: string }): Promise<{ status: 'missing' | 'unknown' | 'open' | 'merged'; number: number | null; url: string | null; headSha: string | null }>;
}
