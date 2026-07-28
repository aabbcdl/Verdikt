import { createHash } from "node:crypto";
import type { RiskCategory } from "../types.js";

export interface RuntimeCommandDecision {
  allowed: boolean;
  categories: RiskCategory[];
  reason: string;
  signature: string;
  requiresExactApproval: boolean;
}

const COMMAND_PATTERNS: Array<{ category: RiskCategory; pattern: RegExp }> = [
  {
    category: "destructive",
    pattern:
      /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b|remove-item\b[^\n]*(?:-recurse|-force)|git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)|\b(?:drop|truncate)\s+(?:table|database)|\bdel\s+\/s\b/i,
  },
  {
    category: "deployment",
    pattern:
      /\b(?:npm|pnpm|yarn)\s+publish\b|\bdeploy\b|\brelease\b|kubectl\s+(?:apply|delete|rollout)|terraform\s+(?:apply|destroy)|serverless\s+deploy/i,
  },
  { category: "production", pattern: /(?:--|\b)(?:prod|production)\b|NODE_ENV\s*=\s*production/i },
  {
    category: "database",
    pattern:
      /\b(?:psql|mysql|mongosh|redis-cli)\b|\b(?:prisma|sequelize|typeorm|knex)\b[^\n]*(?:migrate|db\s+push)|\bmigrat(?:e|ion)\b/i,
  },
  {
    category: "secrets",
    pattern:
      /(?:^|[\s\/\\])\.env(?:\.|[\s$])|\b(?:secret|credential|api[_-]?key|private[_-]?key|keychain)\b/i,
  },
  {
    category: "external_write",
    pattern:
      /\bgit\s+push\b|\b(?:curl|wget)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|--upload-file)|\bgh\s+(?:pr\s+create|release\s+create)|webhook/i,
  },
];

export function evaluateCommandPolicy(
  command: string,
  repoRoot: string,
  approvedCategories: RiskCategory[],
  allowAll = false,
  approvedActionSignatures: string[] = [],
): RuntimeCommandDecision {
  const categories = COMMAND_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(
    ({ category }) => category,
  );
  if (escapesRepository(command, repoRoot)) categories.push("outside_repo");
  const unique = [...new Set(categories)];
  const signature = createActionSignature(command, repoRoot);
  const exactApproved = approvedActionSignatures.includes(signature);
  const approved = new Set(approvedCategories);
  const blocked = unique.filter((category) => !approved.has(category));
  const requiresExactApproval = unique.some((category) => EXACT_APPROVAL_CATEGORIES.has(category));
  const categoryAllowed = allowAll || blocked.length === 0 || exactApproved;
  const allowed = categoryAllowed && (!requiresExactApproval || exactApproved);

  return {
    allowed,
    categories: unique,
    signature,
    requiresExactApproval,
    reason: allowed
      ? unique.length > 0
        ? `Approved exact high-risk action: ${unique.join(", ")}`
        : "No high-risk command category detected"
      : requiresExactApproval && !exactApproved
        ? `Exact action approval required: ${unique.join(", ")}`
        : `Command blocked until approved: ${blocked.join(", ")}`,
  };
}

export function createActionSignature(command: string, repoRoot: string): string {
  const normalizedCommand = command.trim().replace(/\s+/g, " ");
  const normalizedRoot = repoRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return createHash("sha256")
    .update(`${normalizedRoot}\n${normalizedCommand}`)
    .digest("hex")
    .slice(0, 24);
}

const EXACT_APPROVAL_CATEGORIES = new Set<RiskCategory>([
  "deployment",
  "database",
  "production",
  "secrets",
  "external_write",
  "destructive",
  "outside_repo",
]);

function escapesRepository(command: string, repoRoot: string): boolean {
  if (/(?:^|[\s"'=])\.\.[\\/]/.test(command)) return true;
  const normalizedRoot = repoRoot.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  const withoutRoot = command.replace(/\\/g, "/").toLowerCase().split(normalizedRoot).join("");
  return /(?:^|[\s"'=])(?:[a-z]:\/|\/(?:etc|home|opt|root|tmp|usr|var)\/)/i.test(withoutRoot);
}
