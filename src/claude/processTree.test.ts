/**
 * Real-process tests for killProcessTree.
 *
 * Spawns an actual parent process that spawns a grandchild, then verifies the
 * WHOLE tree dies — the exact guarantee `child.kill()` alone does not provide
 * on Windows.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killProcessTree } from "./processTree.js";

let tempDir = "";

function isAlive(pid: number): boolean {
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

describe("killProcessTree", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-proctree-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("terminates the grandchild process, not only the direct child", async () => {
    const pidFile = join(tempDir, "grandchild.pid");
    // Parent spawns a long-sleeping grandchild, records its pid, then sleeps.
    const parentScript = [
      "const {spawn} = require('node:child_process');",
      "const {writeFileSync} = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {stdio: 'ignore'});",
      `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      "setTimeout(()=>{}, 60000);",
    ].join("");
    const parent = spawn(process.execPath, ["-e", parentScript], { stdio: "ignore" });

    const pidWritten = await waitFor(() => existsSync(pidFile), 10_000);
    expect(pidWritten).toBe(true);
    const grandchildPid = Number((await readFile(pidFile, "utf-8")).trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    killProcessTree(parent, "SIGKILL");

    const parentDead = await waitFor(
      () => parent.pid === undefined || !isAlive(parent.pid),
      10_000,
    );
    const grandchildDead = await waitFor(() => !isAlive(grandchildPid), 10_000);
    expect(parentDead).toBe(true);
    expect(grandchildDead).toBe(true);
  });

  it("is a no-op for a child without a pid", () => {
    let killed = false;
    killProcessTree(
      {
        pid: undefined,
        kill: () => {
          killed = true;
          return true;
        },
      },
      "SIGTERM",
    );
    expect(killed).toBe(true);
  });
});
