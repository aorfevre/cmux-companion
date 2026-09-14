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
  lastResume?: {id:string;code:string|null};
}
export interface Task extends TaskContract {
  status: TaskStatus; candidateSha: string | null; candidateBase: string | null;
  integratedSha: string | null; repairCount: number; repairLimit: number;
}
export interface Verification {
  headSha: string; checks: { id: string; passed: boolean; artifactId: string }[];
}
export interface Goal {
  description?: string; projectCode?: string; plannerName?: string; clarification?: {question:string;answer?:string};
  startup?: { status: 'pending' | 'failed' | 'ready'; error: string | null };
  id: string; version: number; generation: number; repositoryId: string; title: string; baseSha: string; baseBranch: string;
  status: GoalStatus; revision: number; approvedRevision: number | null;
  contracts: { revision: number; contract: Contract }[]; tasks: Task[];
  attempts: Attempt[]; reviews: Review[]; integrationHead: string;
  verification: Verification | null; finalRepairCount: number; finalRepairLimit: number;
  pr: { number: number; url: string; headSha: string } | null;
  integration: { operationId: string; taskId: string | null; expectedHead: string; candidateSha: string; baseSha: string; state: 'applying' | 'conflict' | 'repairing' | 'failed' | 'cancelled'; failedFrom?: 'applying' | 'repairing'; code?: string; retryRequested?: boolean } | null;
  publication: { operationId: string; headSha: string; generation: number; revision: number; plan: PublicationInput; observation?: PublicationResult } | null;
  planningRequest?: { message: string; basedOnRevision: number } | null;
  verificationRuns?: { operationId: string; generation: number; revision: number; headSha: string; status: 'pending' | 'complete' | 'uncertain' | 'cancelled'; workerState: 'pending' | 'stopped' | 'unknown'; result?: VerificationRunResult; retryRequested?: boolean }[];
  integrationResults?: { operationId: string; taskId: string | null; headSha: string }[];
  results?: { id: string; attemptId: string; artifactId: string; proofArtifactId?: string; repair?: { effectId: string; integrationOperationId: string; headSha: string }; status: 'pending' | 'accepted' | 'rejected'; code: string | null }[];
}
export interface EvidenceReference { path: string; line: number; description: string }
export type RoleOutput =
  | { role: 'planner'; output: { contract: Contract } | { question: string } }
  | { role: 'reviewer'; output: ReviewResult }
  | { role: 'implementer'; output: { headSha: string; summary: string; evidence: EvidenceReference[] } }
  | { role: 'integrator'; output: { headSha: string; operationId: string | null; summary: string; evidence: EvidenceReference[] } };
export type RoleResult = RoleOutput & { schemaVersion: 1; goalId: string; attemptId: string; operationId: string; generation: number; revision: number; target: string };
export type Authority = { kind: 'user' } | { kind: 'system' } | {
  kind: 'agent'; goalId: string; generation: number; revision: number; attemptId: string; role: Role;
};
export interface DomainEvent { kind: string; payload: Json }
export interface Intent {
  id: string; kind: 'launch' | 'resume' | 'terminate' | 'integrate' | 'integrate_repair' | 'verify' | 'publish'; goalId: string;
  generation: number; revision: number; attemptId: string | null; payload: Json;
}
export interface Transition { goal: Goal; events: DomainEvent[]; intents: Intent[] }
export interface Command {
  id: string; goalId: string; expectedVersion: number; type: string; payload: unknown;
}
export interface LaunchRequest { resumeId?: string; operationId: string; goalId: string; attempt: Attempt }
export interface AgentPort {
  capabilities: { role: Role; mode: Mode }[];
  launch(request: LaunchRequest): Promise<{ identity: string }>;
  observe(operationId: string): Promise<{ status: 'running' | 'stopped' | 'unknown'; identity: string | null }>;
  terminate(identity: string): Promise<void>;
  resume?(request: LaunchRequest): Promise<{identity:string}>;
  open?(operationId: string): Promise<void>;
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
  integrate(input: { goalId: string; repositoryId: string; operationId: string; expectedHead: string; baseSha: string; candidateSha: string }): Promise<{ status: 'integrated'; headSha: string } | { status: 'conflict'; worktree: string }>;
  provisionRepair(input: { goalId: string; repositoryId: string; integrationOperationId: string; attempt: Attempt }): Promise<{ worktree: string; branch: string; baseSha: string }>;
  acceptRepair(input: RepairInput): Promise<{ status: 'integrated'; headSha: string }>;
  observeRepair(input: RepairInput): Promise<{ status: 'integrated' | 'pending' | 'unknown'; headSha: string | null }>;
  observeIntegration(operationId: string): Promise<{ status: 'integrated' | 'pending' | 'unknown'; headSha: string | null }>;
}
export interface VerificationPort {
  run(input: { operationId: string; goalId: string; repositoryId: string; headSha: string; checks: Check[]; signal?: AbortSignal }): Promise<VerificationRunResult>;
  observe(operationId: string): Promise<VerificationRunResult | null>;
}


export interface RepairInput { goalId: string; repositoryId: string; integrationOperationId: string; effectId: string; attempt: Attempt; headSha: string; proofArtifactId: string }

export interface VerificationRunResult { verification: Verification; workerState: 'stopped' | 'unknown'; artifactId: string }

export interface PublicationInput {
  operationId: string; goalId: string; repositoryId: string; headSha: string;
  branch: string; baseBranch: string; baseSha: string; marker: string;
  acceptedTargets?: { id: string; previousBaseSha: string; baseHeadSha: string }[];
}
export interface PublicationResult {
  status: 'pending' | 'published' | 'unknown' | 'cancelled' | 'target_moved';
  baseHeadSha: string | null; pr: { number: number; url: string; headSha: string; state?: 'open' | 'closed' | 'merged' } | null;
}
export interface RemotePort {
  identity(repositoryId: string): string;
  head(repositoryId: string, branch: string): Promise<string | null>;
  push(input: { repositoryId: string; branch: string; headSha: string; expectedHead: string | null }, options?: { beforeSend?: () => boolean }): Promise<void>;
}
export interface GitHubPort {
  identity(repositoryId: string): string;
  find(repositoryId: string, branch: string): Promise<{ number: number; url: string; branch: string; baseBranch: string; headSha: string; marker: string | null; state: 'open' | 'closed' | 'merged' }[]>;
  create(input: PublicationInput, options?: { beforeSend?: () => boolean }): Promise<void>;
}
export interface PublicationPort {
  publish(input: PublicationInput, options?: { signal?: AbortSignal }): Promise<PublicationResult>;
  observe(input: PublicationInput): Promise<PublicationResult>;
}
