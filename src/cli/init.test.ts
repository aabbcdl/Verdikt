import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Init command", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-init-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates task spec file with default values", async () => {
    const { handleInit } = await import("./init.js");

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await handleInit(["my-task", "."]);

      // Should have created the file
      const taskFile = join(tempDir, "my-task.task.json");
      expect(existsSync(taskFile)).toBe(true);

      // Verify content
      const content = JSON.parse(await readFile(taskFile, "utf-8"));
      expect(content.id).toBe("my-task");
      expect(content.goal).toBe("Describe what the executor should accomplish");
      expect(content.maxIterations).toBe(5);
      expect(content.maxBudgetUsd).toBe(10);
      expect(content.integrity.allowTestChanges).toBe(false);
      expect(content.semantic.maxRisk).toBe("low");

      // Should have printed success message
      const output = logs.join("\n");
      expect(output).toContain("Task spec created");
    } finally {
      console.log = originalLog;
    }
  });

  it("creates benchmark suite template", async () => {
    const { handleInit } = await import("./init.js");

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await handleInit(["--suite"]);

      // Should have created the file
      const suiteFile = join(tempDir, "benchmark.suite.json");
      expect(existsSync(suiteFile)).toBe(true);

      // Verify content
      const content = JSON.parse(await readFile(suiteFile, "utf-8"));
      expect(content.id).toBe("my-benchmark");
      expect(content.tasks.length).toBe(1);
      expect(content.tasks[0].taskId).toBe("task-1");

      // Should have printed success message
      const output = logs.join("\n");
      expect(output).toContain("Benchmark suite template created");
    } finally {
      console.log = originalLog;
    }
  });

  it("uses default id when not specified", async () => {
    const { handleInit } = await import("./init.js");

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await handleInit([]);

      // Should have created with default id
      const taskFile = join(tempDir, "my-task.task.json");
      expect(existsSync(taskFile)).toBe(true);

      const content = JSON.parse(await readFile(taskFile, "utf-8"));
      expect(content.id).toBe("my-task");
    } finally {
      console.log = originalLog;
    }
  });
});
