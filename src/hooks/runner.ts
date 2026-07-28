import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { killProcessTree } from "../claude/processTree.js";
import type { LifecycleHookEvent, LifecycleHookSpec, TaskSpec } from "../types.js";

export interface LifecycleHookResult {
  event: LifecycleHookEvent;
  script: string;
  allowed: boolean;
  message?: string;
  error?: string;
  durationMs: number;
}

export async function runLifecycleHooks(
  task: TaskSpec,
  event: LifecycleHookEvent,
  context: Record<string, unknown>,
  cwd = task.repoPath,
): Promise<LifecycleHookResult[]> {
  const hooks = (task.hooks ?? []).filter((hook) => hook.event === event);
  const results: LifecycleHookResult[] = [];
  for (const hook of hooks) {
    const result = await runHook(task, hook, event, context, cwd);
    results.push(result);
    const blocking =
      hook.failureMode === "block" ||
      (hook.failureMode === undefined && (event === "before_run" || event === "before_apply"));
    if (blocking && !result.allowed) {
      throw new Error(
        result.message || result.error || `Lifecycle hook ${hook.script} blocked ${event}`,
      );
    }
  }
  return results;
}

async function runHook(
  task: TaskSpec,
  hook: LifecycleHookSpec,
  event: LifecycleHookEvent,
  context: Record<string, unknown>,
  cwd: string,
): Promise<LifecycleHookResult> {
  const startedAt = Date.now();
  try {
    const repoRoot = resolve(task.repoPath);
    if (!hook.script.trim() || isAbsolute(hook.script))
      throw new Error("Hook script must be relative to the repository root");
    const script = resolve(repoRoot, hook.script);
    if (!isPathInside(repoRoot, script) || !existsSync(script)) {
      throw new Error(`Hook script not found or outside repository: ${hook.script}`);
    }
    if (!/\.(?:c?js|mjs)$/i.test(script))
      throw new Error("Hook script must be a .js, .cjs, or .mjs file");
    const output = await runNodeScript(script, cwd, hook.timeoutMs ?? 15_000, {
      event,
      taskId: task.id,
      goal: task.goal,
      repoPath: task.repoPath,
      ...context,
    });
    const parsed = parseHookOutput(output);
    return {
      event,
      script: hook.script,
      allowed: parsed.allow !== false,
      message: parsed.message,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      event,
      script: hook.script,
      allowed: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function runNodeScript(
  script: string,
  cwd: string,
  timeoutMs: number,
  input: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child, "SIGKILL");
      reject(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 100_000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Hook exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolveResult(stdout);
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

function parseHookOutput(stdout: string): { allow?: boolean; message?: string } {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return {};
  const parsed = JSON.parse(line) as Record<string, unknown>;
  return {
    allow: typeof parsed.allow === "boolean" ? parsed.allow : undefined,
    message: typeof parsed.message === "string" ? parsed.message : undefined,
  };
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(resolve(basePath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
