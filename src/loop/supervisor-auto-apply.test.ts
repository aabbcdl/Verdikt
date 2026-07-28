import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import type { TaskSpec } from "../types.js";

vi.mock("../claude/driver.js", () => ({ callClaude: vi.fn() }));

import { callClaude } from "../claude/driver.js";
import { runSupervisorLoop } from "./supervisor.js";

const exec = promisify(execFile);

describe("SupervisorLoop auto-apply safety", () => {
  let root: string;
  let repo: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verdikt-auto-apply-"));
    repo = join(root, "repo");
    stateDir = join(root, "state");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "file.txt"), "before\n", "utf-8");
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", ["-C", repo, "commit", "-m", "base"]);
    setConfig({ stateDir, maxRetries: 0 });
    vi.mocked(callClaude).mockReset();
  });

  afterEach(async () => {
    resetConfig();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
    return {
      id: "auto-apply-safety",
      goal: "Update file.txt",
      repoPath: repo,
      acceptance: {
        steps: [{ id: "test", command: process.execPath, args: ["-e", "process.exit(0)"] }],
      },
      maxIterations: 1,
      ...overrides,
    };
  }

  function mockSuccessfulRun(onVerifier?: () => Promise<void>): void {
    vi.mocked(callClaude).mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        await writeFile(join(input.cwd, "file.txt"), "after\n", "utf-8");
        return { text: "Updated file.txt", timedOut: false, durationMs: 1 };
      }
      await onVerifier?.();
      return {
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 1,
      };
    });
  }

  it("refuses auto-apply when the original repository changes during the run", async () => {
    mockSuccessfulRun(async () => {
      await writeFile(join(repo, "concurrent.txt"), "user change\n", "utf-8");
    });

    await expect(
      runSupervisorLoop(task(), {
        runId: "auto-apply-concurrent",
        autoApply: true,
        skipIntegrity: true,
        stream: false,
      }),
    ).rejects.toThrow("revalidation_required");

    expect(await readFile(join(repo, "file.txt"), "utf-8")).toBe("before\n");
    expect(await readFile(join(repo, "concurrent.txt"), "utf-8")).toBe("user change\n");
  });

  it("runs blocking before_apply hooks before auto-apply changes the repository", async () => {
    await writeFile(
      join(repo, "deny.cjs"),
      'process.stdout.write(JSON.stringify({ allow: false, message: "blocked by hook" }));\n',
      "utf-8",
    );
    await exec("git", ["-C", repo, "add", "deny.cjs"]);
    await exec("git", ["-C", repo, "commit", "-m", "add hook"]);
    mockSuccessfulRun();

    await expect(
      runSupervisorLoop(
        task({
          hooks: [{ event: "before_apply", script: "deny.cjs", failureMode: "block" }],
        }),
        {
          runId: "auto-apply-hook",
          autoApply: true,
          skipIntegrity: true,
          stream: false,
        },
      ),
    ).rejects.toThrow("blocked by hook");

    expect(await readFile(join(repo, "file.txt"), "utf-8")).toBe("before\n");
  });
});
