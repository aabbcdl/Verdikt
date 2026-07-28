import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, checkLock, releaseLock, renewLock } from "./lock.js";
import { canonicalizeRepoPath } from "./repoIdentity.js";

async function lockFilePath(stateDir: string): Promise<string> {
  const locksDir = join(stateDir, "locks");
  const [fileName] = await readdir(locksDir);
  return join(locksDir, fileName);
}

async function rewriteLockFile(
  stateDir: string,
  mutate: (info: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const path = await lockFilePath(stateDir);
  const info = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify(mutate(info)));
}

async function backdateLockFile(stateDir: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs).toISOString();
  await rewriteLockFile(stateDir, (info) => ({ ...info, acquiredAt: past, heartbeatAt: past }));
}

function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid ?? 0));
    child.once("error", reject);
  });
}

describe("Concurrency Lock", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-lock-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("acquireLock", () => {
    it("succeeds when no lock exists", () => {
      const result = acquireLock(tempDir, "/repo/path", "run-001");
      expect(result).toBe(true);
    });

    it("treats path aliases as the same repository", () => {
      const alias = join(tempDir, ".");
      expect(acquireLock(tempDir, tempDir, "run-first")).toBe(true);
      expect(acquireLock(tempDir, alias, "run-second")).toBe(false);
    });

    it("fails when lock exists and is fresh", () => {
      acquireLock(tempDir, "/repo/path", "run-001");
      const result = acquireLock(tempDir, "/repo/path", "run-002");
      expect(result).toBe(false);
    });

    it("takes over a lock whose heartbeat expired more than an hour ago", async () => {
      // Real path: acquire, then backdate the actual lock file on disk.
      expect(acquireLock(tempDir, "/repo/path", "run-old")).toBe(true);
      await backdateLockFile(tempDir, 2 * 60 * 60 * 1000);

      expect(acquireLock(tempDir, "/repo/path", "run-new")).toBe(true);
      expect(checkLock(tempDir, "/repo/path")?.runId).toBe("run-new");
      // The takeover produced exactly one fresh holder — the next claimant loses.
      expect(acquireLock(tempDir, "/repo/path", "run-third")).toBe(false);
    });

    it("treats a lock whose owner process is dead as stale immediately", async () => {
      expect(acquireLock(tempDir, "/repo/path", "run-crashed")).toBe(true);
      // Fresh heartbeat, but the recorded owner no longer exists.
      const deadPid = await spawnDeadPid();
      await rewriteLockFile(tempDir, (info) => ({ ...info, ownerPid: deadPid }));

      expect(checkLock(tempDir, "/repo/path")).toBeNull();
      expect(acquireLock(tempDir, "/repo/path", "run-new")).toBe(true);
      expect(checkLock(tempDir, "/repo/path")?.runId).toBe("run-new");
    });

    it("creates lock file with correct content", () => {
      acquireLock(tempDir, "/repo/path", "run-001");

      // Find the lock file
      const locksDir = join(tempDir, "locks");
      expect(existsSync(locksDir)).toBe(true);

      const { readdirSync, readFileSync } = require("node:fs");
      const files = readdirSync(locksDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.lock$/);

      const info = JSON.parse(readFileSync(join(locksDir, files[0]), "utf-8"));
      expect(info.runId).toBe("run-001");
      expect(info.repoPath).toBe(canonicalizeRepoPath("/repo/path"));
      expect(info.acquiredAt).toBeDefined();
    });
  });

  describe("releaseLock", () => {
    it("removes lock file", () => {
      acquireLock(tempDir, "/repo/path", "run-001");
      releaseLock(tempDir, "/repo/path");

      const info = checkLock(tempDir, "/repo/path");
      expect(info).toBeNull();
    });

    it("does not throw when no lock exists", () => {
      expect(() => releaseLock(tempDir, "/repo/path")).not.toThrow();
    });

    it("does not release a lock held by a different run", () => {
      acquireLock(tempDir, "/repo/path", "run-new");

      releaseLock(tempDir, "/repo/path", "run-old");

      const info = checkLock(tempDir, "/repo/path");
      expect(info?.runId).toBe("run-new");
    });
  });

  describe("checkLock", () => {
    it("returns null when no lock exists", () => {
      const info = checkLock(tempDir, "/repo/path");
      expect(info).toBeNull();
    });

    it("returns lock info when lock is fresh", () => {
      acquireLock(tempDir, "/repo/path", "run-001");
      const info = checkLock(tempDir, "/repo/path");
      expect(info).not.toBeNull();
      expect(info?.runId).toBe("run-001");
    });

    it("returns null for a stale lock at its real path", async () => {
      acquireLock(tempDir, "/repo/path", "old-run");
      await backdateLockFile(tempDir, 2 * 60 * 60 * 1000);

      expect(checkLock(tempDir, "/repo/path")).toBeNull();
    });

    it("returns null for corrupted lock file", async () => {
      const locksDir = join(tempDir, "locks");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(locksDir, { recursive: true });

      await writeFile(join(locksDir, "abc123.lock"), "not valid json");

      const info = checkLock(tempDir, "/repo/path");
      expect(info).toBeNull();
    });
  });

  describe("renewLock", () => {
    it("refreshes the heartbeat so a long-running task keeps its lock", async () => {
      acquireLock(tempDir, "/repo/long", "run-long");
      const locksDir = join(tempDir, "locks");
      const { readdir } = await import("node:fs/promises");
      const [fileName] = await readdir(locksDir);
      const lockPath = join(locksDir, fileName);
      const original = JSON.parse(await readFile(lockPath, "utf-8"));
      await writeFile(
        lockPath,
        JSON.stringify({
          ...original,
          acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          heartbeatAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        }),
      );

      expect(renewLock(tempDir, "/repo/long", "run-long")).toBe(true);

      const info = checkLock(tempDir, "/repo/long");
      expect(info?.runId).toBe("run-long");
      expect(new Date(info?.heartbeatAt ?? 0).getTime()).toBeGreaterThan(Date.now() - 10_000);
    });

    it("does not refresh a lock owned by a different run", () => {
      acquireLock(tempDir, "/repo/path", "run-owner");
      expect(renewLock(tempDir, "/repo/path", "run-other")).toBe(false);
      expect(checkLock(tempDir, "/repo/path")?.runId).toBe("run-owner");
    });
  });
});
