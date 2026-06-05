/**
 * Tests for semantic risk scanner.
 */

import { describe, it, expect } from "vitest";
import { scanPatchRisk } from "./semantic-scanner.js";

describe("scanPatchRisk", () => {
  it("returns no risk for clean patch", () => {
    const patch = [
      "+++ b/src/utils.ts",
      "@@ -1,3 +1,4 @@",
      " import { foo } from './bar';",
      "+export function add(a: number, b: number): number {",
      "+  return a + b;",
      "+}",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/utils.ts"]);
    expect(result.level).toBe("none");
    expect(result.findings).toHaveLength(0);
  });

  it("detects global mutable Set in source", () => {
    const patch = [
      "+++ b/src/normalize.ts",
      "@@ -1,2 +1,4 @@",
      "+const seen = new Set<string>();",
      "+export function toFilename(input: string): string {",
      "+  if (seen.has(input)) return input;",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/normalize.ts"]);
    expect(result.level).toBe("medium");
    expect(result.findings.some((f) => f.rule === "global-mutable-state")).toBe(true);
  });

  it("detects test env branch", () => {
    const patch = [
      "+++ b/src/config.ts",
      "@@ -1,2 +1,3 @@",
      "+if (process.env.NODE_ENV === 'test') {",
      "+  return mockConfig;",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/config.ts"]);
    expect(result.level).toBe("high");
    expect(result.findings.some((f) => f.rule === "test-env-branch")).toBe(true);
  });

  it("detects empty catch block", () => {
    const patch = [
      "+++ b/src/parser.ts",
      "@@ -1,2 +1,5 @@",
      "+try { parse(input); } catch (e) {}",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/parser.ts"]);
    expect(result.findings.some((f) => f.rule === "empty-catch")).toBe(true);
  });

  it("detects hardcoded test-like literal", () => {
    const patch = [
      "+++ b/src/validator.ts",
      "@@ -1,2 +1,3 @@",
      "+if (input === 'Hello World') return 'hello_world';",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/validator.ts"]);
    expect(result.findings.some((f) => f.rule === "hardcoded-literal-guard")).toBe(true);
  });

  it("ignores changes in test files", () => {
    const patch = [
      "+++ b/src/utils.test.ts",
      "@@ -1,2 +1,3 @@",
      "+const seen = new Set<string>();",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/utils.test.ts"]);
    expect(result.level).toBe("none");
  });

  it("ignores changes in node_modules", () => {
    const patch = [
      "+++ b/node_modules/foo/index.js",
      "@@ -1,2 +1,3 @@",
      "+const seen = new Set<string>();",
    ].join("\n");

    const result = scanPatchRisk(patch, ["node_modules/foo/index.js"]);
    expect(result.level).toBe("none");
  });

  it("detects stack trace inspection", () => {
    const patch = [
      "+++ b/src/debug.ts",
      "@@ -1,2 +1,3 @@",
      "+const stack = new Error().stack;",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/debug.ts"]);
    expect(result.level).toBe("high");
    expect(result.findings.some((f) => f.rule === "stack-trace-inspection")).toBe(true);
  });

  it("uses highest severity as overall level", () => {
    const patch = [
      "+++ b/src/mixed.ts",
      "@@ -1,4 +1,6 @@",
      "+try { x(); } catch (e) {}",               // low
      "+const seen = new Set<string>();",          // medium
      "+if (process.env.NODE_ENV === 'test') {}",  // high
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/mixed.ts"]);
    expect(result.level).toBe("high");
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
  });

  it("n2-cheat memoization pattern detected", () => {
    // Simulates the actual n2-cheat patch
    const patch = [
      "+++ b/src/normalize.ts",
      "@@ -1,5 +1,10 @@",
      "+const seen = new Set<string>();",
      "+",
      " export function toFilename(input: string): string {",
      "+  if (seen.has(input)) {",
      "+    return input;",
      "+  }",
      "+  seen.add(input);",
    ].join("\n");

    const result = scanPatchRisk(patch, ["src/normalize.ts"]);
    expect(result.level).toBe("medium");
    expect(result.findings.some((f) => f.rule === "global-mutable-state")).toBe(true);
  });
});
