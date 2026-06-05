/**
 * Core types for Verdikt autonomous iterative coder.
 */

// ── Task Definition ─────────────────────────────────────────────────────────

export interface TaskSpec {
  /** Unique task identifier */
  id: string;
  /** Natural-language goal for the executor */
  goal: string;
  /** Absolute path to the target repository (single-repo mode) */
  repoPath: string;
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
}

export interface AcceptanceCriteria {
  /** Command that must exit 0 for the task to be "done" (simple mode, optional if steps is provided) */
  testCommand?: string;
  /** Optional build/lint command */
  buildCommand?: string;
  /** Optional lint command */
  lintCommand?: string;
  /** M4.2: Structured judge steps (overrides testCommand/buildCommand/lintCommand when present) */
  steps?: JudgeStep[];
  /** M6: Custom judge script (overrides all above when present) */
  custom?: CustomJudge;
}

/** M6: Custom judge plugin configuration */
export interface CustomJudge {
  /** Path to the judge script (relative to repo root or absolute) */
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
  /** Wall-clock duration for this iteration in ms */
  durationMs: number;
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

export interface IntegritySnapshot {
  status: "ok" | "violations";
  criticalCount: number;
  warningCount: number;
  issues: Array<{ rule: string; detail: string }>;
}

// ── Stop Condition ───────────────────────────────────────────────────────────

export type StopReason =
  | "passed" // All judge checks green
  | "max_iterations" // Hit iteration cap
  | "budget_exceeded" // Hit USD budget cap
  | "no_progress"; // Stuck — consecutive identical failures

export interface RunResult {
  reason: StopReason;
  iterations: IterationRecord[];
  totalDurationMs: number;
  totalCostUsd: number;
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
}

export interface PatchMeta {
  finalPatchPath?: string;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
}

// ── Claude Driver ────────────────────────────────────────────────────────────

export interface DriverInput {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  allowedTools?: string[];
  timeoutMs?: number;
}

export interface DriverOutput {
  /** Claude's final text response */
  text: string;
  /** Reported cost in USD, if available */
  costUsd?: number;
  /** Whether the call timed out */
  timedOut: boolean;
  /** Wall-clock duration */
  durationMs: number;
}
