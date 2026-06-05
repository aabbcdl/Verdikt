/**
 * Judge — run objective acceptance commands and report pass/fail.
 *
 * M4.2: Supports structured judge steps (execFile, no shell chaining).
 * Falls back to simple command mode when steps are not defined.
 *
 * Judges are deterministic: they run commands and check exit codes.
 * No LLM involved. This is the ground truth.
 */

import { type ExecException, exec, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AcceptanceCriteria, CustomJudgeResult, JudgeCheck, JudgeResult, JudgeStep, JudgeStepResult } from "../types.js";

/**
 * Run all acceptance criteria as judge checks.
 *
 * Priority: custom > steps > testCommand.
 * Judges are deterministic: they run commands and check exit codes.
 * No LLM involved. This is the ground truth.
 */
export async function runJudges(acceptance: AcceptanceCriteria, cwd: string): Promise<JudgeResult> {
  // M6: Custom judge script mode
  if (acceptance.custom) {
    return runCustomJudge(acceptance.custom, cwd);
  }

  // M4.2: Structured steps mode
  if (acceptance.steps && acceptance.steps.length > 0) {
    return runStructuredSteps(acceptance.steps, cwd);
  }

  // Legacy: simple command mode
  if (!acceptance.testCommand) {
    return {
      passed: false,
      checks: [{ name: "test", passed: false, exitCode: 1, output: "No testCommand or steps defined in acceptance criteria", durationMs: 0 }],
    };
  }

  const checks: JudgeCheck[] = [];
  checks.push(await runCheck("test", acceptance.testCommand, cwd));

  if (acceptance.buildCommand) {
    checks.push(await runCheck("build", acceptance.buildCommand, cwd));
  }

  if (acceptance.lintCommand) {
    checks.push(await runCheck("lint", acceptance.lintCommand, cwd));
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
async function runStructuredSteps(steps: JudgeStep[], cwd: string): Promise<JudgeResult> {
  const stepResults: JudgeStepResult[] = [];
  const checks: JudgeCheck[] = [];

  for (const step of steps) {
    const result = await runStep(step, cwd);
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

  // Overall passed: all required steps must pass
  const passed = stepResults
    .filter((s) => s.required)
    .every((s) => s.passed);

  return { passed, checks, stepResults };
}

/**
 * Execute a single judge step.
 * Uses spawn with args array for cross-platform compatibility.
 * On Windows, shell:true is needed for .cmd shims; args are passed as array.
 */
async function runStep(step: JudgeStep, defaultCwd: string): Promise<JudgeStepResult> {
  const t0 = Date.now();
  const stepCwd = step.cwd ?? defaultCwd;
  const args = step.args ?? [];

  return new Promise<JudgeStepResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(step.command, args, {
      cwd: stepCwd,
      shell: true, // Required on Windows for .cmd shims
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Set timeout
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120_000);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        id: step.id,
        passed: code === 0,
        exitCode: code ?? 1,
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 50_000),
        durationMs: Date.now() - t0,
        required: step.required !== false,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
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
async function runCheck(name: string, command: string, cwd: string): Promise<JudgeCheck> {
  const t0 = Date.now();

  return new Promise<JudgeCheck>((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: 120_000,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        shell: process.platform === "win32" ? "powershell" : undefined,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error: ExecException | null, stdout: string, stderr: string) => {
        const output = [stdout ?? "", stderr ?? ""].filter(Boolean).join("\n");
        resolve({
          name,
          passed: error === null,
          output: output.slice(0, 50_000),
          exitCode: error?.code ?? (error ? 1 : 0),
          durationMs: Date.now() - t0,
        });
      },
    );
  });
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
): Promise<JudgeResult> {
  const scriptPath = resolve(cwd, custom.script);
  const timeout = custom.timeoutMs ?? 30_000;

  return new Promise<JudgeResult>((resolveResult) => {
    const child = spawn("node", [scriptPath], {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...custom.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      let result: CustomJudgeResult;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = {
          passed: false,
          summary: `Custom judge output is not valid JSON: ${stdout.slice(0, 200)}`,
        };
      }

      const checks: JudgeCheck[] = [];

      if (result.details && result.details.length > 0) {
        for (const d of result.details) {
          checks.push({
            name: d.name,
            passed: d.passed,
            output: d.message,
            exitCode: d.passed ? 0 : 1,
            durationMs: 0,
          });
        }
      } else {
        checks.push({
          name: "custom",
          passed: result.passed,
          output: result.summary,
          exitCode: code ?? 1,
          durationMs: 0,
        });
      }

      resolveResult({
        passed: result.passed,
        checks,
      });
    });

    child.on("error", (err) => {
      resolveResult({
        passed: false,
        checks: [{
          name: "custom",
          passed: false,
          output: `Failed to run custom judge: ${err.message}`,
          exitCode: 1,
          durationMs: 0,
        }],
      });
    });
  });
}
