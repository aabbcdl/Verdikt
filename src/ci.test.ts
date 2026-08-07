import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface DisabledOrFocusedTestFinding {
  file: string;
  line: number;
  pattern: string;
}

const DISABLED_OR_FOCUSED_TEST_APIS = new Set(["skip", "only", "skipIf", "runIf", "todo"]);
const TEST_GLOBALS = new Set(["describe", "it", "test"]);
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_ROOTS = ["src", "apps"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "out", "coverage", ".git", ".verdikt"]);

describe("release quality gates", () => {
  it("keeps local and CI verification aligned", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const ci = readFileSync(".github/workflows/ci.yml", "utf-8");

    expect(pkg.packageManager).toMatch(/^pnpm@/);
    expect(pkg.scripts?.clean).toContain("rmSync('dist'");
    expect(pkg.scripts?.build).toContain("pnpm clean");
    expect(pkg.scripts?.build).toContain("tsc");
    expect(pkg.scripts?.quality).toContain("pnpm lint");
    expect(pkg.scripts?.quality).toContain("pnpm build");
    expect(pkg.scripts?.quality).toContain("pnpm package:check");
    expect(pkg.scripts?.quality).toContain("pnpm test");
    expect(pkg.scripts?.quality).toContain("pnpm security:scan");
    expect(pkg.scripts?.quality).toContain("pnpm stress:ci");
    expect(pkg.scripts?.quality).toContain("pnpm vscode:compile");
    expect(pkg.scripts?.["package:check"]).toContain("tsx src/release/packageCheck.ts");
    expect(pkg.scripts?.["security:scan"]).toContain("tsx src/security/scan.ts");
    expect(pkg.scripts?.["stress:ci"]).toContain("tsx src/index.ts stress");
    expect(pkg.scripts?.["vscode:compile"]).toContain("pnpm --dir apps/vscode compile");
    expect(pkg.scripts?.["release:connected"]).toContain("tsx src/release/connectedTask.ts");
    expect(pkg.scripts?.["release:check"]).toContain("pnpm quality");
    expect(pkg.scripts?.["release:check"]).toContain("pnpm release:connected");
    expect(pkg.scripts?.prepack).toContain("pnpm build");

    expect(ci).toContain("corepack enable");
    expect(ci).toContain("pnpm install --frozen-lockfile");
    expect(ci).toContain("pnpm quality");
  });

  it("keeps npm package publishing limited to runtime files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      files?: string[];
    };
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf-8")) as {
      exclude?: string[];
    };

    expect(pkg.files).toEqual([
      "dist/",
      "apps/ui/",
      "assets/demo-project/",
      "scripts/",
      "README.md",
      "USAGE_GUIDE.md",
      "PRODUCT.md",
      "DESIGN.md",
      ".env.example",
    ]);
    expect(tsconfig.exclude).toContain("src/**/*.test.ts");
  });

  it("includes the VS Code extension in the pnpm workspace", () => {
    const workspace = readFileSync("pnpm-workspace.yaml", "utf-8");

    expect(workspace).toContain("packages:");
    expect(workspace).toContain("apps/vscode");
  });

  it("keeps generated VS Code extension output out of git", () => {
    const ignoredPath = execFileSync("git", ["check-ignore", "apps/vscode/out/extension.js"], {
      encoding: "utf-8",
    }).trim();

    expect(ignoredPath.replaceAll("\\", "/")).toBe("apps/vscode/out/extension.js");
  });

  it("keeps the E2E smoke test runnable in normal CI", () => {
    const smokeTest = readFileSync("src/e2e/smoke.test.ts", "utf-8");

    expect(smokeTest).not.toContain(".skip");
    expect(smokeTest).not.toContain("skipIf");
  });

  it("detects real skipped and focused tests without flagging fixture strings", () => {
    const source = [
      'it("normal", () => {});',
      'const fixture = "it.skip(\\"fixture only\\", () => {})";',
      'test.skip("disabled", () => {});',
      'describe.only("focused", () => {});',
      'it.skipIf(process.platform === "win32")("conditional", () => {});',
    ].join("\n");

    expect(findDisabledOrFocusedTests("example.test.ts", source)).toEqual([
      { file: "example.test.ts", line: 3, pattern: "test.skip" },
      { file: "example.test.ts", line: 4, pattern: "describe.only" },
      { file: "example.test.ts", line: 5, pattern: "it.skipIf" },
    ]);
  });

  it("does not allow skipped, focused, or conditional test execution in committed tests", () => {
    expect(findDisabledOrFocusedTestsInProject()).toEqual([]);
  });
});

function findDisabledOrFocusedTestsInProject(): DisabledOrFocusedTestFinding[] {
  return SOURCE_ROOTS.flatMap((root) => collectTestFiles(root)).flatMap((filePath) =>
    findDisabledOrFocusedTests(normalizePath(filePath), readFileSync(filePath, "utf-8")),
  );
}

function findDisabledOrFocusedTests(file: string, source: string): DisabledOrFocusedTestFinding[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: DisabledOrFocusedTestFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const pattern = disabledOrFocusedTestPattern(node.expression);
      if (pattern) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart());
        findings.push({
          file,
          line: position.line + 1,
          pattern,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function disabledOrFocusedTestPattern(expression: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(expression)) return null;

  const property = expression.name.text;
  if (!DISABLED_OR_FOCUSED_TEST_APIS.has(property)) return null;

  const testGlobal = rootTestGlobal(expression.expression);
  return testGlobal ? `${testGlobal}.${property}` : null;
}

function rootTestGlobal(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return TEST_GLOBALS.has(expression.text) ? expression.text : null;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return rootTestGlobal(expression.expression);
  }

  if (ts.isCallExpression(expression)) {
    return rootTestGlobal(expression.expression);
  }

  return null;
}

function collectTestFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;

    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
