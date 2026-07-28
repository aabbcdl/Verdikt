import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPathInside, isValidRunId } from "./localServer.js";

export interface PatchFileReview {
  path: string;
  additions: number;
  deletions: number;
  kind: "source" | "test" | "config" | "dependency" | "docs" | "other";
}

export interface PatchReview {
  available: boolean;
  reason?: string;
  files: PatchFileReview[];
  patchText: string;
  warnings: string[];
  truncated: boolean;
  risk: PatchRiskReview;
  integrity?: unknown;
  semanticRisk?: unknown;
}

export interface PatchRiskReview {
  level: "low" | "medium" | "high";
  verdict: string;
  reasons: string[];
  applyChecklist: string[];
}

const MAX_PATCH_CHARS = 80_000;

export async function readPatchReview(stateDirInput: string, runId: string): Promise<PatchReview> {
  const stateDir = resolve(stateDirInput);
  if (!isValidRunId(runId)) {
    return emptyReview("Invalid run ID");
  }

  const runDir = resolve(stateDir, runId);
  const patchPath = join(runDir, "evidence", "final.patch");
  const summaryPath = join(runDir, "summary.json");

  if (!isPathInside(stateDir, runDir) || !isPathInside(stateDir, patchPath)) {
    return emptyReview("Access denied");
  }

  if (!existsSync(patchPath)) {
    return emptyReview("No final patch is available for this run.");
  }

  const [patchTextRaw, summary] = await Promise.all([
    readFile(patchPath, "utf-8"),
    readSummary(summaryPath),
  ]);
  const files = parsePatchFiles(patchTextRaw);
  const warnings = buildPatchWarnings(files, summary);
  const risk = buildPatchRisk(files, summary, warnings);
  const truncated = patchTextRaw.length > MAX_PATCH_CHARS;
  const patchText = truncated
    ? `${patchTextRaw.slice(0, MAX_PATCH_CHARS)}\n\n... patch truncated for display ...`
    : patchTextRaw;

  return {
    available: true,
    files,
    patchText,
    warnings,
    truncated,
    risk,
    integrity: isRecord(summary) ? summary.integrity : undefined,
    semanticRisk: isRecord(summary) ? summary.semanticRisk : undefined,
  };
}

function emptyReview(reason: string): PatchReview {
  return {
    available: false,
    reason,
    files: [],
    patchText: "",
    warnings: [],
    truncated: false,
    risk: {
      level: "low",
      verdict: "暂无可审查补丁。",
      reasons: [reason],
      applyChecklist: ["先等待任务通过并生成补丁。"],
    },
  };
}

async function readSummary(summaryPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(summaryPath, "utf-8"));
  } catch {
    return null;
  }
}

function parsePatchFiles(patchText: string): PatchFileReview[] {
  const files = new Map<string, PatchFileReview>();
  let currentPath = "";

  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      if (!files.has(currentPath)) {
        files.set(currentPath, {
          path: currentPath,
          additions: 0,
          deletions: 0,
          kind: classifyFile(currentPath),
        });
      }
      continue;
    }
    if (!currentPath) continue;

    const file = files.get(currentPath);
    if (!file) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) file.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) file.deletions += 1;
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function classifyFile(filePath: string): PatchFileReview["kind"] {
  const lower = filePath.toLowerCase();
  if (/\.(test|spec)\./.test(lower) || lower.includes("/test/") || lower.includes("\\test\\")) {
    return "test";
  }
  if (
    lower.endsWith("package.json") ||
    lower.endsWith("package-lock.json") ||
    lower.endsWith("pnpm-lock.yaml") ||
    lower.endsWith("yarn.lock")
  ) {
    return "dependency";
  }
  if (
    lower.includes("config") ||
    lower.endsWith("tsconfig.json") ||
    lower.endsWith("biome.json") ||
    lower.endsWith(".env")
  ) {
    return "config";
  }
  if (lower.endsWith(".md") || lower.startsWith("docs/")) {
    return "docs";
  }
  if (lower.startsWith("src/") || lower.startsWith("app/") || lower.startsWith("lib/")) {
    return "source";
  }
  return "other";
}

function buildPatchWarnings(files: PatchFileReview[], summary: unknown): string[] {
  const warnings: string[] = [];
  if (files.some((file) => file.kind === "test")) {
    warnings.push("补丁包含测试文件改动，应用前请确认不是为了绕过验收。");
  }
  if (files.some((file) => file.kind === "dependency")) {
    warnings.push("补丁包含依赖或锁文件改动，应用后建议重新安装依赖并运行完整检查。");
  }
  if (files.some((file) => file.kind === "config")) {
    warnings.push("补丁包含配置改动，应用前请确认不会影响项目其他流程。");
  }

  if (isRecord(summary)) {
    const integrity = isRecord(summary.integrity) ? summary.integrity : null;
    const criticalCount =
      typeof integrity?.criticalCount === "number" ? integrity.criticalCount : 0;
    if (criticalCount > 0) {
      warnings.push(`完整性检查发现 ${criticalCount} 个严重问题。`);
    }

    const semanticRisk = isRecord(summary.semanticRisk) ? summary.semanticRisk : null;
    const level = typeof semanticRisk?.level === "string" ? semanticRisk.level : "none";
    if (level !== "none") {
      warnings.push(`语义风险扫描结果为 ${level}，应用前请重点查看风险提示。`);
    }
  }

  return warnings;
}

function buildPatchRisk(
  files: PatchFileReview[],
  summary: unknown,
  warnings: string[],
): PatchRiskReview {
  const reasons: string[] = [];
  let score = 0;

  if (files.length === 0) {
    return {
      level: "low",
      verdict: "补丁为空或没有识别到文件改动。",
      reasons: ["没有文件级改动可审查。"],
      applyChecklist: ["确认任务确实已经完成。", "必要时打开详情页查看每轮记录。"],
    };
  }

  const sourceCount = files.filter((file) => file.kind === "source").length;
  const testCount = files.filter((file) => file.kind === "test").length;
  const dependencyCount = files.filter((file) => file.kind === "dependency").length;
  const configCount = files.filter((file) => file.kind === "config").length;
  const totalLines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);

  if (sourceCount > 0) reasons.push(`改动了 ${sourceCount} 个源码文件。`);
  if (testCount > 0) {
    score += 2;
    reasons.push(`改动了 ${testCount} 个测试文件，需要确认不是为了绕过验收。`);
  }
  if (dependencyCount > 0) {
    score += 2;
    reasons.push(`改动了 ${dependencyCount} 个依赖或锁文件，应用后要重新安装和检查。`);
  }
  if (configCount > 0) {
    score += 1;
    reasons.push(`改动了 ${configCount} 个配置文件，可能影响项目其他流程。`);
  }
  if (totalLines > 400) {
    score += 2;
    reasons.push(`补丁规模较大，共 ${totalLines} 行增删。`);
  } else if (totalLines > 120) {
    score += 1;
    reasons.push(`补丁规模中等，共 ${totalLines} 行增删。`);
  }

  if (isRecord(summary)) {
    const integrity = isRecord(summary.integrity) ? summary.integrity : null;
    const criticalCount =
      typeof integrity?.criticalCount === "number" ? integrity.criticalCount : 0;
    if (criticalCount > 0) {
      score += 3;
      reasons.push(`完整性检查发现 ${criticalCount} 个严重问题。`);
    }

    const semanticRisk = isRecord(summary.semanticRisk) ? summary.semanticRisk : null;
    const semanticLevel = typeof semanticRisk?.level === "string" ? semanticRisk.level : "none";
    if (semanticLevel === "high") {
      score += 3;
      reasons.push("语义风险扫描为高风险。");
    } else if (semanticLevel === "medium") {
      score += 2;
      reasons.push("语义风险扫描为中风险。");
    } else if (semanticLevel === "low") {
      score += 1;
      reasons.push("语义风险扫描发现低风险提示。");
    }
  }

  if (warnings.length > 0 && reasons.length === 0) {
    reasons.push(...warnings);
  }
  if (reasons.length === 0) {
    reasons.push("只识别到常规源码或文档改动，没有额外风险提示。");
  }

  if (score >= 4) {
    return {
      level: "high",
      verdict: "高风险补丁。应用前不要直接点击应用，先逐项确认风险原因。",
      reasons,
      applyChecklist: [
        "不要直接应用，先打开详情页确认最后一轮审查意见。",
        "逐个查看测试、依赖、配置或高风险文件。",
        "确认验收命令没有被削弱，再考虑应用补丁。",
      ],
    };
  }

  if (score >= 2) {
    return {
      level: "medium",
      verdict: "中等风险补丁。可以应用，但应先重点看风险文件。",
      reasons,
      applyChecklist: [
        "先查看风险原因对应的文件。",
        "确认验收命令和审查意见都通过。",
        "应用后在原项目重新跑一次主要检查。",
      ],
    };
  }

  return {
    level: "low",
    verdict: "风险较低。仍建议先看一遍改动范围，再应用补丁。",
    reasons,
    applyChecklist: [
      "确认改动文件符合任务目标。",
      "确认验收命令和审查 agent 都已经通过。",
      "应用后在原项目重新跑一次关键检查。",
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
