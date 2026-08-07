import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getConfig, setConfig } from "../config.js";
import { runSupervisorLoop } from "../loop/supervisor.js";
import type { TaskSpec } from "../types.js";
import type { VerdictResult } from "../verdict/types.js";

const execFileAsync = promisify(execFile);
const INITIAL_SOURCE = [
  '"use strict";',
  "",
  "function greet(name) {",
  '  return "Hello " + name;',
  "}",
  "",
  "module.exports = { greet };",
  "",
].join("\n");

export interface ConnectedTaskOutcome {
  stopReason: string;
  verdictStatus: string;
  recommendation: string;
  requiredPassed: number;
  requiredTotal: number;
  patchFilesChanged: number;
  patchContainsExpectedChange: boolean;
}

export function connectedTaskFindings(outcome: ConnectedTaskOutcome): string[] {
  const findings: string[] = [];
  if (outcome.stopReason !== "passed") {
    findings.push(`stopReason must be passed; received ${outcome.stopReason}`);
  }
  if (outcome.verdictStatus !== "pass") {
    findings.push(`verdict status must be pass; received ${outcome.verdictStatus}`);
  }
  if (outcome.recommendation !== "accept_change") {
    findings.push(`recommendation must be accept_change; received ${outcome.recommendation}`);
  }
  if (outcome.requiredTotal < 1 || outcome.requiredPassed !== outcome.requiredTotal) {
    findings.push(
      `required criteria must all pass; received ${outcome.requiredPassed}/${outcome.requiredTotal}`,
    );
  }
  if (outcome.patchFilesChanged !== 1) {
    findings.push(`patchFilesChanged must be 1; received ${outcome.patchFilesChanged}`);
  }
  if (!outcome.patchContainsExpectedChange) {
    findings.push("patch did not contain the expected isolated greeting fix");
  }
  return findings;
}

export async function readConnectedRuntimeOutput(
  workspacePath: string | undefined,
): Promise<string> {
  if (!workspacePath) return "";
  return execFileAsync(
    process.execPath,
    ["-e", 'process.stdout.write(require("./greeting.cjs").greet("Ada"))'],
    {
      cwd: workspacePath,
      encoding: "utf-8",
    },
  )
    .then(({ stdout }) => stdout)
    .catch(() => "");
}

async function runConnectedTask(): Promise<ConnectedTaskOutcome> {
  const root = await mkdtemp(join(tmpdir(), "verdikt-connected-"));
  const repoPath = join(root, "project");
  const stateDir = join(root, "state");
  const previousConfig = getConfig();

  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repoPath, { recursive: true }));
    await writeFile(join(repoPath, "greeting.cjs"), INITIAL_SOURCE, "utf-8");
    await writeFile(
      join(repoPath, "greeting.test.cjs"),
      [
        '"use strict";',
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        'const { greet } = require("./greeting.cjs");',
        "",
        'test("greets a named person with punctuation", () => {',
        '  assert.equal(greet("Ada"), "Hello, Ada!");',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );
    await runGit(repoPath, ["init"]);
    await runGit(repoPath, ["config", "user.name", "Verdikt Release Check"]);
    await runGit(repoPath, ["config", "user.email", "release-check@verdikt.local"]);
    await runGit(repoPath, ["add", "."]);
    await runGit(repoPath, ["commit", "-m", "connected check fixture"]);

    setConfig({ ...previousConfig, stateDir, maxRetries: 0 });
    const task: TaskSpec = {
      id: "release-connected-greeting",
      runSource: "test",
      goal: [
        "Fix greeting.cjs so greet(name) returns exactly `Hello, ${name}!`.",
        "Do not modify greeting.test.cjs or add dependencies.",
        "Run the provided test and keep the change limited to greeting.cjs.",
      ].join(" "),
      repoPath,
      acceptance: {
        steps: [
          {
            id: "test",
            command: process.execPath,
            args: ["--test", "greeting.test.cjs"],
            required: true,
            timeoutMs: 30_000,
          },
        ],
      },
      maxIterations: 2,
      execution: {
        idleTimeoutMs: 180_000,
        softTimeoutMs: 90_000,
        hardTimeoutMs: 360_000,
      },
      integrity: {
        enabled: true,
        allowTestChanges: false,
        allowConfigChanges: false,
        allowPackageScriptChanges: false,
      },
    };

    const runId = "release-connected";
    const result = await runSupervisorLoop(task, {
      runId,
      autoApply: false,
      stream: false,
    });
    const verdict = JSON.parse(
      await readFile(join(stateDir, runId, "verdict.json"), "utf-8"),
    ) as VerdictResult;
    const requiredCriteria = verdict.criteria.filter((criterion) => criterion.required);
    const changedFiles = [...new Set(result.iterations.flatMap((item) => item.changedFiles))];
    const workspacePath = result.workspace?.path;
    const patchedSource = workspacePath
      ? await readFile(join(workspacePath, "greeting.cjs"), "utf-8").catch(() => "")
      : "";
    const patchText = await readFile(
      result.patch?.finalPatchPath ?? join(stateDir, runId, "evidence", "final.patch"),
      "utf-8",
    ).catch(() => "");
    const runtimeOutput = await readConnectedRuntimeOutput(workspacePath);
    const patchContainsExpectedChange =
      changedFiles.length === 1 &&
      changedFiles[0]?.replaceAll("\\", "/") === "greeting.cjs" &&
      patchedSource !== INITIAL_SOURCE &&
      runtimeOutput === "Hello, Ada!" &&
      patchText.includes("greeting.cjs") &&
      !patchText.includes("greeting.test.cjs");

    return {
      stopReason: result.reason,
      verdictStatus: verdict.status,
      recommendation: verdict.recommendation,
      requiredPassed: requiredCriteria.filter((criterion) => criterion.status === "pass").length,
      requiredTotal: requiredCriteria.length,
      patchFilesChanged: result.patch?.filesChanged ?? changedFiles.length,
      patchContainsExpectedChange,
    };
  } finally {
    setConfig(previousConfig);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf-8" });
}

async function main(): Promise<void> {
  const outcome = await runConnectedTask();
  const findings = connectedTaskFindings(outcome);
  if (findings.length > 0) {
    console.error("Verdikt connected release task failed");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Verdikt connected release task passed");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("src/release/connectedTask.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
