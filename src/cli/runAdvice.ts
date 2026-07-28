export type AdviceKind = "success" | "warning" | "danger" | "info";

export interface RunAdvice {
  kind: AdviceKind;
  title: string;
  summary: string;
  nextActions: string[];
  evidence: string[];
}

export interface RunSummaryForAdvice {
  stopReason?: string;
  applyStatus?: string;
  totalIterations?: number;
  totalCostUsd?: number;
  usageStatus?: string;
  usage?: { status?: string; costUsd?: number };
  totalDurationMs?: number;
  reviewOnly?: boolean;
  providerError?: {
    category?: string;
    statusCode?: number;
    message?: string;
    retryable?: boolean;
  };
  reviewReport?: { verdict?: string; summary?: string; findings?: unknown[] };
  iterations?: Array<{
    judge?: {
      passed?: boolean;
      failedChecks?: string[];
      summary?: string;
    };
    verifier?: {
      done?: boolean;
      problems?: string[];
      nextInstruction?: string;
    };
    integrity?: {
      status?: string;
      criticalCount?: number;
      warningCount?: number;
      issues?: Array<{ rule?: string; detail?: string }>;
    };
  }>;
}

export function buildRunAdvice(summary: RunSummaryForAdvice | null | undefined): RunAdvice {
  if (!summary) {
    return {
      kind: "info",
      title: "还没有运行结果",
      summary: "任务还没有生成可审查的结果。",
      nextActions: ["先开始运行任务。"],
      evidence: [],
    };
  }

  if (
    summary.reviewOnly ||
    summary.stopReason === "review_completed" ||
    summary.stopReason === "review_incomplete"
  ) {
    const report = summary.reviewReport;
    const incomplete =
      summary.stopReason === "review_incomplete" || report?.verdict === "incomplete";
    const findings = Array.isArray(report?.findings) ? report.findings.length : 0;
    return {
      kind: incomplete ? "warning" : findings > 0 ? "warning" : "success",
      title: incomplete ? "审查未完成" : "代码审查已完成",
      summary:
        report?.summary ||
        (incomplete
          ? "没有形成完整的审查结论。"
          : findings > 0
            ? `发现 ${findings} 个需要关注的问题。`
            : "没有发现明确问题。"),
      nextActions: incomplete
        ? ["检查运行详情后重新审查。"]
        : findings > 0
          ? ["按严重程度查看问题。", "确认后再创建修改任务。"]
          : ["如需更深入检查，可缩小范围后再次审查。"],
      evidence: [],
    };
  }

  const applyStatus = text(summary.applyStatus, "pending");
  if (applyStatus === "applied") {
    return {
      kind: "success",
      title: "补丁已应用",
      summary: "这次通过的修改已经写回原项目。",
      nextActions: ["回到原项目运行自己的检查。", "如果还要继续改，基于当前项目重新创建任务。"],
      evidence: latestEvidence(summary),
    };
  }

  if (applyStatus === "discarded") {
    return {
      kind: "info",
      title: "运行已丢弃",
      summary: "隔离副本已经丢弃，原项目没有被修改。",
      nextActions: [
        "需要同类修改时重新运行任务。",
        "如果失败原因仍有价值，可以复用详情里的审查意见。",
      ],
      evidence: latestEvidence(summary),
    };
  }

  const stopReason = text(summary.stopReason, "unknown");
  switch (stopReason) {
    case "passed":
      return {
        kind: "success",
        title: "任务已通过，等待你决定是否应用",
        summary: "验收命令和审查结论都通过了，但默认还没有写回原项目。",
        nextActions: ["先审查补丁，确认改动范围。", "满意后点击应用补丁；不满意就丢弃。"],
        evidence: latestEvidence(summary),
      };

    case "max_iterations":
      return {
        kind: "danger",
        title: "达到最大轮数，仍未通过",
        summary: "执行 agent 多轮尝试后仍没有满足验收或审查要求。",
        nextActions: [
          "查看最后一轮失败证据和审查意见。",
          "如果方向是对的，点击继续运行增加几轮。",
          "如果方向不对，修改任务目标或验收命令后重新运行。",
        ],
        evidence: latestEvidence(summary),
      };

    case "budget_exceeded":
      return {
        kind: "warning",
        title: "预算用完，任务已停止",
        summary: "Verdikt 在达到预算上限后停止，避免继续消耗。",
        nextActions: [
          "先看最后一轮是否已经接近完成。",
          "如果值得继续，可以提高预算后继续运行。",
          "如果方向不对，先缩小任务范围再重新运行。",
        ],
        evidence: latestEvidence(summary),
      };

    case "no_progress":
      return {
        kind: "danger",
        title: "连续几轮没有明显进展",
        summary: "失败特征或审查意见重复出现，继续盲跑价值不高。",
        nextActions: [
          "打开详情看重复卡住的位置。",
          "补充更具体的任务说明或更小的验收命令。",
          "必要时丢弃这次运行，重新拆分任务。",
        ],
        evidence: latestEvidence(summary),
      };

    case "provider_error": {
      const providerError = summary.providerError;
      const category = text(providerError?.category, "unknown");
      const copy = providerErrorCopy(category);
      return {
        kind: "warning",
        title: copy.title,
        summary: copy.summary,
        nextActions: copy.nextActions,
        evidence:
          typeof providerError?.statusCode === "number"
            ? [`Provider status: ${providerError.statusCode}`]
            : [],
      };
    }

    case "cancelled":
      return {
        kind: "info",
        title: "运行已停止",
        summary: "任务被手动停止，已经保留目前可用的运行记录。",
        nextActions: ["如果仍然需要完成，可以从这次运行继续。", "如果方向不对，可以直接丢弃。"],
        evidence: latestEvidence(summary),
      };

    default:
      return {
        kind: "warning",
        title: "运行没有成功完成",
        summary: `当前停止原因是 ${stopReason}。`,
        nextActions: ["查看详情确认失败原因。", "根据最后一轮审查意见决定继续或丢弃。"],
        evidence: latestEvidence(summary),
      };
  }
}

function latestEvidence(summary: RunSummaryForAdvice): string[] {
  const iterations = Array.isArray(summary.iterations) ? summary.iterations : [];
  const latest = iterations[iterations.length - 1];
  if (!latest) return [];

  const evidence: string[] = [];
  const failedChecks = latest.judge?.failedChecks ?? [];
  if (failedChecks.length > 0) {
    evidence.push(`未通过检查：${failedChecks.join(", ")}`);
  }
  if (latest.judge?.summary) {
    evidence.push(`验收结果：${latest.judge.summary}`);
  }
  for (const problem of latest.verifier?.problems ?? []) {
    evidence.push(problem);
  }
  if (latest.verifier?.nextInstruction) {
    evidence.push(`下一步建议：${latest.verifier.nextInstruction}`);
  }
  if ((latest.integrity?.criticalCount ?? 0) > 0) {
    evidence.push(`完整性风险：${latest.integrity?.criticalCount} 个严重问题`);
  }

  return evidence.slice(0, 6);
}

function providerErrorCopy(category: string): {
  title: string;
  summary: string;
  nextActions: string[];
} {
  switch (category) {
    case "insufficient_credit":
      return {
        title: "Claude \u4f59\u989d\u4e0d\u8db3\uff0c\u4efb\u52a1\u5df2\u6682\u505c",
        summary:
          "\u5f53\u524d\u8fd0\u884c\u6ca1\u6709\u7ee7\u7eed\u8c03\u7528 provider\uff0c\u73b0\u573a\u5df2\u4fdd\u7559\u3002",
        nextActions: [
          "\u8865\u5145\u4f59\u989d\u540e\u70b9\u51fb\u201c\u7ee7\u7eed\u8fd0\u884c\u201d\u3002",
          "\u5982\u679c\u4e0d\u518d\u9700\u8981\u8fd9\u6b21\u5c1d\u8bd5\uff0c\u53ef\u4ee5\u4e22\u5f03\u5df2\u4fdd\u7559\u73b0\u573a\u3002",
        ],
      };
    case "authentication":
      return {
        title: "Claude \u767b\u5f55\u72b6\u6001\u4e0d\u53ef\u7528",
        summary:
          "Verdikt \u65e0\u6cd5\u4ee5\u5f53\u524d\u8d26\u6237\u72b6\u6001\u5f00\u59cb agent \u5de5\u4f5c\uff0c\u73b0\u573a\u5df2\u4fdd\u7559\u3002",
        nextActions: [
          "\u91cd\u65b0\u767b\u5f55 Claude \u540e\u70b9\u51fb\u201c\u7ee7\u7eed\u8fd0\u884c\u201d\u3002",
          "\u5982\u679c\u4f7f\u7528 API key\uff0c\u8bf7\u68c0\u67e5\u5f53\u524d\u7ec8\u7aef\u73af\u5883\u3002",
        ],
      };
    case "rate_limited":
      return {
        title: "Claude \u5f53\u524d\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41",
        summary:
          "Verdikt \u5df2\u6682\u505c\u8fd0\u884c\uff0c\u4e0d\u4f1a\u7ee7\u7eed\u53d1\u9001\u91cd\u590d\u8bf7\u6c42\u3002",
        nextActions: ["\u7a0d\u540e\u70b9\u51fb\u201c\u7ee7\u7eed\u8fd0\u884c\u201d\u3002"],
      };
    case "service_unavailable":
      return {
        title: "Claude \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528",
        summary:
          "Verdikt \u5df2\u505c\u6b62\u540e\u7eed\u9a8c\u6536\u548c\u5ba1\u67e5\uff0c\u4fdd\u7559\u4e86\u5f53\u524d\u73b0\u573a\u3002",
        nextActions: ["\u7a0d\u540e\u70b9\u51fb\u201c\u7ee7\u7eed\u8fd0\u884c\u201d\u3002"],
      };
    default:
      return {
        title: "Claude provider \u65e0\u6cd5\u5b8c\u6210\u8bf7\u6c42",
        summary:
          "Verdikt \u5df2\u505c\u6b62\u540e\u7eed\u9a8c\u6536\u548c\u5ba1\u67e5\uff0c\u4fdd\u7559\u4e86\u5f53\u524d\u73b0\u573a\u3002",
        nextActions: [
          "\u68c0\u67e5 Claude \u767b\u5f55\u3001\u4f59\u989d\u548c\u6a21\u578b\u914d\u7f6e\u540e\u7ee7\u7eed\u8fd0\u884c\u3002",
        ],
      };
  }
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}
