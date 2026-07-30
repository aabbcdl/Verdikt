import type { StopReason, UsageStatus } from "../types.js";

export type VerdictStatus = "pass" | "fail" | "needs_review" | "incomplete";

export type VerdictCheckStatus = "pass" | "fail" | "needs_review" | "warning" | "skipped";

export type VerdictRecommendation =
  | "accept_change"
  | "continue_fixing"
  | "human_review"
  | "discard"
  | "none";

export type VerdictEvidenceSource =
  | "verified_execution"
  | "diff_inspection"
  | "independent_review"
  | "agent_claim"
  | "user_confirmation";

export type VerdictEvidenceAssurance = "verified" | "attested" | "claimed";

export type VerdictEvidenceKind =
  | "command"
  | "test"
  | "build"
  | "lint"
  | "diff"
  | "file"
  | "review"
  | "artifact"
  | "claim";

export interface VerdictRun {
  runId: string;
  taskId?: string;
  goal?: string;
  repoPath?: string;
  stopReason: StopReason;
  applyStatus?: "applied" | "discarded" | "pending";
  totalDurationMs: number;
  totalCostUsd?: number;
  usageStatus: UsageStatus;
}

export interface VerdictSummary {
  title: string;
  explanation: string;
  requiredPassed: number;
  requiredTotal: number;
}

export interface VerdictScope {
  status: VerdictCheckStatus;
  expectedPaths: string[];
  changedFiles: string[];
  outOfScopeFiles: string[];
  filesChanged: number;
  linesAdded?: number;
  linesDeleted?: number;
}

export interface VerdictCriterion {
  id: string;
  name: string;
  description?: string;
  required: boolean;
  status: VerdictCheckStatus;
  summary: string;
  evidenceIds: string[];
}

export interface VerdictEvidence {
  id: string;
  kind: VerdictEvidenceKind;
  source: VerdictEvidenceSource;
  assurance: VerdictEvidenceAssurance;
  title: string;
  summary: string;
  command?: {
    executable: string;
    args: string[];
    exitCode: number;
    durationMs: number;
  };
  artifactPath?: string;
  timestamp?: string;
}

export interface VerdictFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  file?: string;
  line?: number;
  recommendation?: string;
  evidenceIds: string[];
}

export interface VerdictIntegrity {
  status: VerdictCheckStatus;
  testsModified: boolean | null;
  acceptanceWeakened: boolean | null;
  evidenceRecorded: boolean;
  criticalCount: number;
  warningCount: number;
  findings: VerdictFinding[];
}

export interface VerdictProvenance {
  baseCommit?: string;
  resultCommit?: string;
  evidenceManifestPath?: string;
  verdiktVersion?: string;
}

export interface VerdictResult {
  version: 1;
  run: VerdictRun;
  status: VerdictStatus;
  summary: VerdictSummary;
  recommendation: VerdictRecommendation;
  scope: VerdictScope;
  criteria: VerdictCriterion[];
  integrity: VerdictIntegrity;
  evidence: VerdictEvidence[];
  findings: VerdictFinding[];
  provenance: VerdictProvenance;
  createdAt: string;
}
