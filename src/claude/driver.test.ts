import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverInput } from "../types.js";
import { callClaudeOnce } from "./driver.js";

// Mock child_process
vi.mock("node:child_process", () => {
  const mockChild = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  return {
    spawn: vi.fn(() => mockChild),
  };
});

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
});
