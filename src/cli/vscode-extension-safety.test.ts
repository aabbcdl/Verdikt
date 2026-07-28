import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("VS Code extension safety guards", () => {
  it("keeps webviews scriptless and escapes saved-run HTML fields", async () => {
    const source = await readFile(
      join(process.cwd(), "apps", "vscode", "src", "extension.ts"),
      "utf-8",
    );

    expect(source).toMatch(/enableScripts:\s*false/);
    expect(source).toContain("function escapeHtml");
    expect(source).toContain("function isValidRunId");
    expect(source).toContain("function isPathInside");
  });

  it("looks for Verdikt runs in the active workspace by default", async () => {
    const source = await readFile(
      join(process.cwd(), "apps", "vscode", "src", "extension.ts"),
      "utf-8",
    );

    expect(source).toContain("vscode.workspace.workspaceFolders");
    expect(source).toContain("VERDIKT_STATE_DIR");
    expect(source).toMatch(/path\.join\([^)]*workspaceRoot[^)]*"\.verdikt"/);
  });
});
