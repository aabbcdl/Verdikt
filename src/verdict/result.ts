import type {
  IntegritySnapshot,
  JudgeCheck,
  JudgeStep,
  JudgeStepResult,
  RunResult,
  TaskSpec,
} from "../types.js";
import type {
  VerdictCheckStatus,
  VerdictCriterion,
  VerdictEvidence,
  VerdictEvidenceKind,
  VerdictFinding,
  VerdictIntegrity,
  VerdictRecommendation,
  VerdictResult,
  VerdictStatus,
} from "./types.js";

export interface BuildVerdictOptions {
  createdAt?: string;
  verdiktVersion?: string;
}

export function buildVerdictResult(
  result: RunResult,
  task: TaskSpec | null,
  options: BuildVerdictOptions = {},
): VerdictResult {
  const iteration = result.iterations.at(-1);
  const judge = iteration?.judge ?? result.partialIteration?.judge;
  const configuredSteps = new Map(
    (task?.acceptance.steps ?? []).map((step) => [step.id, step] as const),
  );
  const { criteria, evidence: commandEvidence } = buildCriteria(
    judge?.checks ?? [],
    judge?.stepResults,
    configuredSteps,
  );
  const agentEvidence = buildAgentEvidence(result);
  const reviewEvidence = buildReviewEvidence(result);
  const evidence = [...commandEvidence, ...reviewEvidence.evidence, ...agentEvidence];
  const integrity = buildIntegrity(result.integritySummary);
  const findings = [...integrity.findings, ...reviewEvidence.findings];
  const scope = buildScope(result);
  const status = resolveStatus(result, criteria, integrity);
  const recommendation = resolveRecommendation(status, result, integrity);
  const requiredCriteria = criteria.filter((criterion) => criterion.required);
  const requiredPassed = requiredCriteria.filter((criterion) => criterion.status === "pass").length;

  return {
    version: 1,
    run: {
      runId: result.runId ?? "unknown",
      taskId: result.taskId ?? task?.id,
      goal: task?.goal,
      repoPath: task?.repoPath ?? result.workspace?.repoPath,
      stopReason: result.reason,
      applyStatus: result.applyStatus,
      totalDurationMs: result.totalDurationMs,
      totalCostUsd: result.totalCostUsd,
      usageStatus: result.usageStatus ?? result.usage?.status ?? "unknown",
    },
    status,
    summary: buildSummary(status, requiredPassed, requiredCriteria.length, criteria, integrity),
    recommendation,
    scope,
    criteria,
    integrity,
    evidence,
    findings,
    provenance: {
      baseCommit: result.workspace?.baseCommit || undefined,
      evidenceManifestPath: result.evidenceManifestPath,
      verdiktVersion: options.verdiktVersion,
    },
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

function buildCriteria(
  checks: JudgeCheck[],
  stepResults: JudgeStepResult[] | undefined,
  configuredSteps: ReadonlyMap<string, JudgeStep>,
): { criteria: VerdictCriterion[]; evidence: VerdictEvidence[] } {
  if (stepResults && stepResults.length > 0) {
    const checksByName = new Map(checks.map((check) => [check.name, check] as const));
    const criteria: VerdictCriterion[] = [];
    const evidence: VerdictEvidence[] = [];
    for (const step of stepResults) {
      const configured = configuredSteps.get(step.id);
      const evidenceId = `command:${step.id}`;
      const status: VerdictCheckStatus = step.passed ? "pass" : step.required ? "fail" : "warning";
      const output = firstUsefulOutput(step.stdout, step.stderr, checksByName.get(step.id)?.output);
      criteria.push({
        id: step.id,
        name: displayName(step.id),
        required: step.required,
        status,
        summary: commandSummary(output, step.exitCode),
        evidenceIds: [evidenceId],
      });
      evidence.push({
        id: evidenceId,
        kind: evidenceKind(step.id),
        source: "verified_execution",
        assurance: "verified",
        title: displayName(step.id),
        summary: commandSummary(output, step.exitCode),
        command: configured
          ? {
              executable: configured.command,
              args: configured.args ?? [],
              exitCode: step.exitCode,
              durationMs: step.durationMs,
            }
          : undefined,
      });
    }
    return { criteria, evidence };
  }

  const criteria: VerdictCriterion[] = [];
  const evidence: VerdictEvidence[] = [];
  for (const check of checks) {
    const configured = configuredSteps.get(check.name);
    const required = configured?.required !== false;
    const evidenceId = `command:${check.name}`;
    criteria.push({
      id: check.name,
      name: displayName(check.name),
      required,
      status: check.passed ? "pass" : required ? "fail" : "warning",
      summary: commandSummary(check.output, check.exitCode),
      evidenceIds: [evidenceId],
    });
    evidence.push({
      id: evidenceId,
      kind: evidenceKind(check.name),
      source: "verified_execution",
      assurance: "verified",
      title: displayName(check.name),
      summary: commandSummary(check.output, check.exitCode),
      command: configured
        ? {
            executable: configured.command,
            args: configured.args ?? [],
            exitCode: check.exitCode,
            durationMs: check.durationMs,
          }
        : undefined,
    });
  }
  return { criteria, evidence };
}

function buildAgentEvidence(result: RunResult): VerdictEvidence[] {
  const evidence: VerdictEvidence[] = [];
  for (const iteration of result.iterations) {
    const summary = limitText(iteration.executorOutput, 500);
    if (!summary) continue;
    evidence.push({
      id: `agent-claim:iteration-${iteration.index}`,
      kind: "claim",
      source: "agent_claim",
      assurance: "claimed",
      title: `Agent report, iteration ${iteration.index + 1}`,
      summary,
    });
  }
  const partialSummary = limitText(result.partialIteration?.executorOutput ?? "", 500);
  if (partialSummary && result.partialIteration) {
    evidence.push({
      id: `agent-claim:iteration-${result.partialIteration.index}`,
      kind: "claim",
      source: "agent_claim",
      assurance: "claimed",
      title: `Agent report, iteration ${result.partialIteration.index + 1}`,
      summary: partialSummary,
    });
  }
  return evidence;
}

function buildReviewEvidence(result: RunResult): {
  evidence: VerdictEvidence[];
  findings: VerdictFinding[];
} {
  const report = result.reviewReport;
  if (!report) return { evidence: [], findings: [] };

  const evidenceId = "review:final";
  return {
    evidence: [
      {
        id: evidenceId,
        kind: "review",
        source: "independent_review",
        assurance: "attested",
        title: "Independent review",
        summary: limitText(report.summary, 500),
      },
    ],
    findings: report.findings.map((finding, index) => ({
      id: `review:${index + 1}`,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      file: finding.file,
      line: finding.line,
      recommendation: finding.recommendation,
      evidenceIds: [evidenceId],
    })),
  };
}

function buildScope(result: RunResult): VerdictResult["scope"] {
  const changedFiles = [
    ...new Set([
      ...result.iterations.flatMap((iteration) => iteration.changedFiles),
      ...(result.partialIteration?.changedFiles ?? []),
    ]),
  ].sort();
  return {
    status: "skipped",
    expectedPaths: [],
    changedFiles,
    outOfScopeFiles: [],
    filesChanged: result.patch?.filesChanged ?? changedFiles.length,
    linesAdded: result.patch?.linesAdded,
    linesDeleted: result.patch?.linesDeleted,
  };
}

function buildIntegrity(snapshot: IntegritySnapshot | undefined): VerdictIntegrity {
  if (!snapshot) {
    return {
      status: "skipped",
      testsModified: null,
      acceptanceWeakened: null,
      evidenceRecorded: false,
      criticalCount: 0,
      warningCount: 0,
      findings: [],
    };
  }

  const findings: VerdictFinding[] = snapshot.issues.map((issue, index) => ({
    id: `integrity:${index + 1}`,
    severity: issue.severity === "critical" ? "critical" : "medium",
    title: displayName(issue.rule),
    detail: issue.detail,
    evidenceIds: [],
  }));
  const rules = new Set(snapshot.issues.map((issue) => issue.rule));
  const testsModified = [...rules].some((rule) => isTestModificationRule(rule));
  const acceptanceWeakened = [...rules].some((rule) => isAcceptanceWeakeningRule(rule));

  return {
    status:
      snapshot.criticalCount > 0
        ? "fail"
        : snapshot.warningCount > 0 || snapshot.status === "violations"
          ? "warning"
          : "pass",
    testsModified,
    acceptanceWeakened,
    evidenceRecorded: true,
    criticalCount: snapshot.criticalCount,
    warningCount: snapshot.warningCount,
    findings,
  };
}

function resolveStatus(
  result: RunResult,
  criteria: VerdictCriterion[],
  integrity: VerdictIntegrity,
): VerdictStatus {
  if (result.reason === "approval_required") return "needs_review";
  if (
    result.reason === "cancelled" ||
    result.reason === "interrupted" ||
    result.reason === "provider_error" ||
    result.reason === "review_incomplete"
  ) {
    return "incomplete";
  }
  if (result.reason === "review_completed") return "needs_review";
  if (integrity.status === "fail") return "fail";

  const required = criteria.filter((criterion) => criterion.required);
  if (required.some((criterion) => criterion.status === "fail")) return "fail";
  if (required.some((criterion) => criterion.status === "needs_review")) return "needs_review";
  if (
    result.reason === "passed" &&
    required.length > 0 &&
    required.every((criterion) => criterion.status === "pass")
  ) {
    return integrity.status === "pass" ? "pass" : "needs_review";
  }
  return "incomplete";
}

function resolveRecommendation(
  status: VerdictStatus,
  result: RunResult,
  integrity: VerdictIntegrity,
): VerdictRecommendation {
  if (result.applyStatus === "discarded" || result.reason === "approval_rejected") return "discard";
  if (status === "pass") return "accept_change";
  if (status === "needs_review") return "human_review";
  if (status === "fail") return integrity.status === "fail" ? "discard" : "continue_fixing";
  if (result.resumable || result.reason === "provider_error" || result.reason === "interrupted") {
    return "continue_fixing";
  }
  return "none";
}

function buildSummary(
  status: VerdictStatus,
  requiredPassed: number,
  requiredTotal: number,
  criteria: VerdictCriterion[],
  integrity: VerdictIntegrity,
): VerdictResult["summary"] {
  if (status === "pass") {
    return {
      title: "可以接受这项修改",
      explanation: `所有 ${requiredTotal} 项必需验收条件均已通过，未发现阻断性的范围或完整性问题。`,
      requiredPassed,
      requiredTotal,
    };
  }
  if (status === "needs_review") {
    return {
      title: "需要人工判断",
      explanation: "至少一项必需条件需要用户确认后才能形成最终结论。",
      requiredPassed,
      requiredTotal,
    };
  }
  if (status === "fail") {
    const failures = criteria.filter(
      (criterion) => criterion.required && criterion.status === "fail",
    ).length;
    return {
      title: "这项修改尚未通过",
      explanation:
        integrity.status === "fail"
          ? "发现阻断性的完整性问题，不能接受这项修改。"
          : `${failures} 项必需验收条件未通过，需要继续修复。`,
      requiredPassed,
      requiredTotal,
    };
  }
  return {
    title: "尚未形成可靠结论",
    explanation: "运行或证据不完整，Verdikt 不能确认这项修改是否可以接受。",
    requiredPassed,
    requiredTotal,
  };
}

function commandSummary(output: string | undefined, exitCode: number): string {
  const summary = outputSummary(output ?? "");
  return summary ? `${summary} · exit ${exitCode}` : `exit ${exitCode}`;
}

function outputSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return limitText(lines.at(-1) ?? "", 240);
}

function firstUsefulOutput(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? "";
}

function evidenceKind(id: string): VerdictEvidenceKind {
  const lower = id.toLowerCase();
  if (lower.includes("test")) return "test";
  if (lower.includes("build") || lower.includes("compile")) return "build";
  if (lower.includes("lint") || lower.includes("format")) return "lint";
  return "command";
}

function displayName(value: string): string {
  return value.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function isTestModificationRule(rule: string): boolean {
  return (
    rule.startsWith("test-file-") ||
    rule === "test-skipped" ||
    rule === "test-focused" ||
    rule.startsWith("assertions-")
  );
}

function isAcceptanceWeakeningRule(rule: string): boolean {
  return (
    rule === "test-script-modified" ||
    rule === "package-scripts-modified" ||
    rule === "test-skipped" ||
    rule === "test-focused" ||
    rule.startsWith("assertions-")
  );
}

function limitText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}
