import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerdictEvidence, VerdictFinding, VerdictResult } from "./types.js";

export type VerdictReadResult =
  | { status: "ok"; verdict: VerdictResult }
  | { status: "missing" }
  | { status: "unsupported"; version: unknown }
  | { status: "invalid"; error: string };

const VERDICT_STATUSES = ["pass", "fail", "needs_review", "incomplete"] as const;
const CHECK_STATUSES = ["pass", "fail", "needs_review", "warning", "skipped"] as const;
const RECOMMENDATIONS = [
  "accept_change",
  "continue_fixing",
  "human_review",
  "discard",
  "none",
] as const;
const EVIDENCE_KINDS = [
  "command",
  "test",
  "build",
  "lint",
  "diff",
  "file",
  "review",
  "artifact",
  "claim",
] as const;
const EVIDENCE_SOURCES = [
  "verified_execution",
  "diff_inspection",
  "independent_review",
  "agent_claim",
  "user_confirmation",
] as const;
const EVIDENCE_ASSURANCE = ["verified", "attested", "claimed"] as const;
const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
const STOP_REASONS = [
  "passed",
  "max_iterations",
  "budget_exceeded",
  "no_progress",
  "cancelled",
  "interrupted",
  "stage_failed",
  "approval_required",
  "approval_rejected",
  "provider_error",
  "review_completed",
  "review_incomplete",
] as const;

export async function readVerdictResult(runDir: string): Promise<VerdictReadResult> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "verdict.json"), "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "missing" };
    return { status: "invalid", error: "Verdict result could not be read" };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", error: "Verdict result is not valid JSON" };
  }

  const version = isRecord(value) ? value.version : undefined;
  if (version !== 1) return { status: "unsupported", version };
  if (!isVerdictResult(value)) {
    return { status: "invalid", error: "Verdict result does not match version 1" };
  }

  const consistency = await validateSummaryPair(runDir, value.resultId);
  if (!consistency.valid) return { status: "invalid", error: consistency.error };
  return { status: "ok", verdict: value };
}

/** Validate the persisted contract, including all nested objects and references. */
export function isVerdictResult(value: unknown): value is VerdictResult {
  if (!isRecord(value) || value.version !== 1) return false;
  if (value.resultId !== undefined && !isNonEmptyString(value.resultId)) return false;
  if (!isRun(value.run) || !isStatus(value.status)) return false;
  if (!isSummary(value.summary) || !isRecommendation(value.recommendation)) return false;
  if (!isScope(value.scope) || !isIntegrity(value.integrity)) return false;
  if (!Array.isArray(value.criteria) || !value.criteria.every(isCriterion)) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) return false;
  if (!Array.isArray(value.findings) || !value.findings.every(isFinding)) return false;
  if (!isProvenance(value.provenance) || !isIsoDate(value.createdAt)) return false;

  if (new Set(value.criteria.map((criterion) => criterion.id)).size !== value.criteria.length) {
    return false;
  }
  if (new Set(value.findings.map((finding) => finding.id)).size !== value.findings.length) {
    return false;
  }
  const evidenceIds = new Set(value.evidence.map((evidence) => evidence.id));
  if (evidenceIds.size !== value.evidence.length) return false;
  if (
    !value.criteria.every((criterion) => criterion.evidenceIds.every((id) => evidenceIds.has(id)))
  ) {
    return false;
  }
  if (!value.findings.every((finding) => finding.evidenceIds.every((id) => evidenceIds.has(id)))) {
    return false;
  }
  if (
    !value.integrity.findings.every((finding) =>
      finding.evidenceIds.every((id) => evidenceIds.has(id)),
    )
  ) {
    return false;
  }

  // PASS is intentionally strict: it needs objective criteria, integrity proof,
  // and a recommendation that cannot be mistaken for a provisional result.
  if (value.status === "pass") {
    const required = value.criteria.filter((criterion) => criterion.required);
    if (
      value.recommendation !== "accept_change" ||
      required.length === 0 ||
      required.some((criterion) => criterion.status !== "pass") ||
      value.integrity.status !== "pass" ||
      !value.integrity.evidenceRecorded ||
      value.integrity.criticalCount !== 0 ||
      value.scope.status === "fail" ||
      value.summary.requiredPassed !== required.length ||
      value.summary.requiredTotal !== required.length
    ) {
      return false;
    }
  }
  return true;
}

async function validateSummaryPair(
  runDir: string,
  verdictResultId: string | undefined,
): Promise<{ valid: true } | { valid: false; error: string }> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "summary.json"), "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return { valid: true };
    return { valid: false, error: "Summary result could not be read" };
  }

  let summary: unknown;
  try {
    summary = JSON.parse(raw);
  } catch {
    return { valid: false, error: "Summary result is not valid JSON" };
  }
  if (!isRecord(summary)) return { valid: false, error: "Summary result is not an object" };
  const summaryResultId = summary.resultId;
  if (summaryResultId !== undefined && !isNonEmptyString(summaryResultId)) {
    return { valid: false, error: "Summary result ID is invalid" };
  }
  if (summaryResultId !== verdictResultId) {
    if (summaryResultId !== undefined || verdictResultId !== undefined) {
      return { valid: false, error: "Summary and verdict results are from different writes" };
    }
  }
  return { valid: true };
}

function isRun(value: unknown): value is VerdictResult["run"] {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.runId) &&
    isOneOf(value.stopReason, STOP_REASONS) &&
    isNonNegativeNumber(value.totalDurationMs) &&
    isOneOf(value.usageStatus, ["complete", "partial", "unknown"] as const) &&
    optionalNonNegativeNumber(value.totalCostUsd) &&
    optionalString(value.taskId) &&
    optionalString(value.goal) &&
    optionalString(value.repoPath) &&
    isOneOf(value.applyStatus, ["applied", "discarded", "pending"] as const, true)
  );
}

function isSummary(value: unknown): value is VerdictResult["summary"] {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.title) &&
    typeof value.explanation === "string" &&
    isCount(value.requiredPassed) &&
    isCount(value.requiredTotal) &&
    value.requiredPassed <= value.requiredTotal
  );
}

function isScope(value: unknown): value is VerdictResult["scope"] {
  if (!isRecord(value)) return false;
  return (
    isOneOf(value.status, CHECK_STATUSES) &&
    isStringArray(value.expectedPaths) &&
    isStringArray(value.changedFiles) &&
    isStringArray(value.outOfScopeFiles) &&
    isCount(value.filesChanged) &&
    optionalCount(value.linesAdded) &&
    optionalCount(value.linesDeleted)
  );
}

function isCriterion(value: unknown): value is VerdictResult["criteria"][number] {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    optionalString(value.description) &&
    typeof value.required === "boolean" &&
    isOneOf(value.status, CHECK_STATUSES) &&
    typeof value.summary === "string" &&
    isNonEmptyStringArray(value.evidenceIds, value.status !== "skipped")
  );
}

function isIntegrity(value: unknown): value is VerdictResult["integrity"] {
  if (!isRecord(value)) return false;
  return (
    isOneOf(value.status, CHECK_STATUSES) &&
    isBooleanOrNull(value.testsModified) &&
    isBooleanOrNull(value.acceptanceWeakened) &&
    typeof value.evidenceRecorded === "boolean" &&
    isCount(value.criticalCount) &&
    isCount(value.warningCount) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding)
  );
}

function isEvidence(value: unknown): value is VerdictEvidence {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    !isOneOf(value.kind, EVIDENCE_KINDS) ||
    !isOneOf(value.source, EVIDENCE_SOURCES) ||
    !isOneOf(value.assurance, EVIDENCE_ASSURANCE) ||
    !isNonEmptyString(value.title) ||
    typeof value.summary !== "string" ||
    !optionalString(value.artifactPath) ||
    !optionalString(value.timestamp)
  ) {
    return false;
  }
  if (value.timestamp !== undefined && !isIsoDate(value.timestamp)) return false;
  if (value.command === undefined) return true;
  if (!isRecord(value.command)) return false;
  return (
    isNonEmptyString(value.command.executable) &&
    isStringArray(value.command.args) &&
    isInteger(value.command.exitCode) &&
    isNonNegativeNumber(value.command.durationMs)
  );
}

function isFinding(value: unknown): value is VerdictFinding {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isOneOf(value.severity, FINDING_SEVERITIES) &&
    isNonEmptyString(value.title) &&
    typeof value.detail === "string" &&
    optionalString(value.file) &&
    optionalCount(value.line) &&
    optionalString(value.recommendation) &&
    isNonEmptyStringArray(value.evidenceIds, true)
  );
}

function isProvenance(value: unknown): value is VerdictResult["provenance"] {
  if (!isRecord(value)) return false;
  return (
    optionalString(value.baseCommit) &&
    optionalString(value.resultCommit) &&
    optionalString(value.evidenceManifestPath) &&
    optionalString(value.verdiktVersion)
  );
}

function isStatus(value: unknown): value is VerdictResult["status"] {
  return isOneOf(value, VERDICT_STATUSES);
}

function isRecommendation(value: unknown): value is VerdictResult["recommendation"] {
  return isOneOf(value, RECOMMENDATIONS);
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return typeof value === "boolean" || value === null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown, required: boolean): value is string[] {
  return isStringArray(value) && (!required || value.length > 0) && value.every(isNonEmptyString);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function optionalCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  values: T,
  optional = false,
): value is T[number] | undefined {
  return (
    (optional && value === undefined) ||
    (typeof value === "string" && values.includes(value as T[number]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
