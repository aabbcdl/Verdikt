import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Resume command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-resume-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when run directory does not exist", async () => {
    // Import the handler
    const { handleResume } = await import("./resume.js");

    // Mock process.exit to prevent actual exit
    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume(["nonexistent-run"])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when run has no state file", async () => {
    const runDir = join(tempDir, "completed-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ status: "passed" }));

    const { handleResume } = await import("./resume.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume(["completed-run"])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when no run ID provided", async () => {
    const { handleResume } = await import("./resume.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume([])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });
});
