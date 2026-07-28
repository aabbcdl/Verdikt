import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPassedRun } from "../cli/apply.js";
import { verifyRunEvidence } from "../cli/evidence.js";
import { resetConfig, setConfig } from "../config.js";
import { resumeSupervisorLoop, runSupervisorLoop } from "../loop/supervisor.js";
import type { TaskSpec } from "../types.js";
import { checkLock } from "../workspace/lock.js";

const execFileAsync = promisify(execFile);

let tempDir = "";
let originalPath: string | undefined;
let originalPathExt: string | undefined;

describe("E2E Smoke Test", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-e2e-smoke-"));
    originalPath = process.env.PATH;
    originalPathExt = process.env.PATHEXT;
  });

  afterEach(async () => {
    restoreEnv();
    resetConfig();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs the full supervisor loop with a local Claude CLI double", async () => {
    const repoDir = join(tempDir, "repo");
    const stateDir = join(tempDir, ".verdikt");
    const fakeBin = join(tempDir, "bin");

    await initRepo(repoDir);
    await installFakeClaude(fakeBin);
    setConfig({
      stateDir,
      defaultTimeoutMs: 10_000,
      defaultAbsoluteTimeoutMs: 20_000,
      maxRetries: 0,
      model: "test-model",
    });

    const task: TaskSpec = {
      id: "e2e-smoke",
      goal: "Fix sum.cjs so sum(2, 3) returns 5.",
      repoPath: repoDir,
      maxIterations: 1,
      acceptance: {
        steps: [
          {
            id: "sum",
            command: "node",
            args: ["judge.cjs"],
            timeoutMs: 10_000,
          },
        ],
      },
    };

    const result = await runSupervisorLoop(task, { runId: "e2e-smoke-run", stream: false });

    expect(result.reason).toBe("passed");
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.changedFiles).toEqual(["sum.cjs"]);
    expect(result.patch?.filesChanged).toBe(1);
    expect(result.patch?.finalPatchPath).toBeTruthy();

    const finalPatch = await readFile(String(result.patch?.finalPatchPath), "utf-8");
    expect(finalPatch).toContain("a + b");

    const originalFile = await readFile(join(repoDir, "sum.cjs"), "utf-8");
    expect(originalFile).toContain("a - b");

    const runDir = join(stateDir, "e2e-smoke-run");
    const savedTask = JSON.parse(await readFile(join(runDir, "task.json"), "utf-8"));
    expect(savedTask.goal).toBe(task.goal);
    expect((await verifyRunEvidence("e2e-smoke-run")).valid).toBe(true);

    await applyPassedRun("e2e-smoke-run");
    const appliedFile = await readFile(join(repoDir, "sum.cjs"), "utf-8");
    expect(appliedFile).toContain("a + b");
    expect((await verifyRunEvidence("e2e-smoke-run")).valid).toBe(true);
  }, 60_000);

  it("cancels mid-executor without orphan processes, then resumes to a pass", async () => {
    const repoDir = join(tempDir, "repo");
    const stateDir = join(tempDir, ".verdikt");
    const fakeBin = join(tempDir, "bin");
    const pidFile = join(tempDir, "executor.pid");

    await initRepo(repoDir);
    await installFakeClaude(fakeBin, { sleepingExecutorPidFile: pidFile });
    setConfig({
      stateDir,
      defaultTimeoutMs: 30_000,
      defaultAbsoluteTimeoutMs: 60_000,
      maxRetries: 0,
      model: "test-model",
    });

    const task: TaskSpec = {
      id: "e2e-cancel",
      goal: "Fix sum.cjs so sum(2, 3) returns 5.",
      repoPath: repoDir,
      maxIterations: 1,
      acceptance: {
        steps: [{ id: "sum", command: "node", args: ["judge.cjs"], timeoutMs: 10_000 }],
      },
    };

    const controller = new AbortController();
    const runPromise = runSupervisorLoop(task, {
      runId: "e2e-cancel-run",
      stream: false,
      signal: controller.signal,
    });

    // Wait until the fake executor is actually running, then cancel mid-call.
    expect(await waitFor(() => existsSync(pidFile), 20_000)).toBe(true);
    const executorPid = Number((await readFile(pidFile, "utf-8")).trim());
    expect(isProcessAlive(executorPid)).toBe(true);
    controller.abort("user_cancel");

    const result = await runPromise;
    expect(result.reason).toBe("cancelled");
    expect(result.resumable).toBe(true);

    // 1. No orphan agent process: the tree kill must reach the real
    //    fake-claude node process, not only the shell wrapper.
    expect(await waitFor(() => !isProcessAlive(executorPid), 15_000)).toBe(true);

    // 2. The repository lock is released for the next run.
    expect(checkLock(stateDir, repoDir)).toBeNull();

    // 3. Resumable state and the isolated workspace survive.
    const runDir = join(stateDir, "e2e-cancel-run");
    expect(existsSync(join(runDir, "state.json"))).toBe(true);
    const workspacePath = String(result.workspace?.path);
    expect(existsSync(workspacePath)).toBe(true);

    // 4. A real resume completes the task with a normal executor.
    await installFakeClaude(fakeBin, {});
    const resumed = await resumeSupervisorLoop(runDir, { stream: false });
    expect(resumed.reason).toBe("passed");
    expect(resumed.patch?.finalPatchPath).toBeTruthy();
    const finalPatch = await readFile(String(resumed.patch?.finalPatchPath), "utf-8");
    expect(finalPatch).toContain("a + b");

    // The original repository stays untouched until an explicit apply.
    expect(await readFile(join(repoDir, "sum.cjs"), "utf-8")).toContain("a - b");
  }, 120_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(repoDir, "sum.cjs"), "exports.sum = (a, b) => a - b;\n", "utf-8");
  await writeFile(
    join(repoDir, "judge.cjs"),
    [
      'const { sum } = require("./sum.cjs");',
      "if (sum(2, 3) !== 5) {",
      '  console.error("sum(2, 3) should equal 5");',
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Verdikt Test"], { cwd: repoDir });
  await execFileAsync("git", ["add", "sum.cjs", "judge.cjs"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "initial", "--no-gpg-sign"], { cwd: repoDir });
}

async function installFakeClaude(
  fakeBin: string,
  options: { sleepingExecutorPidFile?: string } = {},
): Promise<void> {
  await mkdir(fakeBin, { recursive: true });
  const executorBody = options.sleepingExecutorPidFile
    ? [
        `  fs.writeFileSync(${JSON.stringify(options.sleepingExecutorPidFile)}, String(process.pid));`,
        '  fs.writeFileSync(path.join(process.cwd(), "sum.cjs"), "exports.sum = (a, b) => a + b;\\n");',
        "  // Keep running so the supervisor can be cancelled mid-executor.",
        '  setTimeout(() => emit("late executor"), 60000);',
      ]
    : [
        '  fs.writeFileSync(path.join(process.cwd(), "sum.cjs"), "exports.sum = (a, b) => a + b;\\n");',
        '  emit("Updated sum.cjs to add numbers.");',
      ];
  await writeFile(
    join(fakeBin, "fake-claude.cjs"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "",
      "const args = process.argv.slice(2);",
      'const allowedToolsIndex = args.indexOf("--allowedTools");',
      'const allowedTools = allowedToolsIndex >= 0 ? args[allowedToolsIndex + 1] || "" : "";',
      "",
      "function emit(result) {",
      '  process.stdout.write(JSON.stringify({ type: "result", result, total_cost_usd: 0.001 }));',
      "}",
      "",
      'if (allowedTools.includes("Write")) {',
      ...executorBody,
      "} else {",
      '  emit(JSON.stringify({ done: true, problems: [], nextInstruction: "" }));',
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );

  const unixLauncher = join(fakeBin, "claude");
  await writeFile(
    unixLauncher,
    '#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.cjs" "$@"\n',
    "utf-8",
  );
  await chmod(unixLauncher, 0o755).catch(() => {});

  await writeFile(
    join(fakeBin, "claude.cmd"),
    '@echo off\r\nnode "%~dp0fake-claude.cjs" %*\r\n',
    "utf-8",
  );

  process.env.PATH = [fakeBin, originalPath].filter(Boolean).join(delimiter);
  if (process.platform === "win32") {
    process.env.PATHEXT = [".CMD", ".EXE", ".BAT", originalPathExt ?? ""].filter(Boolean).join(";");
  }
}

function restoreEnv(): void {
  if (originalPath === undefined) {
    process.env.PATH = undefined;
  } else {
    process.env.PATH = originalPath;
  }

  if (originalPathExt === undefined) {
    process.env.PATHEXT = undefined;
  } else {
    process.env.PATHEXT = originalPathExt;
  }
}
