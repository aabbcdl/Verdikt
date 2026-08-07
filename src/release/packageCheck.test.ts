import { describe, expect, it } from "vitest";
import { validatePackageFiles } from "./packageCheck.js";

describe("package publish check", () => {
  it("accepts the expected runtime package surface", () => {
    expect(
      validatePackageFiles([
        "package.json",
        "README.md",
        "USAGE_GUIDE.md",
        "PRODUCT.md",
        "DESIGN.md",
        ".env.example",
        "apps/ui/app.html",
        "apps/ui/index.html",
        "scripts/start-verdikt-app.ps1",
        "scripts/start-verdikt-app.sh",
        "assets/demo-project/package.json",
        "assets/demo-project/src/sum.js",
        "assets/demo-project/test/sum.test.js",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/cli/app.js",
        "dist/cli/app.js.map",
      ]),
    ).toEqual([]);
  });

  it("rejects source, tests, benchmark fixtures, and editor extension sources", () => {
    const findings = validatePackageFiles([
      "package.json",
      "dist/index.js",
      "apps/ui/app.html",
      "scripts/start-verdikt-app.ps1",
      "scripts/start-verdikt-app.sh",
      "assets/demo-project/package.json",
      "assets/demo-project/src/sum.js",
      "assets/demo-project/test/sum.test.js",
      "src/index.ts",
      "dist/index.test.js",
      "tasks/benchmark/s1-reverse.json",
      ".github/workflows/ci.yml",
      "apps/vscode/src/extension.ts",
      "assets/demo-project/node_modules/vitest/package.json",
      "assets/demo-project/.verdikt/run-001/summary.json",
    ]);

    expect(findings).toEqual([
      "Package includes non-runtime file: .github/workflows/ci.yml",
      "Package includes non-runtime file: apps/vscode/src/extension.ts",
      "Package includes non-runtime file: assets/demo-project/.verdikt/run-001/summary.json",
      "Package includes non-runtime file: assets/demo-project/node_modules/vitest/package.json",
      "Package includes test artifact: dist/index.test.js",
      "Package includes non-runtime file: src/index.ts",
      "Package includes non-runtime file: tasks/benchmark/s1-reverse.json",
    ]);
  });

  it("rejects packages missing required runtime entry files", () => {
    expect(validatePackageFiles(["package.json", "README.md"])).toEqual([
      "Package is missing required runtime file: dist/index.js",
      "Package is missing required runtime file: apps/ui/app.html",
      "Package is missing required runtime file: scripts/start-verdikt-app.ps1",
      "Package is missing required runtime file: scripts/start-verdikt-app.sh",
      "Package is missing required runtime file: assets/demo-project/package.json",
      "Package is missing required runtime file: assets/demo-project/src/sum.js",
      "Package is missing required runtime file: assets/demo-project/test/sum.test.js",
    ]);
  });
});
