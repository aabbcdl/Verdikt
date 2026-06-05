/**
 * Claude Code CLI driver — the only place we invoke `claude`.
 *
 * Uses `claude --print --output-format json` for headless execution.
 * Implements two timeouts:
 * - Idle timeout: resets on each chunk of output (default 5 min)
 * - Absolute timeout: never resets, hard wall-clock kill (default 10 min)
 *
 * Key design: passes user prompt via stdin to avoid shell-escaping issues
 * with multi-line prompts on Windows.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.js";
import type { DriverInput, DriverOutput } from "../types.js";

/**
 * Options for streaming output.
 */
export interface StreamCallbacks {
  /** Called with each text chunk as it arrives */
  onChunk?: (text: string) => void;
  /** Called when streaming completes with the full accumulated text */
  onComplete?: (text: string, costUsd?: number) => void;
}

/**
 * Backward-compatible alias for callClaudeWithRetry.
 * @deprecated Use callClaudeWithRetry directly for clarity.
 */
export const callClaude = callClaudeWithRetry;

/**
 * Exported for testing single-attempt behavior.
 */
export { callClaudeOnce };

/**
 * Check if a driver output indicates a transient failure worth retrying.
 */
function isTransientFailure(output: DriverOutput): boolean {
  // Timeout is transient — the process may have been slow
  if (output.timedOut) return true;
  // Driver errors (process spawn failures) are transient
  if (output.text.includes("[DRIVER ERROR]")) return true;
  return false;
}

/**
 * Call Claude Code CLI with retry logic for transient failures.
 *
 * Retries on timeout and driver errors with exponential backoff.
 * Max retries is configurable via config.maxRetries (default 2).
 */
export async function callClaudeWithRetry(
  input: DriverInput,
  streamCallbacks?: StreamCallbacks,
): Promise<DriverOutput> {
  const config = getConfig();
  const maxRetries = config.maxRetries;
  let lastOutput: DriverOutput | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Don't use stream callbacks on retries to avoid duplicate output
    const callbacks = attempt === 0 ? streamCallbacks : undefined;
    const output = await callClaudeOnce(input, callbacks);

    // If successful or non-transient, return immediately
    if (!isTransientFailure(output)) {
      return output;
    }

    lastOutput = output;

    // If we have retries left, wait with exponential backoff
    if (attempt < maxRetries) {
      const backoffMs = Math.min(1000 * 2 ** attempt, 10000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // All retries exhausted — return last output
  return (
    lastOutput ?? { text: "[DRIVER ERROR] All retries exhausted", timedOut: false, durationMs: 0 }
  );
}

/**
 * Call Claude Code CLI in headless mode (single attempt).
 *
 * Returns DriverOutput on success/timeout — never throws.
 * Timeout is "idle timeout": resets every time we receive output.
 * Only fires when no data arrives for `timeoutMs` milliseconds.
 *
 * When streamCallbacks are provided, uses --output-format stream-json
 * for real-time progress feedback.
 */
async function callClaudeOnce(
  input: DriverInput,
  streamCallbacks?: StreamCallbacks,
): Promise<DriverOutput> {
  const config = getConfig();
  const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
  const t0 = Date.now();

  // Write system prompt to a temp file to avoid shell escaping issues
  const tmpFile = join(
    tmpdir(),
    `verdikt-sys-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  writeFileSync(tmpFile, input.systemPrompt, "utf-8");

  const useStreaming = !!streamCallbacks?.onChunk;

  // Build the command string. We use "pipe" for stdin and write the user prompt there.
  const cmdStr = buildCommandString(input, config, tmpFile, useStreaming);

  return new Promise<DriverOutput>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const child: ChildProcess = spawn(cmdStr, [], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true, // Required on Windows for .cmd shims
      env: {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
      },
    });

    // Write user prompt to stdin and close
    if (child.stdin) {
      child.stdin.write(input.userPrompt);
      child.stdin.end();
    }

    const killProcess = (_reason: string) => {
      if (resolved) return;
      resolved = true;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 5000);
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killProcess("idle");
      }, timeoutMs);
    };

    // Start the idle timer immediately
    resetIdle();

    // Start the absolute timer — never resets, hard kill
    const absoluteTimeoutMs = config.defaultAbsoluteTimeoutMs;
    absoluteTimer = setTimeout(() => {
      killProcess("absolute");
    }, absoluteTimeoutMs);

    // Streaming state
    let streamBuffer = "";
    let accumulatedText = "";
    let streamCost: number | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      resetIdle();

      if (useStreaming) {
        streamBuffer += text;
        // Process complete lines
        const lines = streamBuffer.split("\n");
        streamBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  accumulatedText += block.text;
                  streamCallbacks?.onChunk?.(block.text);
                }
              }
            }
            if (event.type === "result") {
              if (event.total_cost_usd !== undefined) {
                streamCost = event.total_cost_usd;
              }
            }
          } catch {
            // Not JSON — skip
          }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      resetIdle();
    });

    child.on("close", (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);

      // Cleanup temp file
      try {
        unlinkSync(tmpFile);
      } catch {
        /* already gone */
      }

      const durationMs = Date.now() - t0;

      if (timedOut) {
        const timeoutType = durationMs >= absoluteTimeoutMs ? "absolute" : "idle";
        resolve({
          text:
            stdout ||
            `[TIMEOUT after ${durationMs}ms] Claude Code ${timeoutType} timeout (${timeoutType === "absolute" ? absoluteTimeoutMs : timeoutMs}ms)`,
          timedOut: true,
          durationMs,
        });
        return;
      }

      const output = parseOutput(stdout, stderr, code ?? 1);
      const finalText = accumulatedText || output.text;
      const finalCost = streamCost ?? output.costUsd;

      if (useStreaming && streamCallbacks?.onComplete) {
        streamCallbacks.onComplete(finalText, finalCost);
      }

      resolve({
        text: finalText,
        costUsd: finalCost,
        timedOut: false,
        durationMs,
      });
    });

    child.on("error", (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      resolve({
        text: `[DRIVER ERROR] ${err.message}`,
        timedOut: false,
        durationMs: Date.now() - t0,
      });
    });
  });
}

/**
 * Build the full shell command string.
 *
 * System prompt goes to a temp file read via @path syntax.
 * User prompt comes via stdin (separate write above).
 * This avoids all shell escaping issues with multi-line text.
 */
function buildCommandString(
  input: DriverInput,
  config: ReturnType<typeof getConfig>,
  sysPromptFile: string,
  useStreaming = false,
): string {
  const parts = [
    "claude",
    "--print",
    "--output-format",
    useStreaming ? "stream-json" : "json",
    "--model",
    config.model,
  ];

  // System prompt from file — use @ prefix for file path
  parts.push("--system-prompt", `@"${sysPromptFile}"`);

  if (input.allowedTools && input.allowedTools.length > 0) {
    parts.push("--allowedTools", input.allowedTools.join(","));
  }

  // User prompt comes via stdin, not as an argument
  // stdin reads until EOF when no positional arg is given and --print is used

  return parts.join(" ");
}

/**
 * Parse the JSON output from `claude --print --output-format json`.
 * Falls back gracefully if parsing fails.
 *
 * Claude CLI JSON structure:
 * {
 *   "type": "result",
 *   "result": "the text response",
 *   "total_cost_usd": 1.43,
 *   "usage": { ... }
 * }
 */
function parseOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): { text: string; costUsd?: number } {
  // Try to parse JSON output
  try {
    const json = JSON.parse(stdout);
    return {
      text: json.result ?? json.text ?? stdout,
      // Claude CLI uses "total_cost_usd" at top level
      costUsd: extractCost(json),
    };
  } catch {
    // Not JSON — return raw text
    return {
      text: stdout.trim() || stderr.trim() || `[EXIT ${exitCode}] No output`,
    };
  }
}

/**
 * Extract cost from Claude CLI JSON output.
 * Tries multiple known field locations.
 */
function extractCost(json: Record<string, unknown>): number | undefined {
  // Top-level "total_cost_usd" (standard Claude CLI format)
  if (typeof json.total_cost_usd === "number") return json.total_cost_usd;
  // Alternative: nested in result object
  if (typeof json.result === "object" && json.result !== null) {
    const result = json.result as Record<string, unknown>;
    if (typeof result.total_cost_usd === "number") return result.total_cost_usd;
  }
  // Legacy: "cost_usd"
  if (typeof json.cost_usd === "number") return json.cost_usd;
  return undefined;
}
