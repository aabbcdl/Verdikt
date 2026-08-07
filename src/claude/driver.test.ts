import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverInput } from "../types.js";
import { callClaudeOnce, callClaudeWithRetry } from "./driver.js";
import { killProcessTree } from "./processTree.js";

const mockKillProcessTree = vi.mocked(killProcessTree);

// Mock child_process
vi.mock("node:child_process", () => {
  const mockChild = {
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  return {
    spawn: vi.fn(() => mockChild),
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: "2.1.221 (Claude Code)\n",
      stderr: "",
    })),
  };
});

// Mock process-tree termination — the driver's contract is "request a tree
// kill"; the platform-specific mechanics have their own real-process tests.
vi.mock("./processTree.js", () => ({
  killProcessTree: vi.fn(),
}));

// Mock fs
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock config
vi.mock("../config.js", () => ({
  getConfig: () => ({
    model: "test-model",
    defaultTimeoutMs: 1000,
    defaultAbsoluteTimeoutMs: 5000,
    maxRetries: 1,
    stateDir: ".verdikt",
    concurrency: 1,
    verbose: false,
  }),
}));

describe("callClaude", () => {
  const baseInput: DriverInput = {
    systemPrompt: "You are a test assistant.",
    userPrompt: "Hello",
    cwd: "/tmp",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accumulates unknown timeout usage into the successful retry result", async () => {
    const attemptRunner = vi
      .fn()
      .mockResolvedValueOnce({
        text: "[TIMEOUT]",
        timedOut: true,
        durationMs: 10,
        usage: { status: "unknown" },
      })
      .mockResolvedValueOnce({
        text: "success",
        timedOut: false,
        durationMs: 10,
        costUsd: 0.25,
        usage: { status: "complete", costUsd: 0.25 },
      });

    const promise = callClaudeWithRetry(baseInput, undefined, attemptRunner);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(attemptRunner).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("success");
    expect(result.costUsd).toBe(0.25);
    expect(result.usage).toEqual(expect.objectContaining({ status: "partial", costUsd: 0.25 }));
  });

  it("accumulates driver-error usage into a later successful retry", async () => {
    const attemptRunner = vi
      .fn()
      .mockResolvedValueOnce({
        text: "[DRIVER ERROR] unavailable",
        timedOut: false,
        durationMs: 10,
        usage: { status: "unknown" },
      })
      .mockResolvedValueOnce({
        text: "success",
        timedOut: false,
        durationMs: 10,
        costUsd: 0.4,
        usage: { status: "complete", costUsd: 0.4 },
      });

    const promise = callClaudeWithRetry(baseInput, undefined, attemptRunner);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(attemptRunner).toHaveBeenCalledTimes(2);
    expect(result.usage?.status).toBe("partial");
    expect(result.totalCostUsd).toBeUndefined();
  });

  it("classifies provider credit failures without retrying them", async () => {
    const attemptRunner = vi.fn().mockResolvedValue({
      text: "[DRIVER ERROR] Claude exited with code 1\nAPI Error: 402 Insufficient credit",
      timedOut: false,
      durationMs: 10,
      usage: { status: "unknown" },
      failure: {
        kind: "provider_error",
        category: "insufficient_credit",
        statusCode: 402,
        message: "Insufficient credit",
        retryable: false,
      },
    });

    const result = await callClaudeWithRetry(baseInput, undefined, attemptRunner);

    expect(attemptRunner).toHaveBeenCalledOnce();
    expect(result.failure).toEqual(
      expect.objectContaining({
        kind: "provider_error",
        category: "insufficient_credit",
        statusCode: 402,
        retryable: false,
      }),
    );
  });

  it("extracts provider failures from Claude JSON error output", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const promise = callClaudeOnce(baseInput);
    stdoutHandler?.(
      Buffer.from(
        JSON.stringify({
          type: "result",
          is_error: true,
          api_error_status: 402,
          result: "API Error: 402 Insufficient credit",
        }),
      ),
    );
    closeHandler?.(1);

    const result = await promise;

    expect(result.failure).toEqual(
      expect.objectContaining({
        kind: "provider_error",
        category: "insufficient_credit",
        statusCode: 402,
        retryable: false,
      }),
    );
  });

  it("keeps a structured completed result usable when is_error is contradictory", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const promise = callClaudeOnce(baseInput);
    stdoutHandler?.(
      Buffer.from(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "completed",
          stop_reason: "end_turn",
          result: "Implemented and verified the requested change.",
        }),
      ),
    );
    closeHandler?.(1);

    const result = await promise;

    expect(result.failure).toBeUndefined();
    expect(result.text).toBe("Implemented and verified the requested change.");
    expect(result.termination).toEqual(
      expect.objectContaining({
        cliVersion: "2.1.221 (Claude Code)",
        endType: "success",
        terminalReason: "completed",
        stopReason: "end_turn",
        isError: true,
        exitCode: 1,
      }),
    );
  });

  it("classifies max-turn endings as process failures with structured diagnostics", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const promise = callClaudeOnce(baseInput);
    stdoutHandler?.(
      Buffer.from(
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          terminal_reason: "max_turns",
          stop_reason: "tool_use",
          errors: ["Reached maximum number of turns (12)"],
        }),
      ),
    );
    closeHandler?.(1);

    const result = await promise;

    expect(result.failure).toEqual(
      expect.objectContaining({
        kind: "process_error",
        message: "Reached maximum number of turns (12)",
        retryable: false,
        cliVersion: "2.1.221 (Claude Code)",
        endType: "error_max_turns",
        terminalReason: "max_turns",
        exitCode: 1,
      }),
    );
    expect(result.failure?.kind).not.toBe("provider_error");
  });

  it("returns text on successful JSON output", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );

    const promise = callClaudeOnce(baseInput);

    // Simulate stdout with JSON
    const jsonOutput = JSON.stringify({
      type: "result",
      result: "Hello, world!",
      total_cost_usd: 0.001,
    });
    stdoutHandler?.(Buffer.from(jsonOutput));

    // Simulate close
    closeHandler?.(0);

    const result = await promise;
    expect(result.text).toBe("Hello, world!");
    expect(result.costUsd).toBe(0.001);
    expect(result.timedOut).toBe(false);
  });

  it("does not trust JSON output from a failed Claude process", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    let stderrHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
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

    const promise = callClaudeOnce(baseInput);

    stdoutHandler?.(
      Buffer.from(
        JSON.stringify({
          type: "result",
          result: '{"done":true,"problems":[],"nextInstruction":""}',
          total_cost_usd: 0.001,
        }),
      ),
    );
    stderrHandler?.(Buffer.from("Claude CLI failed"));
    closeHandler?.(1);

    const result = await promise;
    expect(result.text).toContain("[DRIVER ERROR]");
    expect(result.text).toContain("code 1");
    expect(result.text).toContain("Claude CLI failed");
    expect(result.text).not.toBe('{"done":true,"problems":[],"nextInstruction":""}');
    expect(result.timedOut).toBe(false);
  });

  it("handles non-JSON output gracefully", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );

    const promise = callClaudeOnce(baseInput);

    // Simulate non-JSON stdout
    stdoutHandler?.(Buffer.from("This is plain text output"));

    closeHandler?.(0);

    const result = await promise;
    expect(result.text).toBe("This is plain text output");
    expect(result.timedOut).toBe(false);
  });

  it("caps raw Claude stdout before returning non-JSON output", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );

    const promise = callClaudeOnce(baseInput);

    stdoutHandler?.(Buffer.from("x".repeat(60_000)));
    closeHandler?.(0);

    const result = await promise;
    expect(result.text.length).toBeLessThanOrEqual(50_000);
    expect(result.timedOut).toBe(false);
  });

  it("extracts cost from legacy cost_usd field", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );

    const promise = callClaudeOnce(baseInput);

    const jsonOutput = JSON.stringify({
      type: "result",
      result: "Done",
      cost_usd: 0.05,
    });
    stdoutHandler?.(Buffer.from(jsonOutput));
    closeHandler?.(0);

    const result = await promise;
    expect(result.costUsd).toBe(0.05);
  });

  it("kills process on idle timeout", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );

    const promise = callClaudeOnce(baseInput);

    // Advance past idle timeout (1000ms) but not absolute (5000ms)
    await vi.advanceTimersByTimeAsync(1500);

    // Simulate process killed by SIGTERM (exit code null on signal)
    closeHandler?.(null as unknown as number);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.text).toContain("TIMEOUT");
  });

  it("kills process on abort without reporting a timeout", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );

    const controller = new AbortController();
    const promise = callClaudeOnce({ ...baseInput, signal: controller.signal });

    controller.abort();
    closeHandler?.(null as unknown as number);

    const result = await promise;
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGTERM");
    expect(result.timedOut).toBe(false);
    expect(result.text).toContain("CANCELLED");
  });

  it("kills process on absolute timeout even with output", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "data") stdoutHandler = handler as (chunk: Buffer) => void;
      },
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );

    const promise = callClaudeOnce(baseInput);

    // Simulate continuous output that resets idle timer
    for (let i = 0; i < 10; i++) {
      stdoutHandler?.(Buffer.from(`chunk ${i}`));
      await vi.advanceTimersByTimeAsync(400); // Less than idle timeout
    }

    // Now advance past absolute timeout (5000ms total)
    await vi.advanceTimersByTimeAsync(2000);

    closeHandler?.(null as unknown as number);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    // When stdout exists, it's returned even on timeout
    expect(result.text).toContain("chunk");
    expect(result.durationMs).toBeGreaterThanOrEqual(5000);
  });

  it("cleans up temp file on close", async () => {
    const { spawn } = await import("node:child_process");
    const { unlinkSync } = await import("node:fs");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );

    const promise = callClaudeOnce(baseInput);
    closeHandler?.(0);
    await promise;

    expect(unlinkSync).toHaveBeenCalled();
  });

  it("starts Claude without Node shell argument concatenation", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);

    let closeHandler: ((code: number) => void) | undefined;

    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, _handler: unknown) => {},
    );

    const promise = callClaudeOnce({
      ...baseInput,
      allowedTools: ["Read", "Bash; exit 1"],
    });

    const spawnCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    if (process.platform === "win32") {
      expect(String(spawnCall?.[0]).toLowerCase()).toContain("cmd");
      expect(spawnCall?.[1]).toEqual(
        expect.arrayContaining(["/d", "/s", "/c", expect.stringContaining("--allowedTools")]),
      );
      expect(spawnCall?.[2]).toMatchObject({ shell: false });
    } else {
      expect(spawnCall?.[0]).toBe("claude");
      expect(spawnCall?.[1]).toEqual(
        expect.arrayContaining(["--allowedTools", "Read,Bash; exit 1"]),
      );
      expect(spawnCall?.[2]).toMatchObject({ shell: false });
    }

    closeHandler?.(0);
    await promise;
  });

  it("handles process error", async () => {
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

    const promise = callClaudeOnce(baseInput);
    errorHandler?.(new Error("ENOENT"));

    const result = await promise;
    expect(result.text).toContain("DRIVER ERROR");
    expect(result.text).toContain("ENOENT");
    expect(result.timedOut).toBe(false);
  });

  it("uses a task-specific hard timeout instead of the global default", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);
    let closeHandler: ((code: number) => void) | undefined;
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const promise = callClaudeOnce({ ...baseInput, timeoutMs: 10_000, absoluteTimeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_100);
    closeHandler?.(null as unknown as number);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(2_000);
  });

  it("reports a soft stall before the hard timeout without killing the process", async () => {
    const { spawn } = await import("node:child_process");
    const mockChild = spawn("echo", []);
    let closeHandler: ((code: number) => void) | undefined;
    (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: unknown) => {
        if (event === "close") closeHandler = handler as (code: number) => void;
      },
    );
    (mockChild.stdout?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (mockChild.stderr?.on as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const onStall = vi.fn();

    const promise = callClaudeOnce(
      { ...baseInput, timeoutMs: 10_000, softTimeoutMs: 1_000, absoluteTimeoutMs: 3_000 },
      { onStall },
    );
    await vi.advanceTimersByTimeAsync(1_100);

    expect(onStall).toHaveBeenCalledWith(
      expect.objectContaining({ elapsedMs: expect.any(Number), outputIdleMs: expect.any(Number) }),
    );
    expect(mockKillProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    closeHandler?.(null as unknown as number);
    await promise;
    expect(mockKillProcessTree).toHaveBeenCalledWith(mockChild, "SIGTERM");
  });
});
