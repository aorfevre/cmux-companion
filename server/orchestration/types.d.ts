export type Role = 'planner' | 'implementer' | 'reviewer' | 'integrator' | 'review_fixer';
export type TeamRole = 'planner' | 'implementer' | 'reviewer' | 'integrator';
export type Mode = 'interactive' | 'background';
export type GoalStatus = 'discovering' | 'awaiting_approval' | 'building' | 'ready_to_publish' | 'delivered' | 'addressing_review' | 'merged' | 'aborted';
export type AttemptStatus = 'queued' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'running' | 'in_review' | 'repair_required' | 'accepted' | 'integrated' | 'failed';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Check { id: string; argv: string[] }
export interface Criterion { id: string; text: string; verification: string }
export interface TaskContract {
  id: string; title: string; prompt: string; dependsOn: string[]; ownedAreas: string[];
  criterionIds: string[]; resources?: string[]; integrationPolicy: 'serialize' | null;
}
export interface WaveContract { id: string; title: string; taskIds: string[]; checkIds: string[] }
export interface Contract {
  waves?: WaveContract[];
  schemaVersion: 1 | 2; outcome: string; scope: string[]; exclusions: string[];
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
  assignment?: TeamAssignment & { provider: string; model: string; label: string };
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
export interface TeamProfile { id: string; label: string; provider: 'claude' | 'codex'; model: string; roles: TeamRole[]; ready: boolean; reason: string; capacity: { remainingPercent: number | null; source: string; checkedAt: string | null; reason: string } }
export interface TeamConfiguration { profiles: TeamProfile[]; defaults: Record<TeamRole, string>; capturedAt: string }
export interface TeamAssignment { key: string; role: TeamRole; taskId: string | null; profileId: string | null; manual: boolean; reason: string }
export interface TeamProposal { revision: number; approved: boolean; assignments: TeamAssignment[]; changes: { commandId: string; key: string; from: string | null; to: string }[] }
export type MergeableVerdict = 'mergeable' | 'conflicting' | 'unknown';
export interface ReviewThread { id: string; path: string | null; line: number | null; author: string; body: string; isBot: boolean }
export interface ReviewReply { threadId: string; action: 'fixed' | 'declined' | 'comment'; body: string }
export type ReviewRoundState = 'fetching' | 'merging' | 'fixing' | 'verifying' | 'pushing' | 'replying' | 'settled' | 'failed' | 'unknown';
export type ReviewRoundOutcome = 'addressed' | 'nothing_to_address' | 'failed';
export interface ReviewRound {
  id: string; prHeadSha: string; startedAt: number; state: ReviewRoundState; threads: ReviewThread[];
  trigger?: 'user' | 'conflict'; mergeable?: MergeableVerdict;
  mergedBaseSha?: string; mergeCommitSha?: string; conflictPaths?: string[];
  attemptId?: string; summary?: string; fixHeadSha?: string; replies?: ReviewReply[]; verificationOperationId?: string;
  posted?: string[]; unconfirmed?: string[]; resolved?: string[]; outcome?: ReviewRoundOutcome; error?: string | null; settledAt?: number;
}
export interface GoalReference { id: string; name: string; bytes: number; mimeType: 'text/plain' | 'image/png' | 'image/jpeg' | 'image/webp' }
export interface Goal {
  teamConfiguration?: TeamConfiguration; team?: TeamProposal; teamHistory?: TeamProposal[];
  contractSchema?: 2;
  waveResults?: { waveId: string; generation: number; revision: number; headSha: string }[];
  references?: GoalReference[];
  hold?: { id: string; reasons: { kind: 'attempt' | 'review' | 'integration' | 'verification' | 'publication' | 'review_fix'; target: string; message: string }[] } | null;
  recoveries?: { commandId: string; hold: NonNullable<Goal['hold']> }[];
  description?: string; projectCode?: string; plannerName?: string; clarification?: {question:string;answer?:string};
  startup?: { status: 'pending' | 'failed' | 'ready'; error: string | null };
  id: string; version: number; generation: number; repositoryId: string; title: string; baseSha: string; baseBranch: string;
  status: GoalStatus; revision: number; approvedRevision: number | null;
  contracts: { revision: number; contract: Contract }[]; tasks: Task[];
  attempts: Attempt[]; reviews: Review[]; integrationHead: string;
  verification: Verification | null; finalRepairCount: number; finalRepairLimit: number;
  pr: { number: number; url: string; headSha: string } | null;
  mergeSync?: { checkedAt: number; state: 'open' | 'closed' | 'merged' | 'unknown'; error: string | null; mergeable?: MergeableVerdict } | null;
  conflictRoundKey?: string;
  reviewRound?: ReviewRound | null; reviewRounds?: ReviewRound[];
  integration: { operationId: string; taskId: string | null; expectedHead: string; candidateSha: string; baseSha: string; state: 'applying' | 'conflict' | 'repairing' | 'failed' | 'cancelled'; failedFrom?: 'applying' | 'repairing'; code?: string; retryRequested?: boolean } | null;
  publication: { operationId: string; headSha: string; generation: number; revision: number; plan: PublicationInput; approval?: { commandId: string; headSha: string }; observation?: PublicationResult } | null;
  planRevisionCount?: number; planReviewEnabled?: boolean;
  planningRequest?: { message: string; basedOnRevision: number } | null;
  verificationRuns?: { waveId?: string; checkIds?: string[]; operationId: string; generation: number; revision: number; headSha: string; status: 'pending' | 'complete' | 'uncertain' | 'cancelled'; workerState: 'pending' | 'stopped' | 'unknown'; result?: VerificationRunResult; retryRequested?: boolean }[];
  integrationResults?: { operationId: string; taskId: string | null; headSha: string }[];
  results?: { id: string; attemptId: string; artifactId: string; proofArtifactId?: string; repair?: { effectId: string; integrationOperationId: string; headSha: string }; status: 'pending' | 'accepted' | 'rejected'; code: string | null }[];
}
export interface EvidenceReference { path: string; line: number; description: string }
export type RoleOutput =
  | { role: 'planner'; output: { contract: Contract } | { question: string } }
  | { role: 'reviewer'; output: ReviewResult }
  | { role: 'implementer'; output: { headSha: string; summary: string; evidence: EvidenceReference[] } }
  | { role: 'integrator'; output: { headSha: string; operationId: string | null; summary: string; evidence: EvidenceReference[] } }
  | { role: 'review_fixer'; output: { headSha: string; summary: string; replies: ReviewReply[] } };
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
export interface HandoffIdentity { goalId: string; operationId: string; identity: string; credentialDigest: string; endpoint: string }
export interface AgentPort {
  prepareHandoff?(request: LaunchRequest): Promise<HandoffIdentity>;
  capabilities: { role: Role; mode: Mode }[];
  launch(request: LaunchRequest): Promise<{ identity: string }>;
  observe(operationId: string): Promise<{ status: 'running' | 'stopped' | 'unknown'; identity: string | null; pendingOutbox?: boolean }>;
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
  removeVerificationWorktree(operationId: string): Promise<{ removed: boolean }>;
  prepareReviewMerge?(input: { goalId: string; repositoryId: string; roundId: string; prHeadSha: string; baseBranch: string }): Promise<{ mergedBaseSha: string; mergeCommitSha: string; conflictPaths: string[] }>;
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
  readPull?(repositoryId: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'closed' | 'merged'; mergeable: MergeableVerdict }>;
  listReviewThreads?(repositoryId: string, number: number): Promise<ReviewThread[]>;
  replyToThread?(repositoryId: string, threadId: string, body: string, options?: { beforeSend?: () => boolean }): Promise<void>;
  resolveThread?(repositoryId: string, threadId: string, options?: { beforeSend?: () => boolean }): Promise<void>;
  identity(repositoryId: string): string;
  find(repositoryId: string, branch: string): Promise<{ number: number; url: string; branch: string; baseBranch: string; headSha: string; marker: string | null; draft: boolean; state: 'open' | 'closed' | 'merged' }[]>;
  ready?(input: PublicationInput, options?: { beforeSend?: () => boolean }): Promise<void | 'unknown' | 'cancelled'>;
  create(input: PublicationInput, options?: { beforeSend?: () => boolean }): Promise<void>;
}
export interface PublicationPort {
  observeMerge?(input: PublicationInput, pr: NonNullable<Goal['pr']>): Promise<{ number: number; url: string; state: 'open' | 'closed' | 'merged'; mergeable: MergeableVerdict }>;
  reviewThreads?(input: PublicationInput, pr: NonNullable<Goal['pr']>): Promise<{ threads: ReviewThread[]; mergeable: MergeableVerdict }>;
  pushFix?(input: PublicationInput, fix: { roundId: string; expectedHead: string; headSha: string }): Promise<'pushed' | 'remote_moved' | 'unknown'>;
  replyAndResolve?(input: PublicationInput, fix: { roundId: string; replies: ReviewReply[] }): Promise<{ posted: string[]; unconfirmed: string[]; resolved: string[] }>;
  publish(input: PublicationInput, options?: { signal?: AbortSignal }): Promise<PublicationResult>;
  observe(input: PublicationInput): Promise<PublicationResult>;
}
