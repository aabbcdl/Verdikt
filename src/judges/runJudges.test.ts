import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptanceCriteria } from "../types.js";
import { runJudges } from "./runJudges.js";

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

describe("runJudges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    const { exec } = await import("node:child_process");

    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _opts: unknown, cb: (error: null, stdout: string, stderr: string) => void) => {
        cb(null, "All tests passed", "");
      },
    );

    const acceptance: AcceptanceCriteria = {
      testCommand: "npm test",
    };

    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(true);
    expect(result.checks.length).toBe(1);
    expect(result.checks[0].name).toBe("test");
    expect(result.checks[0].passed).toBe(true);
  });

  it("runs testCommand and returns fail on exit 1", async () => {
    const { exec } = await import("node:child_process");

    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (error: { code: number } | null, stdout: string, stderr: string) => void,
      ) => {
        cb({ code: 1 }, "FAIL: 2 tests failed", "Error in test.js");
      },
    );

    const acceptance: AcceptanceCriteria = {
      testCommand: "npm test",
    };

    const result = await runJudges(acceptance, "/tmp");

    expect(result.passed).toBe(false);
    expect(result.checks.length).toBe(1);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].exitCode).toBe(1);
  });

  it("runs multiple commands (test + build + lint)", async () => {
    const { exec } = await import("node:child_process");

    let callCount = 0;
    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _opts: unknown, cb: (error: null, stdout: string, stderr: string) => void) => {
        callCount++;
        cb(null, `Output ${callCount}`, "");
      },
    );

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
