import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Compare command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-compare-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when no run IDs provided", async () => {
    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare([])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when only one run ID provided", async () => {
    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare(["run-001"])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when first run not found", async () => {
    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare(["nonexistent-1", "nonexistent-2"])).rejects.toThrow(
        "Process exited with code 1",
      );
    } finally {
      process.exit = originalExit;
    }
  });
});
