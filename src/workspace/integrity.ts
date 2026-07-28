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
 * - Commented-out assertions and empty catch blocks (warnings)
 * - Deleted test files
 * - Modified test scripts in package.json
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";
import type { IntegrityPolicy } from "../types.js";

const TEST_FILE_PATTERN = /\.(test|spec)\.(c|m)?(ts|js)x?$/i;
const TEST_FILE_GLOBS = [
  "*.test.ts",
  "*.test.tsx",
  "*.test.js",
  "*.test.jsx",
  "*.test.mts",
  "*.test.cts",
  "*.test.mjs",
  "*.test.cjs",
  "*.spec.ts",
  "*.spec.tsx",
  "*.spec.js",
  "*.spec.jsx",
  "*.spec.mts",
  "*.spec.cts",
  "*.spec.mjs",
  "*.spec.cjs",
];
const IGNORED_TEST_SCAN_DIRS = new Set([
  ".git",
  ".verdikt",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestBaseline {
  /** Hash of each test file: relative path to sha256 */
  fileHashes: Map<string, string>;
  /** Number of expect() calls in each test file */
  assertionCounts: Map<string, number>;
  /** Hash of test-related config files */
  configHashes: Map<string, string>;
  /** Test script from package.json */
  testScript?: string;
  /** Hash of the complete package scripts object. */
  packageScriptsHash?: string;
  /** Files that are immutable for this run. */
  protectedHashes?: Map<string, string>;
  /** Files that are watched for non-blocking warnings. */
  suspiciousHashes?: Map<string, string>;
  protectedGlobs?: string[];
  suspiciousGlobs?: string[];
}

export interface IntegrityCaptureOptions {
  protectedFiles?: string[];
  protectedGlobs?: string[];
  suspiciousGlobs?: string[];
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
export async function captureTestBaseline(
  repoPath: string,
  options: IntegrityCaptureOptions = {},
): Promise<TestBaseline> {
  const fileHashes = new Map<string, string>();
  const assertionCounts = new Map<string, number>();
  const configHashes = new Map<string, string>();
  const protectedHashes = new Map<string, string>();
  const suspiciousHashes = new Map<string, string>();

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

  // Capture the complete package scripts object, not just the test command.
  let testScript: string | undefined;
  let packageScriptsHash: string | undefined;
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf-8"));
    testScript = typeof pkg.scripts?.test === "string" ? pkg.scripts.test : undefined;
    packageScriptsHash = sha256(JSON.stringify(pkg.scripts ?? {}));
  } catch {
    // No package.json
  }

  const repositoryFiles = await findRepositoryFiles(repoPath);
  const explicitProtected = new Set(
    (options.protectedFiles ?? []).map(normalizeRepositoryPath).filter(Boolean),
  );
  for (const file of repositoryFiles) {
    if (
      explicitProtected.has(file) ||
      (options.protectedGlobs ?? []).some((pattern) => matchesGlob(file, pattern))
    ) {
      protectedHashes.set(file, sha256(await readFile(join(repoPath, file), "utf-8")));
    }
    if ((options.suspiciousGlobs ?? []).some((pattern) => matchesGlob(file, pattern))) {
      suspiciousHashes.set(file, sha256(await readFile(join(repoPath, file), "utf-8")));
    }
  }

  return {
    fileHashes,
    assertionCounts,
    configHashes,
    testScript,
    packageScriptsHash,
    protectedHashes,
    suspiciousHashes,
    protectedGlobs: [...(options.protectedGlobs ?? [])],
    suspiciousGlobs: [...(options.suspiciousGlobs ?? [])],
  };
}

// ── Integrity check ──────────────────────────────────────────────────────────

/**
 * Check test integrity after an iteration.
 * Compares current state against the baseline, respecting the task's integrity policy.
 *
 * Anti-cheating rules (skip/only/deleted assertions) are ALWAYS enforced.
 * Policy controls whether test file content changes and config changes are allowed.
 */
export async function saveTestBaseline(runDir: string, baseline: TestBaseline): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeJsonAtomic(join(runDir, "integrity-baseline.json"), {
    version: 1,
    fileHashes: Object.fromEntries(baseline.fileHashes),
    assertionCounts: Object.fromEntries(baseline.assertionCounts),
    configHashes: Object.fromEntries(baseline.configHashes),
    testScript: baseline.testScript,
    packageScriptsHash: baseline.packageScriptsHash,
    protectedHashes: Object.fromEntries(baseline.protectedHashes ?? []),
    suspiciousHashes: Object.fromEntries(baseline.suspiciousHashes ?? []),
    protectedGlobs: baseline.protectedGlobs ?? [],
    suspiciousGlobs: baseline.suspiciousGlobs ?? [],
  });
}

export async function loadTestBaseline(runDir: string): Promise<TestBaseline | null> {
  const saved = await readJsonFile<Record<string, unknown>>(
    join(runDir, "integrity-baseline.json"),
  );
  if (!saved || saved.version !== 1) return null;
  if (!isStringRecord(saved.fileHashes) || !isNumberRecord(saved.assertionCounts)) return null;
  if (!isStringRecord(saved.configHashes)) return null;
  return {
    fileHashes: new Map(Object.entries(saved.fileHashes)),
    assertionCounts: new Map(
      Object.entries(saved.assertionCounts).map(([file, count]) => [file, Number(count)]),
    ),
    configHashes: new Map(Object.entries(saved.configHashes)),
    testScript: typeof saved.testScript === "string" ? saved.testScript : undefined,
    packageScriptsHash:
      typeof saved.packageScriptsHash === "string" ? saved.packageScriptsHash : undefined,
    protectedHashes: isStringRecord(saved.protectedHashes)
      ? new Map(Object.entries(saved.protectedHashes))
      : new Map(),
    suspiciousHashes: isStringRecord(saved.suspiciousHashes)
      ? new Map(Object.entries(saved.suspiciousHashes))
      : new Map(),
    protectedGlobs: isStringArray(saved.protectedGlobs) ? saved.protectedGlobs : [],
    suspiciousGlobs: isStringArray(saved.suspiciousGlobs) ? saved.suspiciousGlobs : [],
  };
}

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
          violations.push({
            severity: "critical",
            rule: "test-file-modified",
            file,
            detail: `Test file was modified: ${file}`,
          });
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

  // 2. Check newly added test files
  const currentTestFiles = await findTestFiles(repoPath);
  for (const file of currentTestFiles) {
    if (baseline.fileHashes.has(file)) continue;

    try {
      const content = await readFile(join(repoPath, file), "utf-8");
      const fileViolations = await scanForCheating(file, content, baseline);

      if (!allowTestChanges) {
        violations.push({
          severity: "critical",
          rule: "test-file-added",
          file,
          detail: `Test file was added: ${file}`,
        });
        violations.push(...fileViolations);
      } else {
        const antiCheatingOnly = fileViolations.filter(
          (v) => v.severity === "critical" && isAntiCheatingRule(v.rule),
        );
        violations.push(...antiCheatingOnly);
      }
    } catch {
      // File disappeared between discovery and read; ignore this race.
    }
  }

  // 3. Check explicitly protected and suspicious files.
  const protectedHashes = baseline.protectedHashes ?? new Map<string, string>();
  const suspiciousHashes = baseline.suspiciousHashes ?? new Map<string, string>();
  const currentRepositoryFiles = await findRepositoryFiles(repoPath);
  for (const [file, hash] of protectedHashes) {
    try {
      const content = await readFile(join(repoPath, file), "utf-8");
      if (sha256(content) !== hash) {
        violations.push({
          severity: "critical",
          rule: "protected-file-modified",
          file,
          detail: `Protected acceptance file was modified: ${file}`,
        });
      }
    } catch {
      violations.push({
        severity: "critical",
        rule: "protected-file-deleted",
        file,
        detail: `Protected acceptance file was deleted: ${file}`,
      });
    }
  }
  for (const file of currentRepositoryFiles) {
    if (protectedHashes.has(file)) continue;
    if ((baseline.protectedGlobs ?? []).some((pattern) => matchesGlob(file, pattern))) {
      violations.push({
        severity: "critical",
        rule: "protected-file-added",
        file,
        detail: `A new protected file appeared: ${file}`,
      });
    }
  }
  for (const [file, hash] of suspiciousHashes) {
    try {
      const content = await readFile(join(repoPath, file), "utf-8");
      if (sha256(content) !== hash) {
        violations.push({
          severity: "warning",
          rule: "suspicious-file-modified",
          file,
          detail: `Suspicious file was modified: ${file}`,
        });
      }
    } catch {
      violations.push({
        severity: "warning",
        rule: "suspicious-file-deleted",
        file,
        detail: `Suspicious file was deleted: ${file}`,
      });
    }
  }
  for (const file of currentRepositoryFiles) {
    if (suspiciousHashes.has(file)) continue;
    if ((baseline.suspiciousGlobs ?? []).some((pattern) => matchesGlob(file, pattern))) {
      violations.push({
        severity: "warning",
        rule: "suspicious-file-added",
        file,
        detail: `A new suspicious file appeared: ${file}`,
      });
    }
  }

  // 3. Check config files
  if (!allowConfigChanges) {
    for (const [file, hash] of baseline.configHashes) {
      try {
        const content = await readFile(join(repoPath, file), "utf-8");
        if (sha256(content) !== hash) {
          violations.push({
            severity: "critical",
            rule: "config-modified",
            file,
            detail: `Test config file was modified: ${file}`,
          });
        }
      } catch {
        violations.push({
          severity: "critical",
          rule: "config-deleted",
          file,
          detail: `Config file was deleted: ${file}`,
        });
      }
    }
  }

  // 4. Check test script
  if (baseline.testScript !== undefined && !allowPackageScriptChanges) {
    try {
      const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf-8"));
      const currentScript = typeof pkg.scripts?.test === "string" ? pkg.scripts.test : undefined;
      if (currentScript !== baseline.testScript) {
        violations.push({
          severity: "critical",
          rule: "test-script-modified",
          detail: `Test script changed from "${baseline.testScript}" to "${currentScript ?? "(removed)"}"`,
        });
      }
    } catch {
      violations.push({
        severity: "critical",
        rule: "test-script-modified",
        detail: "package.json containing the original test script is missing or unreadable",
      });
    }
  }

  if (baseline.packageScriptsHash !== undefined && !allowPackageScriptChanges) {
    try {
      const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf-8"));
      const currentHash = sha256(JSON.stringify(pkg.scripts ?? {}));
      if (currentHash !== baseline.packageScriptsHash) {
        violations.push({
          severity: "critical",
          rule: "package-scripts-modified",
          file: "package.json",
          detail: "One or more package scripts changed after the integrity baseline was captured",
        });
      }
    } catch {
      // The existing test-script check reports an unreadable package.json.
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

function normalizeRepositoryPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesGlob(file: string, pattern: string): boolean {
  const normalizedFile = normalizeRepositoryPath(file);
  const normalizedPattern = normalizeRepositoryPath(pattern);
  const globstarPlaceholder = "__VERDIKT_GLOBSTAR_PLACEHOLDER__";
  const escaped = normalizedPattern
    .replace(/\*\*/g, globstarPlaceholder)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replaceAll(globstarPlaceholder, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(normalizedFile);
}

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
  const files = new Set<string>();
  for (const file of await findGitTrackedTestFiles(repoPath)) files.add(file);
  for (const file of await findFilesystemTestFiles(repoPath)) files.add(file);
  return Array.from(files).sort();
}

async function findGitTrackedTestFiles(repoPath: string): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  return new Promise<string[]>((resolve) => {
    let stdout = "";
    const child = spawn("git", ["ls-files", "-z", "--", ...TEST_FILE_GLOBS], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () =>
      resolve(
        stdout
          .split("\0")
          .map(normalizeRelativeTestPath)
          .filter((file): file is string => file !== null),
      ),
    );
    child.on("error", () => resolve([]));
  });
}

async function findFilesystemTestFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(repoPath, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_TEST_SCAN_DIRS.has(entry.name)) continue;
        await walk(relPath);
        continue;
      }

      if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) continue;
      const normalized = normalizeRelativeTestPath(relPath);
      if (normalized) files.push(normalized);
    }
  }

  await walk("");
  return files;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "number");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function findRepositoryFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(relativeDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(repoPath, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_TEST_SCAN_DIRS.has(entry.name)) continue;
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) files.push(normalizeRepositoryPath(relPath));
    }
  }
  await walk("");
  return files.sort();
}

function normalizeRelativeTestPath(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  if (!normalized || normalized.trim() !== normalized) return null;
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}
