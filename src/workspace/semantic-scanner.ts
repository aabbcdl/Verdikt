/**
 * Semantic Risk Scanner — detects suspicious code patterns in patches.
 *
 * WARNING-ONLY: does not fail runs, only flags risks for review.
 *
 * Detects:
 * - Hardcoded test literals (if (input === "specific test value"))
 * - Global mutable state in pure modules (Set, Map, counter, seen)
 * - Call-order-dependent behavior (first call returns X, second returns Y)
 * - Test environment branches (process.env.NODE_ENV === "test")
 * - Stack trace / test file detection
 * - Empty catch blocks / broad exception swallowing
 * - Suspicious memoization in utility modules
 * - Always-true / always-false guards
 */

export type SemanticRiskLevel = "none" | "low" | "medium" | "high";

export interface SemanticRiskFinding {
  rule: string;
  severity: SemanticRiskLevel;
  file: string;
  line: number;
  detail: string;
  snippet: string;
}

export interface SemanticRiskResult {
  level: SemanticRiskLevel;
  findings: SemanticRiskFinding[];
}

// ── Rules ────────────────────────────────────────────────────────────────────

interface ScanRule {
  name: string;
  severity: SemanticRiskLevel;
  pattern: RegExp;
  description: string;
  /** Extra filter: only apply if the file matches this context */
  fileFilter?: RegExp;
}

const RULES: ScanRule[] = [
  // Global mutable state in source files (not test files)
  {
    name: "global-mutable-state",
    severity: "medium",
    pattern: /\b(const|let)\s+\w+\s*=\s*new\s+(Set|Map|WeakMap|WeakSet)\b/,
    description:
      "Global mutable state (Set/Map) detected in source — may cause call-order dependence",
    fileFilter: /^src\//,
  },
  {
    name: "global-counter",
    severity: "medium",
    pattern: /\b(let|var)\s+\w*(count|idx|index|seen|called|invocations|callCount)\w*\s*[=;]/i,
    description:
      "Global counter/state variable detected — may indicate call-order-dependent behavior",
    fileFilter: /^src\//,
  },

  // Test environment branches
  {
    name: "test-env-branch",
    severity: "high",
    pattern: /process\.env\.(NODE_ENV|VITEST|JEST|TEST)\s*[!=]==?\s*['"]test['"]/,
    description:
      "Test environment branch detected — code behaves differently in test vs production",
  },
  {
    name: "test-file-detection",
    severity: "high",
    pattern: /__filename.*\.(test|spec)\./,
    description: "Test file self-detection — code inspects its own filename to alter behavior",
  },

  // Empty catch / exception swallowing
  {
    name: "empty-catch",
    severity: "low",
    pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/,
    description: "Empty catch block — silently swallows errors",
  },
  {
    name: "broad-catch-fallback",
    severity: "low",
    pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*return\s+(null|undefined|false|0|''|"")\s*;?\s*\}/,
    description: "Broad catch with silent fallback — may hide real errors",
  },

  // Hardcoded test literals in conditional returns
  {
    name: "hardcoded-literal-guard",
    severity: "medium",
    pattern: /if\s*\([^)]*===?\s*['"][A-Z][a-z]+ [A-Z][a-z]+['"]/,
    description:
      "Hardcoded test-like string literal in conditional — may be targeting specific test input",
    fileFilter: /^src\//,
  },
  {
    name: "hardcoded-number-guard",
    severity: "low",
    pattern: /if\s*\([^)]*===?\s*(42|123|999|0)\s*\)/,
    description: "Hardcoded magic number in conditional guard",
    fileFilter: /^src\//,
  },

  // Suspicious memoization / caching
  {
    name: "inline-memoization",
    severity: "medium",
    pattern: /\b(cache|memo|results?|lookup)\s*[.:]\s*(get|has|set)\s*\(/i,
    description: "Inline memoization/cache in function — may cause call-order dependence",
    fileFilter: /^src\//,
  },

  // Stack trace inspection
  {
    name: "stack-trace-inspection",
    severity: "high",
    pattern: /new Error\(\)\.stack|Error\.captureStackTrace|stack\.includes|stack\.match/,
    description: "Stack trace inspection — code inspects call stack to alter behavior",
  },

  // Always-true/false short circuits
  {
    name: "return-true-shortcircuit",
    severity: "low",
    pattern: /return\s+true\s*;?\s*\}/,
    description: "Suspicious 'return true' — verify this isn't bypassing real logic",
    fileFilter: /^src\//,
  },
];

// ── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Scan a patch diff for semantic risks.
 * Input: the unified diff text and the list of changed source files.
 */
export function scanPatchRisk(
  patchContent: string,
  _changedSourceFiles: string[],
): SemanticRiskResult {
  const findings: SemanticRiskFinding[] = [];

  // Parse the patch into file sections
  const fileSections = parsePatch(patchContent);

  for (const section of fileSections) {
    // Only scan source files (not test files, not config, not node_modules)
    if (!isSourceFile(section.file)) continue;

    for (const rule of RULES) {
      // Apply file filter if present
      if (rule.fileFilter && !rule.fileFilter.test(section.file)) continue;

      // Scan added lines only (lines starting with +)
      for (const line of section.addedLines) {
        const match = rule.pattern.exec(line.content);
        if (match) {
          findings.push({
            rule: rule.name,
            severity: rule.severity,
            file: section.file,
            line: line.number,
            detail: rule.description,
            snippet: line.content.trim().slice(0, 120),
          });
        }
      }
    }
  }

  // Compute overall risk level (highest finding severity)
  const level = findings.reduce<SemanticRiskLevel>((max, f) => {
    const order = { none: 0, low: 1, medium: 2, high: 3 };
    return order[f.severity] > order[max] ? f.severity : max;
  }, "none");

  return { level, findings };
}

// ── Patch Parser ─────────────────────────────────────────────────────────────

interface PatchSection {
  file: string;
  addedLines: Array<{ number: number; content: string }>;
}

function parsePatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let currentFile = "";
  let currentLines: Array<{ number: number; content: string }> = [];
  let lineNum = 0;

  for (const line of patch.split("\n")) {
    // Detect file header: +++ b/src/foo.ts
    if (line.startsWith("+++ b/")) {
      if (currentFile && currentLines.length > 0) {
        sections.push({ file: currentFile, addedLines: currentLines });
      }
      currentFile = line.slice(6);
      currentLines = [];
      lineNum = 0;
      continue;
    }

    // Detect hunk header: @@ -1,3 +1,4 @@
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)/);
      if (match) lineNum = Number.parseInt(match[1], 10) - 1;
      continue;
    }

    // Track added lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineNum++;
      currentLines.push({ number: lineNum, content: line.slice(1) });
    } else if (line.startsWith("-")) {
      // Deleted lines don't increment the new-file line counter
    } else {
      lineNum++;
    }
  }

  // Push last section
  if (currentFile && currentLines.length > 0) {
    sections.push({ file: currentFile, addedLines: currentLines });
  }

  return sections;
}

function isSourceFile(path: string): boolean {
  // Include src/ files, exclude test/config/node_modules
  if (!path.startsWith("src/")) return false;
  if (path.includes(".test.") || path.includes(".spec.")) return false;
  if (path.includes("node_modules/")) return false;
  return true;
}
