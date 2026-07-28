/**
 * Judge — run objective acceptance commands and report pass/fail.
 *
 * M4.2: Supports structured judge steps (execFile, no shell chaining).
 * Falls back to simple command mode when steps are not defined.
 *
 * Judges are deterministic: they run commands and check exit codes.
 * No LLM involved. This is the ground truth.
 */

import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { killProcessTree } from "../claude/processTree.js";
import type {
  AcceptanceCriteria,
  CustomJudgeResult,
  JudgeCheck,
  JudgeResult,
  JudgeStep,
  JudgeStepResult,
} from "../types.js";

const SIGKILL_DELAY_MS = 5000;
const OUTPUT_LIMIT_CHARS = 50_000;

/**
 * Run all acceptance criteria as judge checks.
 *
 * Priority: custom > steps > testCommand.
 * Judges are deterministic: they run commands and check exit codes.
 * No LLM involved. This is the ground truth.
 */
export async function runJudges(
  acceptance: AcceptanceCriteria,
  cwd: string,
  signal?: AbortSignal,
): Promise<JudgeResult> {
  // M6: Custom judge script mode
  if (acceptance.custom) {
    return runCustomJudge(acceptance.custom, cwd, signal);
  }

  // M4.2: Structured steps mode
  if (acceptance.steps && acceptance.steps.length > 0) {
    return runStructuredSteps(acceptance.steps, cwd, signal);
  }

  // Legacy: simple command mode
  if (!acceptance.testCommand) {
    return {
      passed: false,
      checks: [
        {
          name: "test",
          passed: false,
          exitCode: 1,
          output: "No testCommand or steps defined in acceptance criteria",
          durationMs: 0,
        },
      ],
    };
  }

  const timeoutMs = acceptance.timeoutMs ?? 120_000;
  const checks: JudgeCheck[] = [];
  checks.push(await runCheck("test", acceptance.testCommand, cwd, timeoutMs, signal));

  if (acceptance.buildCommand) {
    checks.push(await runCheck("build", acceptance.buildCommand, cwd, timeoutMs, signal));
  }

  if (acceptance.lintCommand) {
    checks.push(await runCheck("lint", acceptance.lintCommand, cwd, timeoutMs, signal));
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * M4.2: Execute structured judge steps.
 * Each step runs via execFile (no shell), preserving per-step results.
 */
async function runStructuredSteps(
  steps: JudgeStep[],
  cwd: string,
  signal?: AbortSignal,
): Promise<JudgeResult> {
  const stepResults: JudgeStepResult[] = [];
  const checks: JudgeCheck[] = [];

  for (const step of steps) {
    const result = await runStep(step, cwd, signal);
    stepResults.push(result);

    // Convert to JudgeCheck for backward compatibility
    checks.push({
      name: step.id,
      passed: result.passed,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 50_000),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
  }

  const requiredResults = stepResults.filter((s) => s.required);
  if (requiredResults.length === 0) {
    checks.push({
      name: "acceptance",
      passed: false,
      output: "Structured acceptance must include at least one required step",
      exitCode: 1,
      durationMs: 0,
    });
  }

  // Overall passed: at least one required step must exist, and all required steps must pass.
  const passed = requiredResults.length > 0 && requiredResults.every((s) => s.passed);

  return { passed, checks, stepResults };
}

/**
 * Execute a single judge step.
 * Uses spawn with args array on Unix and a controlled cmd.exe wrapper on Windows.
 */
async function runStep(
  step: JudgeStep,
  defaultCwd: string,
  signal?: AbortSignal,
): Promise<JudgeStepResult> {
  const t0 = Date.now();
  const args = step.args ?? [];
  const timeoutMs = step.timeoutMs ?? 120_000; // Default 2 minutes

  return new Promise<JudgeStepResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    if (signal?.aborted) {
      resolve({
        id: step.id,
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: "Run cancelled before judge step started",
        durationMs: Date.now() - t0,
        required: step.required !== false,
      });
      return;
    }

    let invocation: ProcessInvocation;
    let stepCwd: string;
    try {
      validateJudgeStep(step);
      stepCwd = resolveStepCwd(defaultCwd, step.cwd);
      invocation = buildProcessInvocation(step.command, args);
    } catch (err) {
      resolve({
        id: step.id,
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: String(err instanceof Error ? err.message : err).slice(0, 50_000),
        durationMs: Date.now() - t0,
        required: step.required !== false,
      });
      return;
    }

    const child = spawn(invocation.command, invocation.args, {
      cwd: stepCwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Set configurable timeout
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, SIGKILL_DELAY_MS);
    }, timeoutMs);

    const abortHandler = () => {
      cancelled = true;
      killProcessTree(child, "SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      const finalStderr = cancelled
        ? "Run cancelled"
        : timedOut
          ? `Judge step "${step.id}" timed out after ${timeoutMs}ms`
          : stderr;
      resolve({
        id: step.id,
        passed: !cancelled && !timedOut && code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr: limitText(finalStderr),
        durationMs: Date.now() - t0,
        required: step.required !== false,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolve({
        id: step.id,
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: err.message.slice(0, 50_000),
        durationMs: Date.now() - t0,
        required: step.required !== false,
      });
    });
  });
}

/**
 * Run a single command and capture its result (legacy mode).
 */
async function runCheck(
  name: string,
  command: string,
  cwd: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<JudgeCheck> {
  const t0 = Date.now();
  const invalidCommand = validateLegacyCommand(command);
  if (invalidCommand) {
    return {
      name,
      passed: false,
      output: invalidCommand,
      exitCode: 1,
      durationMs: Date.now() - t0,
    };
  }

  return new Promise<JudgeCheck>((resolve) => {
    if (signal?.aborted) {
      resolve({
        name,
        passed: false,
        output: "Run cancelled before judge command started",
        exitCode: 1,
        durationMs: Date.now() - t0,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const settle = (check: JudgeCheck) => {
      if (settled) return;
      settled = true;
      resolve(check);
    };

    const child = spawn(command, [], {
      cwd,
      shell: process.platform === "win32" ? "powershell" : true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, SIGKILL_DELAY_MS);
    }, timeoutMs);

    const abortHandler = () => {
      cancelled = true;
      killProcessTree(child, "SIGTERM");
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const finalOutput = cancelled
        ? "Run cancelled"
        : timedOut
          ? [`Judge command "${name}" timed out after ${timeoutMs}ms`, output]
              .filter(Boolean)
              .join("\n")
          : output;
      settle({
        name,
        passed: !cancelled && !timedOut && code === 0,
        output: limitText(finalOutput),
        exitCode: code ?? 1,
        durationMs: Date.now() - t0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      settle({
        name,
        passed: false,
        output: limitText(err.message),
        exitCode: 1,
        durationMs: Date.now() - t0,
      });
    });
  });
}

function validateLegacyCommand(command: string): string | null {
  if (command.trim().length === 0) {
    return "Legacy judge command must not be empty";
  }
  if (/[\0\r\n]/.test(command)) {
    return "Legacy judge command must be a single line. Use acceptance.steps for multiple commands.";
  }
  return null;
}

function validateJudgeStep(step: JudgeStep): void {
  if (step.id.trim().length === 0) {
    throw new Error("Structured judge step id must not be empty");
  }
  if (step.command.trim().length === 0) {
    throw new Error("Structured judge step command must not be empty");
  }
}

/**
 * Run a custom judge script.
 *
 * The script must:
 * - Be a Node.js script (or executable)
 * - Output JSON to stdout matching CustomJudgeResult
 * - Exit 0 if passed, non-zero if failed
 *
 * Example custom judge script:
 * ```js
 * const result = { passed: true, summary: "All checks passed", details: [] };
 * console.log(JSON.stringify(result));
 * process.exit(0);
 * ```
 */
async function runCustomJudge(
  custom: { script: string; timeoutMs?: number; env?: Record<string, string> },
  cwd: string,
  signal?: AbortSignal,
): Promise<JudgeResult> {
  const t0 = Date.now();
  let scriptPath: string;
  try {
    scriptPath = resolveCustomJudgeScript(cwd, custom.script);
  } catch (err) {
    return {
      passed: false,
      checks: [
        {
          name: "custom",
          passed: false,
          output: String(err instanceof Error ? err.message : err).slice(0, 50_000),
          exitCode: 1,
          durationMs: Date.now() - t0,
        },
      ],
    };
  }
  const timeout = custom.timeoutMs ?? 30_000;

  return new Promise<JudgeResult>((resolveResult) => {
    if (signal?.aborted) {
      resolveResult({
        passed: false,
        checks: [
          {
            name: "custom",
            passed: false,
            output: "Run cancelled before custom judge started",
            exitCode: 1,
            durationMs: 0,
          },
        ],
      });
      return;
    }

    let cancelled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const child = spawn("node", [scriptPath], {
      cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...custom.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, SIGKILL_DELAY_MS);
    }, timeout);

    const abortHandler = () => {
      cancelled = true;
      killProcessTree(child, "SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    let stdout = "";
    let _stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      _stderr = appendLimited(_stderr, chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      if (cancelled || timedOut) {
        resolveResult({
          passed: false,
          checks: [
            {
              name: "custom",
              passed: false,
              output: cancelled ? "Run cancelled" : `Custom judge timed out after ${timeout}ms`,
              exitCode: code ?? 1,
              durationMs: Date.now() - t0,
            },
          ],
        });
        return;
      }

      let result: CustomJudgeResult;
      try {
        result = normalizeCustomJudgeResult(JSON.parse(stdout));
      } catch {
        result = {
          passed: false,
          summary: `Custom judge output is not valid JSON: ${stdout.slice(0, 200)}`,
        };
      }

      const exitCode = code ?? 1;
      const exitedCleanly = exitCode === 0;
      const checks: JudgeCheck[] = [];

      if (result.details && result.details.length > 0) {
        for (const d of result.details) {
          checks.push({
            name: d.name,
            passed: exitedCleanly && d.passed,
            output: d.message,
            exitCode: exitedCleanly && d.passed ? 0 : exitCode || 1,
            durationMs: Date.now() - t0,
          });
        }
      } else {
        checks.push({
          name: "custom",
          passed: exitedCleanly && result.passed,
          output: exitedCleanly ? result.summary : customJudgeExitMessage(exitCode, result.summary),
          exitCode,
          durationMs: Date.now() - t0,
        });
      }

      if ((!exitedCleanly || !result.passed) && checks.every((check) => check.passed)) {
        checks.push({
          name: "custom",
          passed: false,
          output: exitedCleanly ? result.summary : customJudgeExitMessage(exitCode, result.summary),
          exitCode: exitedCleanly ? 1 : exitCode,
          durationMs: Date.now() - t0,
        });
      }

      resolveResult({
        passed: exitedCleanly && result.passed && checks.every((check) => check.passed),
        checks,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolveResult({
        passed: false,
        checks: [
          {
            name: "custom",
            passed: false,
            output: `Failed to run custom judge: ${err.message}`,
            exitCode: 1,
            durationMs: 0,
          },
        ],
      });
    });
  });
}

function normalizeCustomJudgeResult(value: unknown): CustomJudgeResult {
  if (!isRecord(value)) {
    return {
      passed: false,
      summary: "Custom judge output must be a JSON object with a valid boolean passed field",
    };
  }

  if (typeof value.passed !== "boolean") {
    return {
      passed: false,
      summary: "Custom judge output must include a valid boolean passed field",
    };
  }

  const summary =
    typeof value.summary === "string" && value.summary.trim()
      ? value.summary
      : value.passed
        ? "Custom judge passed"
        : "Custom judge failed";

  const result: CustomJudgeResult = {
    passed: value.passed,
    summary,
  };

  if (Array.isArray(value.details)) {
    const details: CustomJudgeResult["details"] = [];
    for (const detail of value.details) {
      if (!isRecord(detail)) {
        return {
          passed: false,
          summary:
            "Custom judge details must contain objects with name, passed, and message fields",
        };
      }
      if (
        typeof detail.name !== "string" ||
        typeof detail.passed !== "boolean" ||
        typeof detail.message !== "string"
      ) {
        return {
          passed: false,
          summary: "Custom judge details must contain valid name, passed, and message fields",
        };
      }
      details.push({
        name: detail.name,
        passed: detail.passed,
        message: detail.message,
      });
    }
    result.details = details;
  }

  return result;
}

function customJudgeExitMessage(exitCode: number, summary: string): string {
  return `Custom judge exited with exit code ${exitCode}: ${summary}`;
}

function appendLimited(current: string, chunk: Buffer): string {
  const remaining = OUTPUT_LIMIT_CHARS - current.length;
  if (remaining <= 0) return current;
  return current + chunk.toString("utf-8", 0, remaining);
}

function limitText(value: string): string {
  return value.length > OUTPUT_LIMIT_CHARS ? value.slice(0, OUTPUT_LIMIT_CHARS) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProcessInvocation {
  command: string;
  args: string[];
}

function buildProcessInvocation(command: string, args: string[]): ProcessInvocation {
  if (process.platform !== "win32") {
    return { command, args };
  }

  assertWindowsShellSafeArgs([command, ...args]);
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", buildWindowsCommandLine(command, args)],
  };
}

function assertWindowsShellSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (/[\r\n"&|<>^%]/.test(arg)) {
      throw new Error(`Unsafe judge command argument: ${arg}`);
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

function resolveStepCwd(defaultCwd: string, stepCwd?: string): string {
  const repoRoot = resolve(defaultCwd);
  const resolvedCwd = stepCwd
    ? isAbsolute(stepCwd)
      ? resolve(stepCwd)
      : resolve(repoRoot, stepCwd)
    : repoRoot;

  if (!isPathInside(repoRoot, resolvedCwd)) {
    throw new Error(`Judge step cwd is outside the repository: ${stepCwd}`);
  }

  return resolvedCwd;
}

function resolveCustomJudgeScript(defaultCwd: string, scriptPath: string): string {
  if (scriptPath.trim().length === 0) {
    throw new Error("Custom judge script path must not be empty");
  }
  if (isAbsolute(scriptPath)) {
    throw new Error("Custom judge script must be relative to the repository root");
  }

  const repoRoot = resolve(defaultCwd);
  const resolvedScriptPath = resolve(repoRoot, scriptPath);
  if (!isPathInside(repoRoot, resolvedScriptPath)) {
    throw new Error(`Custom judge script is outside the repository: ${scriptPath}`);
  }

  return resolvedScriptPath;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
