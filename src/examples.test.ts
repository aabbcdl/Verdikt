import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskSpec } from "./types.js";
import { validateTaskSpec } from "./validation.js";

describe("bundled examples", () => {
  it("keeps the root demo task runnable from the project root", () => {
    const task = readJson<TaskSpec>("examples/demo.task.json");
    if (task.repoPath && !isAbsoluteLike(task.repoPath)) {
      task.repoPath = resolve("examples", task.repoPath);
    }

    const validation = validateTaskSpec(task, "examples/demo.task.json");

    expect(validation.valid, validation.errors.map((error) => error.message).join("\n")).toBe(true);
  });

  it("keeps the failing-test demo in a broken state so Verdikt has something to fix", () => {
    const source = readFileSync("examples/demo-failing-test/src/sum.ts", "utf-8");

    expect(source).toContain("a - b");
    expect(source).not.toContain("a + b");
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}
