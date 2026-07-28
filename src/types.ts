/**
 * Core types for Verdikt autonomous iterative coder.
 */

// ── Task Definition ─────────────────────────────────────────────────────────

export interface TaskSpec {
  /** Task behavior. Older tasks default to implementation. */
  taskMode?: "implement" | "review";
  /** Origin of the run for history filtering and trustworthy aggregate statistics. */
  runSource?: RunSource;
  /** Unique task identifier */
  id: string;
  /** Natural-language goal for the executor */
  goal: string;
  /** Optional ordered milestones for larger tasks. Verdikt records progress per stage. */
  stages?: TaskStage[];
  /** Absolute path to the target repository (single-repo mode) */
  repoPath: string;
  /**
   * Allow starting an isolated run even when the repository has uncommitted
   * changes. The workspace is created from HEAD, so those changes are NOT
   * visible to the agent and the final patch cannot be one-click applied —
   * apply-side safety checks will require manual patch handling.
   */
  allowDirtyRepo?: boolean;
  /** M6: Multi-repo mode — paths to multiple repositories (overrides repoPath) */
  repoPaths?: string[];
  /** Acceptance criteria — the objective ground truth */
  acceptance: AcceptanceCriteria;
  /** Max iteration rounds (default 5) */
  maxIterations: number;
  /** Hard budget cap in USD (optional) */
  maxBudgetUsd?: number;
  /** Integrity / anti-cheating policy (optional, defaults to strict) */
  integrity?: IntegrityPolicy;
  /** M4: Semantic risk gate (optional, warning-only if not set) */
  semantic?: SemanticGate;
  /** Agent call timeout and stall handling policy. */
  execution?: ExecutionPolicy;
  /** High-risk task approval policy. */
  riskPolicy?: RiskPolicy;
  /** Optional read-only planning phase before implementation. */
  planning?: PlanningPolicy;
  /** Optional project-local lifecycle checks. */
  hooks?: LifecycleHookSpec[];
}

export type RunSource = "user" | "demo" | "benchmark" | "test" | "unknown";

export type RunAgentPhase =
  | "planning"
  | "reviewing"
  | "executor"
  | "judges"
  | "verifier"
  | "finalizing";

export interface RunPhaseUpdate {
  phase: RunAgentPhase;
  status: "started" | "completed" | "stalled";
  iteration?: number;
  stageId?: string;
  updatedAt: string;
}

export type LifecycleHookEvent =
  | "before_run"
  | "after_plan"
  | "after_executor"
  | "after_judges"
  | "before_apply"
  | "after_run";

export interface LifecycleHookSpec {
  event: LifecycleHookEvent;
  /** JavaScript module path relative to the repository root. */
  script: string;
  timeoutMs?: number;
  failureMode?: "warn" | "block";
}

export interface PlanningPolicy {
  mode?: "off" | "auto" | "required";
  /** Pause for user approval after the plan is produced. */
  requireApproval?: boolean;
}

export interface ExecutionPolicy {
  /** No-output timeout for one agent call. */
  idleTimeoutMs?: number;
  /** Report a suspected stall after this much output silence without stopping the agent. */
  softTimeoutMs?: number;
  /** Absolute wall-clock limit for one agent call. */
  hardTimeoutMs?: number;
}

export interface TaskStage {
  /** Stable stage identifier */
  id: string;
  /** Human-readable stage title */
  title: string;
  /** What this stage should accomplish before moving on */
  goal: string;
  /** Optional objective checks that must pass before this stage advances. */
  acceptance?: AcceptanceCriteria;
  /** Maximum attempts allowed inside this stage. */
  maxIterations?: number;
  /** Maximum cost allowed inside this stage. */
  maxBudgetUsd?: number;
  /** Always pause for approval before entering this stage. */
  requireApproval?: boolean;
  /** Explicit high-risk categories attached to this stage. */
  riskCategories?: RiskCategory[];
}

export type RiskCategory =
  | "deployment"
  | "database"
  | "production"
  | "secrets"
  | "external_write"
  | "destructive"
  | "outside_repo"
  | "manual";

export interface RiskPolicy {
  mode?: "confirm" | "deny" | "allow";
  approvedCategories?: RiskCategory[];
  declaredCategories?: RiskCategory[];
}

export interface StageRuntimeState {
  stageIndex: number;
  stageIteration: number;
  stageCostUsd: number;
  completedStageIds: string[];
}

export interface ApprovalAction {
  signature: string;
  command: string;
  tool: string;
  cwd?: string;
}

export interface ApprovalRequest {
  categories: RiskCategory[];
  reason: string;
  stageId?: string;
  action?: ApprovalAction;
}

export interface AcceptanceCriteria {
  /** Command that must exit 0 for the task to be "done" (simple mode, optional if steps is provided) */
  testCommand?: string;
  /** Optional build/lint command */
  buildCommand?: string;
  /** Optional lint command */
  lintCommand?: string;
  /** Timeout in ms for legacy commands (default: 120000 = 2 minutes) */
  timeoutMs?: number;
  /** M4.2: Structured judge steps (overrides testCommand/buildCommand/lintCommand when present) */
  steps?: JudgeStep[];
  /** M6: Custom judge script (overrides all above when present) */
  custom?: CustomJudge;
}

/** M6: Custom judge plugin configuration */
export interface CustomJudge {
  /** Path to the judge script, relative to repo root */
  script: string;
  /** Optional timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Optional environment variables to pass to the script */
  env?: Record<string, string>;
}

/** M4.2: A single structured judge step */
export interface JudgeStep {
  /** Step identifier (e.g., "test", "typecheck", "lint") */
  id: string;
  /** Command to execute */
  command: string;
  /** Arguments (executed via execFile, no shell) */
  args?: string[];
  /** Working directory (defaults to repoPath) */
  cwd?: string;
  /** Whether this step is required (default true). Optional steps don't block on failure. */
  required?: boolean;
  /** Timeout in ms for this step (default: 120000 = 2 minutes) */
  timeoutMs?: number;
}

/** M6: Expected result from a custom judge script */
export interface CustomJudgeResult {
  /** Whether the task passed */
  passed: boolean;
  /** Human-readable summary */
  summary: string;
  /** Optional detailed findings */
  details?: Array<{ name: string; passed: boolean; message: string }>;
}

/** M4.2: Result of a single judge step */
export interface JudgeStepResult {
  id: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  required: boolean;
}

/** Task-level integrity policy */
export interface IntegrityPolicy {
  /** Enable integrity checks (default true) */
  enabled?: boolean;
  /** Allow executor to modify test files (default false) */
  allowTestChanges?: boolean;
  /** Allow executor to modify config files like tsconfig, vitest.config (default false) */
  allowConfigChanges?: boolean;
  /** Allow executor to modify package.json test script (default false) */
  allowPackageScriptChanges?: boolean;
  /** Glob patterns for files that are always protected (critical violation if modified) */
  protectedGlobs?: string[];
  /** Glob patterns for files that trigger warnings if modified */
  suspiciousGlobs?: string[];
}

/** M4: Semantic risk gate for hard benchmarks */
export interface SemanticGate {
  /** Maximum allowed risk level. If exceeded, iteration fails. */
  maxRisk: "none" | "low" | "medium" | "high";
}

// ── Judge (Objective Verdict) ────────────────────────────────────────────────

export interface JudgeResult {
  /** true only if every check passed */
  passed: boolean;
  /** Individual check outcomes */
  checks: JudgeCheck[];
  /** M4.2: Structured step results (when using steps mode) */
  stepResults?: JudgeStepResult[];
}

export interface JudgeCheck {
  name: string;
  passed: boolean;
  /** Raw stdout+stderr from the command */
  output: string;
  /** Process exit code */
  exitCode: number;
  /** Duration in ms */
  durationMs: number;
}

// ── Verifier Verdict ─────────────────────────────────────────────────────────

export interface VerifierVerdict {
  /** Does the verifier think the task is done? (NOT the final say — judge is) */
  done: boolean;
  /** Concrete unmet acceptance points */
  problems: string[];
  /** Actionable instruction for the next executor round */
  nextInstruction: string;
}

// ── Iteration Record ─────────────────────────────────────────────────────────

export interface IterationRecord {
  /** Zero-based iteration index */
  index: number;
  /** Optional task stage active during this iteration */
  stageId?: string;
  /** One-based attempt number within the active stage. */
  stageIteration?: number;
  /** What the executor did (free-form text from Claude) */
  executorOutput: string;
  /** Files that changed in this iteration */
  changedFiles: string[];
  /** Objective judge results */
  judge: JudgeResult;
  /** Verifier's interpretation */
  verifierVerdict: VerifierVerdict;
  /** Tokens used (if reported) */
  tokensUsed?: number;
  /** Cost in USD (if reported) */
  costUsd?: number;
  /** Whether cost and token accounting is complete. */
  usageStatus?: UsageStatus;
  /** Detailed usage when reported by the agent provider. */
  usage?: UsageSummary;
  /** Wall-clock duration for this iteration in ms */
  durationMs: number;
  /** Git commit created after this iteration for rewind/fork. */
  checkpointCommit?: string;
  /** M3: Patch file path for this iteration */
  patchPath?: string;
  /** M3: Integrity check result for this iteration */
  integrity?: IntegritySnapshot;
  /** M3: Judge exit code summary */
  judgeExitCode?: number;
  /** M3: Lines added/deleted in this iteration */
  linesAdded?: number;
  linesDeleted?: number;
}

export interface PartialIterationRecord {
  index: number;
  stageId?: string;
  stageIteration?: number;
  executorOutput?: string;
  executorDurationMs?: number;
  executorUsage?: UsageSummary;
  preExecutorCommit?: string;
  changedFiles?: string[];
  patchPath?: string;
  checkpointCommit?: string;
  linesAdded?: number;
  linesDeleted?: number;
  integrity?: IntegritySnapshot;
  judge?: JudgeResult;
  verifierVerdict?: VerifierVerdict;
  verifierUsage?: UsageSummary;
  providerError?: ProviderErrorSummary;
}

export interface IntegritySnapshot {
  status: "ok" | "violations";
  criticalCount: number;
  warningCount: number;
  issues: Array<{
    rule: string;
    detail: string;
    severity?: "critical" | "warning";
  }>;
}

// ── Stop Condition ───────────────────────────────────────────────────────────

export type StopReason =
  | "passed" // All judge checks green
  | "max_iterations" // Hit iteration cap
  | "budget_exceeded" // Hit USD budget cap
  | "no_progress" // Stuck — consecutive identical failures
  | "cancelled" // User cancelled the run
  | "interrupted" // App stopped; saved state can be resumed
  | "stage_failed"
  | "approval_required"
  | "approval_rejected"
  | "provider_error"
  | "review_completed"
  | "review_incomplete";

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  recommendation: string;
}

export interface ReviewReport {
  summary: string;
  verdict: "clean" | "issues_found" | "incomplete";
  findings: ReviewFinding[];
  acceptance?: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; output?: string }>;
  };
}

export interface RunResult {
  reason: StopReason;
  iterations: IterationRecord[];
  totalDurationMs: number;
  totalCostUsd: number;
  /** Whether total cost and token accounting is complete. */
  usageStatus?: UsageStatus;
  /** Aggregated usage across executor and verifier calls. */
  usage?: UsageSummary;
  /** M3: Run identifier */
  runId?: string;
  /** M3: Task identifier */
  taskId?: string;
  /** M3: Workspace metadata */
  workspace?: WorkspaceMeta;
  /** M3: Final patch metadata */
  patch?: PatchMeta;
  /** M3: Integrity summary across all iterations */
  integritySummary?: IntegritySnapshot;
  /** M3: Apply/discard status */
  applyStatus?: "applied" | "discarded" | "pending";
  /** M4: Semantic risk assessment of the final patch */
  semanticRisk?: SemanticRiskSummary;
  /** Stage progress at the time the run stopped. */
  stageProgress?: StageRuntimeState;
  /** Pending approval when reason is approval_required. */
  approvalRequest?: ApprovalRequest;
  /** Path to the tamper-evident evidence manifest. */
  evidenceManifestPath?: string;
  /** Structured result for read-only code review tasks. */
  reviewReport?: ReviewReport;
  /** True when the run intentionally did not modify files. */
  reviewOnly?: boolean;
  /** Facts already completed in the active iteration when the run stopped. */
  partialIteration?: PartialIterationRecord;
  /** True when state and an isolated workspace were preserved for a safe continuation. */
  resumable?: boolean;
  /** Provider failure details when the agent could not start or complete a request. */
  providerError?: ProviderErrorSummary;
  /** Agent phase active when the run stopped. */
  currentPhase?: RunAgentPhase;
}

export interface SemanticRiskSummary {
  level: "none" | "low" | "medium" | "high";
  findingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  topFindings: Array<{ rule: string; detail: string; file: string; snippet: string }>;
}

export interface WorkspaceMeta {
  path: string;
  baseCommit: string;
  originalRepoCleanBeforeApply: boolean;
  mode: "isolated" | "direct";
  repoPath?: string;
  repoHead?: string;
  repoStatus?: string;
  repoFingerprint?: string;
  branchName?: string;
  setupDurationMs?: number;
  warmed?: boolean;
}

export interface PatchMeta {
  finalPatchPath?: string;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
}

// ── Claude Driver ────────────────────────────────────────────────────────────

export type UsageStatus = "complete" | "partial" | "unknown";

export interface UsageSummary {
  status: UsageStatus;
  costUsd?: number;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  modelCalls?: number;
}

export interface DriverInput {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  allowedTools?: string[];
  commandPolicy?: {
    repoRoot: string;
    approvedCategories: RiskCategory[];
    allowAll?: boolean;
    runDir?: string;
  };
  timeoutMs?: number;
  softTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  signal?: AbortSignal;
}

export type ProviderErrorCategory =
  | "authentication"
  | "insufficient_credit"
  | "rate_limited"
  | "service_unavailable"
  | "configuration"
  | "unknown";

export interface ProviderErrorSummary {
  category: ProviderErrorCategory;
  statusCode?: number;
  message: string;
  retryable: boolean;
}

export interface DriverFailure {
  kind: "provider_error" | "process_error";
  category?: ProviderErrorCategory;
  statusCode?: number;
  message: string;
  retryable: boolean;
}

export interface DriverOutput {
  /** Claude's final text response */
  text: string;
  /** Reported cost in USD, if available */
  costUsd?: number;
  /** Cost/token completeness and details. */
  usage?: UsageSummary;
  /** Whether the call timed out */
  timedOut: boolean;
  /** Wall-clock duration */
  durationMs: number;
  /** Structured failure information when Claude could not complete the request. */
  failure?: DriverFailure;
}
