import { type StreamCallbacks, callClaude } from "../claude/driver.js";
import type { DriverOutput, ReviewFinding, ReviewReport, TaskSpec } from "../types.js";
import { REVIEWER_SYSTEM } from "./prompts.js";

export interface ReviewerOutput extends DriverOutput {
  report: ReviewReport;
}

export async function runReviewer(
  task: TaskSpec,
  streamCallbacks?: StreamCallbacks,
  signal?: AbortSignal,
): Promise<ReviewerOutput> {
  const output = await callClaude(
    {
      systemPrompt: REVIEWER_SYSTEM,
      userPrompt: [
        "## Review goal",
        task.goal,
        "",
        "## Repository",
        task.repoPath,
        "",
        "Inspect the code and return the required JSON report. Do not modify any file.",
      ].join("\n"),
      cwd: task.repoPath,
      allowedTools: ["Read", "Glob", "Grep"],
      timeoutMs: task.execution?.idleTimeoutMs,
      softTimeoutMs: task.execution?.softTimeoutMs,
      absoluteTimeoutMs: task.execution?.hardTimeoutMs,
      signal,
    },
    streamCallbacks,
  );
  return {
    ...output,
    report: output.failure
      ? { summary: output.failure.message, verdict: "incomplete", findings: [] }
      : parseReviewReport(output.text),
  };
}

export function parseReviewReport(text: string): ReviewReport {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const embedded = extractJsonObject(raw);
    if (!embedded) return parseMarkdownReview(raw);
    try {
      parsed = JSON.parse(embedded);
    } catch {
      return parseMarkdownReview(raw);
    }
  }
  if (!isRecord(parsed)) {
    return { summary: "审查输出不是有效报告。", verdict: "incomplete", findings: [] };
  }
  const verdict = ["clean", "issues_found", "incomplete"].includes(String(parsed.verdict))
    ? (parsed.verdict as ReviewReport["verdict"])
    : "incomplete";
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(normalizeFinding).filter((item): item is ReviewFinding => item !== null)
    : [];
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : verdict === "clean"
        ? "未发现明确问题。"
        : verdict === "issues_found"
          ? `发现 ${findings.length} 个问题。`
          : "审查未完成。";
  return { summary, verdict, findings };
}

function parseMarkdownReview(text: string): ReviewReport {
  const cleaned = text.trim();
  if (!cleaned) return { summary: "审查没有返回内容。", verdict: "incomplete", findings: [] };
  if (cleaned.length < 40 && !/问题|风险|错误|异常|issue|finding|error|bug/i.test(cleaned)) {
    return { summary: "审查输出无法解析。", verdict: "incomplete", findings: [] };
  }
  if (/未发现(?:明确|具体)?问题|no (?:concrete )?(?:issues|findings)/i.test(cleaned)) {
    return { summary: cleaned.slice(0, 500), verdict: "clean", findings: [] };
  }

  const referencedFile = cleaned.match(
    /(?:^|[\s"])((?:[\w.-]+[\/\\])*[\w.-]+\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|cs|cpp|c|h|json|yaml|yml))/m,
  )?.[1];
  const findings: ReviewFinding[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[1] ?? "")) continue;
    const location = cells[2] ?? "";
    const title = (cells[3] ?? "").replace(/\*\*/g, "").trim();
    const detail = (cells[4] ?? "").replace(/\*\*/g, "").trim();
    if (!title || !detail) continue;
    findings.push({
      severity: inferSeverity(`${title} ${detail}`),
      title,
      detail,
      file: referencedFile,
      line: Number(location.match(/L(?:ine)?\s*(\d+)/i)?.[1]) || undefined,
      recommendation: "为这个边界情况增加明确校验，并补充能复现问题的测试。",
    });
  }
  if (findings.length > 0) {
    return { summary: `发现 ${findings.length} 个具体问题。`, verdict: "issues_found", findings };
  }

  return {
    summary: "审查完成，但返回的是自由格式报告。",
    verdict: "issues_found",
    findings: [
      {
        severity: inferSeverity(cleaned),
        title: "需要人工查看的审查结论",
        detail: cleaned.slice(0, 4000),
        recommendation: "查看完整审查输出，并把确认的问题转成修改任务。",
        file: referencedFile,
      },
    ],
  };
}

function inferSeverity(text: string): ReviewFinding["severity"] {
  if (
    /远程执行|注入|越权|泄露|数据丢失|崩溃|重复扣款|critical|security|injection|data loss/i.test(
      text,
    )
  ) {
    return "high";
  }
  if (
    /错误|异常|边界|失败|风险|除以零|Infinity|NaN|类型校验|空操作|incorrect|error|bug|failure/i.test(
      text,
    )
  )
    return "medium";
  return "low";
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function normalizeFinding(value: unknown): ReviewFinding | null {
  if (!isRecord(value)) return null;
  const severity = ["critical", "high", "medium", "low"].includes(String(value.severity))
    ? (value.severity as ReviewFinding["severity"])
    : "medium";
  const title = stringValue(value.title);
  const detail = stringValue(value.detail);
  const recommendation = stringValue(value.recommendation);
  if (!title || !detail || !recommendation) return null;
  return {
    severity,
    title,
    detail,
    recommendation,
    file: stringValue(value.file) || undefined,
    line:
      typeof value.line === "number" && Number.isInteger(value.line) && value.line > 0
        ? value.line
        : undefined,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
