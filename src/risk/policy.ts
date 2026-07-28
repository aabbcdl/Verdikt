import type { RiskCategory, TaskSpec, TaskStage } from "../types.js";

export interface RiskEvaluation {
  categories: RiskCategory[];
  action: "allow" | "confirm" | "deny";
  reason: string;
}

const PATTERNS: Array<{ category: RiskCategory; pattern: RegExp }> = [
  {
    category: "deployment",
    pattern: /\bdeploy(?:ment)?\b|\brelease\b|\bpublish\b|部署|上线|发布/i,
  },
  { category: "production", pattern: /\bproduction\b|\bprod\b|生产环境|线上环境/i },
  { category: "database", pattern: /\bdatabase\b|\bschema\b|\bmigrat(?:e|ion)\b|数据库|数据迁移/i },
  { category: "secrets", pattern: /\bsecret\b|\btoken\b|api[ _-]?key|credential|密钥|凭证/i },
  {
    category: "external_write",
    pattern: /webhook|external service|upload|send to|post to|外部服务|写入外部|发送到/i,
  },
  {
    category: "destructive",
    pattern: /rm\s+-rf|\bdrop\b|\btruncate\b|\bdestroy\b|\bdelete\b|删除|清空|销毁/i,
  },
  {
    category: "outside_repo",
    pattern:
      /outside (?:the )?repo|system directory|global install|仓库外|项目外|系统目录|全局安装/i,
  },
];

export function evaluateTaskRisk(task: TaskSpec, stage?: TaskStage): RiskEvaluation {
  const text = [
    task.goal,
    stage?.title,
    stage?.goal,
    ...acceptanceText(stage?.acceptance ?? task.acceptance),
  ]
    .filter(Boolean)
    .join("\n");
  const detected = PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ category }) => category,
  );
  const declared = [
    ...(task.riskPolicy?.declaredCategories ?? []),
    ...(stage?.riskCategories ?? []),
    ...(stage?.requireApproval ? (["manual"] as RiskCategory[]) : []),
  ];
  const categories = [...new Set([...detected, ...declared])];
  const approved = new Set(task.riskPolicy?.approvedCategories ?? []);
  const pending = categories.filter((category) => !approved.has(category));

  if (pending.length === 0) {
    return { categories, action: "allow", reason: "No unapproved high-risk categories detected" };
  }

  const mode = task.riskPolicy?.mode ?? "confirm";
  return {
    categories: pending,
    action: mode === "allow" ? "allow" : mode,
    reason: `High-risk categories detected: ${pending.join(", ")}`,
  };
}

function acceptanceText(acceptance: TaskSpec["acceptance"]): string[] {
  if (acceptance.steps) {
    return acceptance.steps.map((step) => [step.command, ...(step.args ?? [])].join(" "));
  }
  return [acceptance.testCommand, acceptance.buildCommand, acceptance.lintCommand].filter(
    (value): value is string => Boolean(value),
  );
}
