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
import type { DriverFailure, DriverInput, DriverOutput, UsageSummary } from "../types.js";
import { mergeUsage, usageFromClaudeResult, usageFromLegacyCost } from "../usage.js";
import { killProcessTree } from "./processTree.js";

// Timeout constants
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;
const SIGKILL_DELAY_MS = 5000;
// Caps raw stdout retention. In non-streaming JSON mode an oversized final
// result line can be truncated past this cap; parseOutput then falls back to
// raw text with usage "unknown" — degraded but safe (judge stays the gate).
const RAW_OUTPUT_LIMIT_CHARS = 200_000;
const FINAL_TEXT_LIMIT_CHARS = 50_000;

/**
 * Options for streaming output.
 */
export interface StallSignal {
  elapsedMs: number;
  outputIdleMs: number;
}

export interface StreamCallbacks {
  /** Called with each text chunk as it arrives */
  onChunk?: (text: string) => void;
  /** Called when output has been quiet past the soft threshold. */
  onStall?: (signal: StallSignal) => void;
  /** Called when streaming completes with the full accumulated text */
  onComplete?: (text: string, costUsd?: number, usage?: UsageSummary) => void;
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
  if (output.text.includes("[CANCELLED]")) return false;
  // Structured provider failures are surfaced to the user instead of triggering
  // another paid or otherwise meaningless provider request.
  if (output.failure) return output.failure.retryable;
  // Timeout is transient ? the process may have been slow
  if (output.timedOut) return true;
  // Backward-compatible fallback for unstructured process failures.
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
  attemptRunner: (
    input: DriverInput,
    streamCallbacks?: StreamCallbacks,
  ) => Promise<DriverOutput> = callClaudeOnce,
): Promise<DriverOutput> {
  const config = getConfig();
  const maxRetries = config.maxRetries;
  let lastOutput: DriverOutput | null = null;
  let totalUsage: UsageSummary | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Don't use stream callbacks on retries to avoid duplicate output
    const callbacks = attempt === 0 ? streamCallbacks : undefined;
    const output = await attemptRunner(input, callbacks);
    const attemptUsage = output.usage ?? usageFromLegacyCost(output.costUsd);
    totalUsage = mergeUsage(totalUsage, attemptUsage);
    const withTotalUsage: DriverOutput = {
      ...output,
      costUsd: totalUsage.costUsd,
      usage: totalUsage,
    };

    // If successful or non-transient, return immediately with every attempt accounted for.
    if (!isTransientFailure(output)) {
      return withTotalUsage;
    }

    lastOutput = withTotalUsage;

    // If we have retries left, wait with exponential backoff
    if (attempt < maxRetries) {
      const backoffMs = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
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
  const absoluteTimeoutMs = input.absoluteTimeoutMs ?? config.defaultAbsoluteTimeoutMs;
  const softTimeoutMs =
    input.softTimeoutMs ?? config.defaultSoftTimeoutMs ?? Math.min(timeoutMs, absoluteTimeoutMs);
  const t0 = Date.now();

  // Write system prompt to a temp file to avoid shell escaping issues
  const tmpFile = join(
    tmpdir(),
    `verdikt-sys-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  writeFileSync(tmpFile, input.systemPrompt, "utf-8");
  const settingsFile = input.commandPolicy
    ? join(tmpdir(), `verdikt-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    : undefined;
  if (settingsFile) {
    const commandHookPath = join(import.meta.dirname, "../risk/commandHook.js");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|PowerShell",
              hooks: [
                {
                  type: "command",
                  command: `${quoteHookCommand(process.execPath)} ${quoteHookCommand(commandHookPath)}`,
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );
  }

  const tempFiles = [tmpFile, settingsFile].filter((file): file is string => Boolean(file));
  const useStreaming = !!streamCallbacks?.onChunk;

  // Build CLI arguments separately from the executable. User prompt stays on stdin.
  const invocation = buildClaudeInvocation(input, config, tmpFile, useStreaming, settingsFile);

  return new Promise<DriverOutput>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;
    let cancelled = false;
    let lastOutputAt = t0;

    if (input.signal?.aborted) {
      cleanupTempFiles(tempFiles);
      resolve({
        text: "[CANCELLED] Claude Code run cancelled before start",
        timedOut: false,
        durationMs: Date.now() - t0,
      });
      return;
    }

    const child: ChildProcess = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
        ...(input.commandPolicy
          ? { VERDIKT_COMMAND_POLICY: JSON.stringify(input.commandPolicy) }
          : {}),
      },
    });

    // Write user prompt to stdin and close
    if (child.stdin) {
      // Claude may exit before consuming stdin; an unhandled EPIPE on the
      // stdin stream would crash the whole process.
      child.stdin.on("error", () => {});
      child.stdin.write(input.userPrompt);
      child.stdin.end();
    }

    const killProcess = (reason: "idle" | "absolute" | "cancelled") => {
      if (resolved) return;
      resolved = true;
      cancelled = reason === "cancelled";
      timedOut = !cancelled;
      // Tree kill: on Windows the direct child is a cmd.exe wrapper — killing
      // only it would leave the real claude process running (and billing).
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, SIGKILL_DELAY_MS);
    };

    const abortHandler = () => {
      killProcess("cancelled");
    };
    input.signal?.addEventListener("abort", abortHandler, { once: true });

    const resetActivityTimers = () => {
      lastOutputAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      if (softTimer) clearTimeout(softTimer);
      idleTimer = setTimeout(() => {
        killProcess("idle");
      }, timeoutMs);
      if (softTimeoutMs > 0 && softTimeoutMs < timeoutMs) {
        softTimer = setTimeout(() => {
          streamCallbacks?.onStall?.({
            elapsedMs: Date.now() - t0,
            outputIdleMs: Date.now() - lastOutputAt,
          });
        }, softTimeoutMs);
      }
    };

    resetActivityTimers();

    absoluteTimer = setTimeout(() => {
      killProcess("absolute");
    }, absoluteTimeoutMs);

    // Streaming state
    let streamBuffer = "";
    let accumulatedText = "";
    let streamUsage: UsageSummary | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendLimited(stdout, text, RAW_OUTPUT_LIMIT_CHARS);
      resetActivityTimers();

      if (useStreaming) {
        streamBuffer = appendLimited(streamBuffer, text, RAW_OUTPUT_LIMIT_CHARS);
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
                  accumulatedText = appendLimited(
                    accumulatedText,
                    block.text,
                    FINAL_TEXT_LIMIT_CHARS,
                  );
                  streamCallbacks?.onChunk?.(block.text);
                }
              }
            }
            if (event.type === "result") {
              streamUsage = usageFromClaudeResult(event as Record<string, unknown>);
            }
          } catch {
            // Not JSON — skip
          }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString(), RAW_OUTPUT_LIMIT_CHARS);
      resetActivityTimers();
    });

    child.on("close", (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (softTimer) clearTimeout(softTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", abortHandler);

      cleanupTempFiles(tempFiles);

      const durationMs = Date.now() - t0;

      if (cancelled) {
        resolve({
          text: limitText(
            stdout || `[CANCELLED after ${durationMs}ms] Claude Code run cancelled`,
            FINAL_TEXT_LIMIT_CHARS,
          ),
          timedOut: false,
          durationMs,
        });
        return;
      }

      if (timedOut) {
        const timeoutType = durationMs >= absoluteTimeoutMs ? "absolute" : "idle";
        resolve({
          text: limitText(
            stdout ||
              `[TIMEOUT after ${durationMs}ms] Claude Code ${timeoutType} timeout (${timeoutType === "absolute" ? absoluteTimeoutMs : timeoutMs}ms)`,
            FINAL_TEXT_LIMIT_CHARS,
          ),
          timedOut: true,
          durationMs,
        });
        return;
      }

      const exitCode = code ?? 1;
      const output = parseOutput(stdout, stderr, exitCode);
      const finalText = exitCode === 0 ? accumulatedText || output.text : output.text;
      const finalUsage = exitCode === 0 ? (streamUsage ?? output.usage) : output.usage;
      const finalCost = finalUsage?.costUsd;

      if (useStreaming && streamCallbacks?.onComplete) {
        streamCallbacks.onComplete(finalText, finalCost, finalUsage);
      }

      resolve({
        text: finalText,
        costUsd: finalCost,
        usage: finalUsage,
        timedOut: false,
        durationMs,
        failure: output.failure,
      });
    });

    child.on("error", (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (softTimer) clearTimeout(softTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", abortHandler);
      cleanupTempFiles(tempFiles);
      resolve({
        text: `[DRIVER ERROR] ${err.message}`,
        timedOut: false,
        durationMs: Date.now() - t0,
        failure: {
          kind: "process_error",
          category: "configuration",
          message: err.message,
          retryable: true,
        },
      });
    });
  });
}

/**
 * Build the Claude process invocation.
 *
 * System prompt goes to a temp file read via @path syntax.
 * User prompt comes via stdin (separate write above).
 * This avoids all shell escaping issues with multi-line text.
 */
function cleanupTempFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  }
}

function quoteHookCommand(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildClaudeInvocation(
  input: DriverInput,
  config: ReturnType<typeof getConfig>,
  sysPromptFile: string,
  useStreaming = false,
  settingsFile?: string,
): { command: string; args: string[]; shell: boolean } {
  const args = [
    "--print",
    "--output-format",
    useStreaming ? "stream-json" : "json",
    "--model",
    config.model,
  ];

  // stream-json requires --verbose
  if (useStreaming) {
    args.push("--verbose");
  }

  // System prompt from file — use @ prefix for file path
  args.push("--system-prompt", `@${sysPromptFile}`);
  if (settingsFile) args.push("--settings", settingsFile);

  if (input.allowedTools && input.allowedTools.length > 0) {
    args.push("--allowedTools", input.allowedTools.join(","));
  }

  // User prompt comes via stdin, not as an argument
  // stdin reads until EOF when no positional arg is given and --print is used

  if (process.platform === "win32") {
    assertWindowsShellSafeArgs(args);
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildWindowsCommandLine("claude", args)],
      shell: false,
    };
  }

  return {
    command: "claude",
    args,
    shell: false,
  };
}

function assertWindowsShellSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (/[\r\n"&|<>^%]/.test(arg)) {
      throw new Error(`Unsafe Claude CLI argument: ${arg}`);
    }
  }
}

function buildWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCmdArg).join(" ");
}

function quoteWindowsCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/\s/.test(arg)) return arg;
  return `"${arg}"`;
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
type ParsedClaudeOutput = {
  text: string;
  costUsd?: number;
  usage: UsageSummary;
  failure?: DriverFailure;
};

function parseOutput(stdout: string, stderr: string, exitCode: number): ParsedClaudeOutput {
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  const parsedJson = parseJsonObject(stdout);

  if (parsedJson) {
    const usage = usageFromClaudeResult(parsedJson);
    const text = limitText(
      String(parsedJson.result ?? parsedJson.text ?? stdout),
      FINAL_TEXT_LIMIT_CHARS,
    );
    const failure = classifyProviderFailure(parsedJson, details);
    if (failure) {
      return {
        text: limitText(
          `[DRIVER ERROR] Claude exited with code ${exitCode}\n${text}`,
          FINAL_TEXT_LIMIT_CHARS,
        ),
        usage,
        failure,
      };
    }
    if (exitCode === 0) {
      return { text, costUsd: usage.costUsd, usage };
    }
  }

  if (exitCode !== 0) {
    const failure = classifyProviderFailure(undefined, details);
    return {
      text: limitText(
        `[DRIVER ERROR] Claude exited with code ${exitCode}${details ? `\n${details}` : ""}`,
        FINAL_TEXT_LIMIT_CHARS,
      ),
      usage: { status: "unknown" },
      failure,
    };
  }

  return {
    text: limitText(
      stdout.trim() || stderr.trim() || `[EXIT ${exitCode}] No output`,
      FINAL_TEXT_LIMIT_CHARS,
    ),
    usage: { status: "unknown" },
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Stream output may contain non-JSON lines before the final result.
    }
  }
  return undefined;
}

function classifyProviderFailure(
  parsed: Record<string, unknown> | undefined,
  details: string,
): DriverFailure | undefined {
  const rawStatus = parsed?.api_error_status ?? parsed?.statusCode ?? parsed?.status;
  const statusCode =
    typeof rawStatus === "number"
      ? rawStatus
      : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus)
        ? Number(rawStatus)
        : undefined;
  const rawMessage = parsed?.result ?? parsed?.error ?? parsed?.message;
  const message = typeof rawMessage === "string" ? rawMessage : details;
  const haystack = `${message} ${details}`.toLocaleLowerCase();
  const isProviderPayload = Boolean(
    parsed?.is_error === true ||
      parsed?.terminal_reason === "api_error" ||
      parsed?.api_error_status !== undefined,
  );
  const looksLikeProviderFailure =
    isProviderPayload ||
    /insufficient credit|authentication|not logged in|rate limit|too many requests|overloaded|service unavailable|api error/i.test(
      haystack,
    );
  if (!looksLikeProviderFailure) return undefined;

  let category: DriverFailure["category"] = "unknown";
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /authentication|not logged in|unauthorized|forbidden/i.test(haystack)
  ) {
    category = "authentication";
  } else if (
    statusCode === 402 ||
    /insufficient credit|insufficient funds|billing|credit balance/i.test(haystack)
  ) {
    category = "insufficient_credit";
  } else if (statusCode === 429 || /rate limit|too many requests/i.test(haystack)) {
    category = "rate_limited";
  } else if (
    (statusCode !== undefined && statusCode >= 500) ||
    /overloaded|service unavailable|temporarily unavailable/i.test(haystack)
  ) {
    category = "service_unavailable";
  }

  return {
    kind: "provider_error",
    category,
    statusCode,
    message: limitText(message || "Claude provider request failed", 500),
    retryable: false,
  };
}

function appendLimited(current: string, addition: string, limit: number): string {
  const remaining = limit - current.length;
  if (remaining <= 0) return current;
  return current + addition.slice(0, remaining);
}

function limitText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}
