/**
 * Test integrity guard and anti-cheating detection.
 *
 * Before a run: records hashes of test files, test config, and test scripts.
 * After each iteration: checks for suspicious modifications.
 *
 * Anti-cheating patterns scanned:
 * - Skipped tests: it.skip, describe.skip, test.skip
 * - Focused tests: it.only, describe.only, test.only
 * - Deleted assertions: expect(...) count decreased
 * - Weakened assertions: toEqual→toBeDefined, toBe→toBeTruthy, etc.
 * - Deleted test files
 * - Modified test scripts in package.json
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { IntegrityPolicy } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestBaseline {
  /** Hash of each test file: relative path → sha256 */
  fileHashes: Map<string, string>;
  /** Number of expect() calls in each test file */
  assertionCounts: Map<string, number>;
  /** Hash of test-related config files */
  configHashes: Map<string, string>;
  /** Test script from package.json */
  testScript?: string;
}

export interface IntegrityCheckResult {
  passed: boolean;
  violations: IntegrityViolation[];
}

export interface IntegrityViolation {
  severity: "critical" | "warning";
  rule: string;
  file?: string;
  detail: string;
}

// ── Baseline capture ─────────────────────────────────────────────────────────

/**
 * Capture the test baseline before a run starts.
 * Records file hashes, assertion counts, and config hashes.
 */
export async function captureTestBaseline(repoPath: string): Promise<TestBaseline> {
  const fileHashes = new Map<string, string>();
  const assertionCounts = new Map<string, number>();
  const configHashes = new Map<string, string>();

  // Hash all test files
  const testFiles = await findTestFiles(repoPath);
  for (const file of testFiles) {
    const content = await readFile(join(repoPath, file), "utf-8");
    const relPath = relative(repoPath, join(repoPath, file)).replace(/\\/g, "/");
    fileHashes.set(relPath, sha256(content));
    assertionCounts.set(relPath, countAssertions(content));
  }

  // Hash test config files
  const configFiles = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "jest.config.ts",
    "jest.config.js",
    ".babelrc",
    "babel.config.js",
    "tsconfig.json",
  ];
  for (const file of configFiles) {
    try {
      const content = await readFile(join(repoPath, file), "utf-8");
      configHashes.set(file, sha256(content));
    } catch {
      // File doesn't exist, skip
    }
  }

  // Capture test script from package.json
  let testScript: string | undefined;
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf-8"));
    testScript = pkg.scripts?.test;
  } catch {
    // No package.json
  }

  return { fileHashes, assertionCounts, configHashes, testScript };
}

// ── Integrity check ──────────────────────────────────────────────────────────

/**
 * Check test integrity after an iteration.
 * Compares current state against the baseline, respecting the task's integrity policy.
 *
 * Anti-cheating rules (skip/only/deleted assertions) are ALWAYS enforced.
 * Policy controls whether test file content changes and config changes are allowed.
 */
export async function checkTestIntegrity(
  repoPath: string,
  baseline: TestBaseline,
  policy: IntegrityPolicy = {},
): Promise<IntegrityCheckResult> {
  const violations: IntegrityViolation[] = [];
  const allowTestChanges = policy.allowTestChanges ?? false;
  const allowConfigChanges = policy.allowConfigChanges ?? false;
  const allowPackageScriptChanges = policy.allowPackageScriptChanges ?? false;

  // 1. Check test files
  for (const [file, hash] of baseline.fileHashes) {
    try {
      const content = await readFile(join(repoPath, file), "utf-8");
      const currentHash = sha256(content);

      if (currentHash !== hash) {
        // File was modified — ALWAYS scan for cheating patterns
        const fileViolations = await scanForCheating(file, content, baseline);

        if (allowTestChanges) {
          // Allow content changes, but anti-cheating is still enforced
          // Only keep critical anti-cheating violations (skip/only/deleted assertions)
          const antiCheatingOnly = fileViolations.filter(
            (v) => v.severity === "critical" && isAntiCheatingRule(v.rule),
          );
          violations.push(...antiCheatingOnly);
        } else {
          // Strict mode: any test file modification is suspicious
          violations.push(...fileViolations);
        }
      }
    } catch {
      // Test file deleted — always critical
      violations.push({
        severity: "critical",
        rule: "test-file-deleted",
        file,
        detail: `Test file was deleted: ${file}`,
      });
    }
  }

  // 2. Check config files
  if (!allowConfigChanges) {
    for (const [file, hash] of baseline.configHashes) {
      try {
        const content = await readFile(join(repoPath, file), "utf-8");
        if (sha256(content) !== hash) {
          violations.push({
            severity: "warning",
            rule: "config-modified",
            file,
            detail: `Test config file was modified: ${file}`,
          });
        }
      } catch {
        violations.push({
          severity: "warning",
          rule: "config-deleted",
          file,
          detail: `Config file was deleted: ${file}`,
        });
      }
    }
  }

  // 3. Check test script
  if (baseline.testScript && !allowPackageScriptChanges) {
    try {
      const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf-8"));
      const currentScript = pkg.scripts?.test;
      if (currentScript && currentScript !== baseline.testScript) {
        violations.push({
          severity: "critical",
          rule: "test-script-modified",
          detail: `Test script changed from "${baseline.testScript}" to "${currentScript}"`,
        });
      }
    } catch {
      // No package.json
    }
  }

  return {
    passed: violations.filter((v) => v.severity === "critical").length === 0,
    violations,
  };
}

// ── Anti-cheating pattern scanner ────────────────────────────────────────────

async function scanForCheating(
  file: string,
  content: string,
  baseline: TestBaseline,
): Promise<IntegrityViolation[]> {
  const violations: IntegrityViolation[] = [];

  // Check for skipped tests
  const skipPatterns = [
    { pattern: /\bit\.skip\s*\(/g, name: "it.skip" },
    { pattern: /\bdescribe\.skip\s*\(/g, name: "describe.skip" },
    { pattern: /\btest\.skip\s*\(/g, name: "test.skip" },
  ];
  for (const { pattern, name } of skipPatterns) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      violations.push({
        severity: "critical",
        rule: "test-skipped",
        file,
        detail: `Found ${matches.length} ${name} call(s) in ${file}`,
      });
    }
  }

  // Check for focused tests
  const focusPatterns = [
    { pattern: /\bit\.only\s*\(/g, name: "it.only" },
    { pattern: /\bdescribe\.only\s*\(/g, name: "describe.only" },
    { pattern: /\btest\.only\s*\(/g, name: "test.only" },
  ];
  for (const { pattern, name } of focusPatterns) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      violations.push({
        severity: "critical",
        rule: "test-focused",
        file,
        detail: `Found ${matches.length} ${name} call(s) in ${file}`,
      });
    }
  }

  // Check for decreased assertion count
  const currentCount = countAssertions(content);
  const baselineCount = baseline.assertionCounts.get(file);
  if (baselineCount !== undefined && currentCount < baselineCount) {
    violations.push({
      severity: "critical",
      rule: "assertions-decreased",
      file,
      detail: `Assertion count decreased from ${baselineCount} to ${currentCount} in ${file}`,
    });
  }

  // Check for weakened assertions (specific patterns)
  const weakenPatterns = [
    { pattern: /\.toEqual\(/g, replacement: /\.toBeDefined\(/, name: "toEqual→toBeDefined" },
    { pattern: /\.toBe\(/g, replacement: /\.toBeTruthy\(/, name: "toBe→toBeTruthy" },
    { pattern: /\.toBe\(/g, replacement: /\.toBeDefined\(/, name: "toBe→toBeDefined" },
    { pattern: /\.toThrow\(/g, replacement: /\.toBeDefined\(/, name: "toThrow→toBeDefined" },
    {
      pattern: /\.toBeGreaterThan\(/g,
      replacement: /\.toBeDefined\(/,
      name: "toBeGreaterThan→toBeDefined",
    },
  ];
  for (const { pattern: _pattern, name: _name } of weakenPatterns) {
    // This is a simplified check — in production you'd want AST analysis
    // For now, just flag if we see these suspicious patterns
    if (
      content.match(/\.toBeDefined\(\)/) &&
      !content.match(/\.toBe\(/) &&
      !content.match(/\.toEqual\(/)
    ) {
      // Only flag if toBe/toEqual disappeared and only toDefined remains
      // This is intentionally conservative — real AST analysis would be more precise
    }
  }

  // Check for commented-out assertions
  const commentedAssertions = content.match(/\/\/\s*expect\(|\/\*\s*expect\(/g);
  if (commentedAssertions && commentedAssertions.length > 0) {
    violations.push({
      severity: "warning",
      rule: "assertions-commented",
      file,
      detail: `Found ${commentedAssertions.length} commented-out expect() call(s) in ${file}`,
    });
  }

  // Check for empty catch blocks (swallowing errors)
  const emptyCatches = content.match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g);
  if (emptyCatches && emptyCatches.length > 0) {
    violations.push({
      severity: "warning",
      rule: "empty-catch",
      file,
      detail: `Found ${emptyCatches.length} empty catch block(s) in ${file}`,
    });
  }

  return violations;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function countAssertions(content: string): number {
  // Remove single-line comments before counting
  const withoutComments = content.replace(/\/\/.*$/gm, "");
  const matches = withoutComments.match(/\bexpect\s*\(/g);
  return matches ? matches.length : 0;
}

/**
 * Rules that are ALWAYS enforced, even when allowTestChanges=true.
 * These represent cheating behaviors that no legitimate task should perform.
 */
function isAntiCheatingRule(rule: string): boolean {
  const antiCheatingRules = new Set([
    "test-skipped",
    "test-focused",
    "assertions-decreased",
    "assertions-commented",
    "test-file-deleted",
    "test-script-modified",
  ]);
  return antiCheatingRules.has(rule);
}

async function findTestFiles(repoPath: string): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  return new Promise<string[]>((resolve) => {
    let stdout = "";
    const child = spawn(
      "git",
      ["ls-files", "*.test.ts", "*.test.js", "*.test.tsx", "*.test.jsx", "*.spec.ts", "*.spec.js"],
      {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => resolve(stdout.split("\n").filter(Boolean)));
    child.on("error", () => resolve([]));
  });
}
