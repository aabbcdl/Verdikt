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
      "src/index.ts",
      "dist/index.test.js",
      "tasks/benchmark/s1-reverse.json",
      ".github/workflows/ci.yml",
      "apps/vscode/src/extension.ts",
    ]);

    expect(findings).toEqual([
      "Package includes non-runtime file: .github/workflows/ci.yml",
      "Package includes non-runtime file: apps/vscode/src/extension.ts",
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
    ]);
  });
});
