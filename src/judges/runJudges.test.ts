import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "../claude/processTree.js";
import type { AcceptanceCriteria } from "../types.js";
import { runJudges } from "./runJudges.js";

// The judge's contract is "request a tree kill" — platform mechanics are
// covered by processTree's own real-process tests.
vi.mock("../claude/processTree.js", () => ({
  killProcessTree: vi.fn(),
}));

const mockKillProcessTree = vi.mocked(killProcessTree);

// Mock child_process
vi.mock("node:child_process", () => {
  const mockChild = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  return {
    spawn: vi.fn(() => mockChild),
    exec: vi.fn(),
  };
});

async function prepareSpawnResult(stdout = "", stderr = "", code: number | null = 0) {
  const { spawn } = await import("node:child_process");
  const mockChild = spawn("echo", []);
  (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();
  (mockChild.kill as ReturnType<typeof vi.fn>).mockClear();

  let stdoutHandler: ((chunk: Buffer) => void) | undefined;
  let stderrHandler: ((chunk: Buffer) => void) | undefined;
  (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, handler: unknown) => {
      if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
    },
  );
  (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, handler: unknown) => {
      if (event === "data") stderrHandler = handler as (chunk: Buffer) => void;
    },
  );
  (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
    (event: string, handler: unknown) => {
      if (event === "close") {
        stdoutHandler?.(Buffer.from(stdout));
        stderrHandler?.(Buffer.from(stderr));
        (handler as (code: number | null) => void)(code);
      }
    },
  );

  return { spawn, mockChild };
}

describe("runJudges", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { exec } = await import("node:child_process");
    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (error: { code: number } | null, stdout: string, stderr: string) => void,
      ) => {
        cb({ code: 127 }, "", "legacy exec mock should not be used");
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns failure when no acceptance criteria defined", async () => {
    const acceptance: AcceptanceCriteria = {};
    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks.length).toBe(1);
    expect(result.checks[0].name).toBe("test");
    expect(result.checks[0].output).toContain("No testCommand or steps");
  });

  it("runs testCommand and returns pass on exit 0", async () => {
    const { spawn } = await prepareSpawnResult("All tests passed");

    const acceptance: AcceptanceCriteria = {
      testCommand: "npm test",
    };

    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(true);
    expect(result.checks.length).toBe(1);
    expect(result.checks[0].name).toBe("test");
    expect(result.checks[0].passed).toBe(true);
    expect(spawn).toHaveBeenCalled();
  });

  it("runs testCommand and returns fail on exit 1", async () => {
    await prepareSpawnResult("FAIL: 2 tests failed", "Error in test.js", 1);

    const acceptance: AcceptanceCriteria = {
      testCommand: "npm test",
    };

    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks.length).toBe(1);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].exitCode).toBe(1);
  });

  it("reports legacy command timeouts clearly", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    let closeHandler: ((code: number | null) => void) | undefined;
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number | null) => void;
      },
    );

    const promise = runJudges({ testCommand: "npm test", timeoutMs: 100 }, "/tmp");
    await vi.advanceTimersByTimeAsync(100);
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGTERM");
    closeHandler?.(null);

    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("timed out after 100ms");
  });

  it("rejects legacy commands with newlines without invoking a shell", async () => {
    const { exec, spawn } = await import("node:child_process");
    (exec as unknown as ReturnType<typeof vi.fn>).mockClear();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges({ testCommand: "npm test\nnpm run build" }, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("Legacy judge command must be a single line");
    expect(exec).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects blank legacy commands without invoking a shell", async () => {
    const { exec, spawn } = await import("node:child_process");
    (exec as unknown as ReturnType<typeof vi.fn>).mockClear();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges({ testCommand: "   " }, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("must not be empty");
    expect(exec).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs multiple commands (test + build + lint)", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();
    let callCount = 0;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") {
          callCount++;
          stdoutHandler?.(Buffer.from(`Output ${callCount}`));
          (handler as (code: number) => void)(0);
        }
      },
    );

    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockChild);

    const acceptance: AcceptanceCriteria = {
      testCommand: "npm test",
      buildCommand: "npm run build",
      lintCommand: "npm run lint",
    };

    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(true);
    expect(result.checks.length).toBe(3);
    expect(result.checks[0].name).toBe("test");
    expect(result.checks[1].name).toBe("build");
    expect(result.checks[2].name).toBe("lint");
  });

  it("runs legacy commands through spawn so output is streamed and bounded", async () => {
    const { exec, spawn } = await import("node:child_process");
    await prepareSpawnResult("All tests passed");
    (exec as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges({ testCommand: "npm test" }, "/tmp");

    expect(result.passed).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      "npm test",
      [],
      expect.objectContaining({
        cwd: "/tmp",
        shell: process.platform === "win32" ? "powershell" : true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("fails when structured steps contain no required checks", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") (handler as (code: number) => void)(0);
      },
    );

    const acceptance: AcceptanceCriteria = {
      steps: [{ id: "lint", command: "npm", args: ["run", "lint"], required: false }],
    };

    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks.some((check) => check.name === "acceptance")).toBe(true);
  });

  it("runs structured steps without shell argument concatenation", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") (handler as (code: number) => void)(0);
      },
    );

    await runJudges({ steps: [{ id: "test", command: "npm", args: ["test"] }] }, "/tmp");

    const spawnCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    if (process.platform === "win32") {
      expect(String(spawnCall?.[0]).toLowerCase()).toContain("cmd");
      expect(spawnCall?.[1]).toEqual(
        expect.arrayContaining(["/d", "/s", "/c", expect.stringContaining("npm")]),
      );
    } else {
      expect(spawnCall?.[0]).toBe("npm");
      expect(spawnCall?.[1]).toEqual(["test"]);
    }
    expect(spawnCall?.[2]).toMatchObject({ shell: false });
  });

  it("rejects structured steps with blank identifiers or commands before spawning", async () => {
    const { spawn } = await import("node:child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const blankCommand = await runJudges({ steps: [{ id: "test", command: "   " }] }, "/tmp");
    const blankId = await runJudges({ steps: [{ id: "   ", command: "npm" }] }, "/tmp");

    expect(blankCommand.passed).toBe(false);
    expect(blankCommand.checks[0].output).toContain("command must not be empty");
    expect(blankId.passed).toBe(false);
    expect(blankId.checks[0].output).toContain("id must not be empty");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves structured step cwd relative to the repository root", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") (handler as (code: number) => void)(0);
      },
    );

    const repoRoot = resolve("repo-root");
    await runJudges(
      {
        steps: [{ id: "test", command: "npm", args: ["test"], cwd: "packages/app" }],
      },
      repoRoot,
    );

    const spawnCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(spawnCall?.[2]).toMatchObject({ cwd: resolve(repoRoot, "packages/app") });
  });

  it("rejects structured step cwd values outside the repository root", async () => {
    const { spawn } = await import("node:child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges(
      {
        steps: [{ id: "test", command: "npm", args: ["test"], cwd: ".." }],
      },
      resolve("repo-root"),
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("outside the repository");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs custom judge scripts without shell argument concatenation", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.stdout.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") {
          stdoutHandler?.(Buffer.from(JSON.stringify({ passed: true, summary: "ok" })));
          (handler as (code: number) => void)(0);
        }
      },
    );

    await runJudges({ custom: { script: "judge.js" } }, "/tmp");

    const spawnCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(spawnCall?.[0]).toBe("node");
    expect(spawnCall?.[1]).toEqual([expect.stringContaining("judge.js")]);
    expect(spawnCall?.[2]).toMatchObject({ shell: false });
  });

  it("fails custom judge output when passed is not a boolean", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.stdout.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") {
          stdoutHandler?.(Buffer.from(JSON.stringify({ passed: "true", summary: "ok" })));
          (handler as (code: number) => void)(0);
        }
      },
    );

    const result = await runJudges({ custom: { script: "judge.js" } }, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].output).toContain("valid boolean");
  });

  it("fails custom judge output when the script exits non-zero", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.stdout.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") {
          stdoutHandler?.(Buffer.from(JSON.stringify({ passed: true, summary: "ok" })));
          (handler as (code: number) => void)(1);
        }
      },
    );

    const result = await runJudges({ custom: { script: "judge.js" } }, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].output).toContain("exit code 1");
  });

  it("fails custom judge output when any detail fails", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.stdout.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") {
          stdoutHandler?.(
            Buffer.from(
              JSON.stringify({
                passed: true,
                summary: "all good",
                details: [{ name: "acceptance", passed: false, message: "missing required UI" }],
              }),
            ),
          );
          (handler as (code: number) => void)(0);
        }
      },
    );

    const result = await runJudges({ custom: { script: "judge.js" } }, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "acceptance",
      passed: false,
      output: "missing required UI",
    });
  });

  it("rejects custom judge scripts that leave the repository root", async () => {
    const { spawn } = await import("node:child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges({ custom: { script: "../judge.js" } }, resolve("repo-root"));

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("outside the repository");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects absolute custom judge script paths", async () => {
    const { spawn } = await import("node:child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges(
      { custom: { script: resolve("repo-root", "judge.js") } },
      resolve("repo-root"),
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("relative to the repository root");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects blank custom judge script paths before spawning", async () => {
    const { spawn } = await import("node:child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockClear();

    const result = await runJudges({ custom: { script: "   " } }, resolve("repo-root"));

    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("must not be empty");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills a structured step when the run is cancelled", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;

    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );

    const controller = new AbortController();
    const promise = runJudges(
      {
        steps: [{ id: "test", command: "npm", args: ["test"] }],
      },
      "/tmp",
      controller.signal,
    );

    controller.abort();
    closeHandler?.(null as unknown as number);

    const result = await promise;
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGTERM");
    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("cancelled");
  });

  it("reports structured step timeouts and escalates to a forced kill", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number | null) => void) | undefined;

    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number | null) => void;
      },
    );

    const promise = runJudges(
      {
        steps: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 100 }],
      },
      "/tmp",
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGTERM");

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGKILL");

    closeHandler?.(null);

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("timed out after 100ms");
  });

  it("reports custom judge timeouts and escalates to a forced kill", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number | null) => void) | undefined;

    (mockChild.stdout.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number | null) => void;
      },
    );

    const promise = runJudges({ custom: { script: "judge.js", timeoutMs: 100 } }, "/tmp");

    await vi.advanceTimersByTimeAsync(100);
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGTERM");

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGKILL");

    closeHandler?.(null);

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.checks[0].output).toContain("timed out after 100ms");
  });

  it("handles spawn error gracefully", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let errorHandler: ((err: Error) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "error") errorHandler = handler as (err: Error) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );

    const acceptance: AcceptanceCriteria = {
      steps: [{ id: "test", command: "npm", args: ["test"] }],
    };

    const promise = runJudges(acceptance, "/tmp");
    errorHandler?.(new Error("ENOENT"));

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].output).toContain("ENOENT");
  });
});
