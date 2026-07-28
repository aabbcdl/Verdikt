/**
 * Concurrency lock — prevents parallel runs on the same repository.
 *
 * Locks carry a renewable heartbeat. Long-running tasks keep ownership by
 * renewing the lock; abandoned locks become stale after the heartbeat window.
 */

import { existsSync } from "node:fs";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalizeRepoPath, repositoryIdentityKey } from "./repoIdentity.js";

const LOCK_STALE_MS = 60 * 60 * 1000;

export interface LockInfo {
  runId: string;
  acquiredAt: string;
  heartbeatAt?: string;
  ownerPid?: number;
  repoPath: string;
}

function getLockPath(stateDir: string, repoPath: string): string {
  const hash = repositoryIdentityKey(repoPath).slice(0, 12);
  const locksDir = join(stateDir, "locks");
  if (!existsSync(locksDir)) {
    mkdirSync(locksDir, { recursive: true });
  }
  return join(locksDir, `${hash}.lock`);
}

export function acquireLock(stateDir: string, repoPath: string, runId: string): boolean {
  const lockPath = getLockPath(stateDir, repoPath);

  if (existsSync(lockPath)) {
    try {
      const info = readLock(lockPath);
      if (info && !isStale(info)) return false;
    } catch {
      // Corrupt lock file — treat as stale and claim it below.
    }
    // Atomic stale takeover. A bare unlink here raced: two processes that both
    // observed the stale lock would both unlink, and the second unlink could
    // delete the FRESH lock the first process had just created (dual holders).
    // rename() succeeds for exactly one claimant; the loser falls through to
    // the "wx" create below and loses with EEXIST.
    const claimPath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(lockPath, claimPath);
      const claimed = readClaimedLock(claimPath);
      if (claimed && !isStale(claimed)) {
        // We raced a fresh acquisition and grabbed the NEW lock — put it back.
        try {
          renameSync(claimPath, lockPath);
        } catch {
          unlinkSync(claimPath);
        }
        return false;
      }
      unlinkSync(claimPath);
    } catch {
      // Another process claimed the stale lock first (or it vanished).
    }
  }

  const now = new Date().toISOString();
  const info: LockInfo = {
    runId,
    acquiredAt: now,
    heartbeatAt: now,
    ownerPid: process.pid,
    repoPath: canonicalizeRepoPath(repoPath),
  };

  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify(info, null, 2), "utf-8");
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export function renewLock(stateDir: string, repoPath: string, runId: string): boolean {
  const lockPath = getLockPath(stateDir, repoPath);
  if (!existsSync(lockPath)) return false;

  try {
    const info = readLock(lockPath);
    if (!info || info.runId !== runId) return false;
    const renewed: LockInfo = {
      ...info,
      heartbeatAt: new Date().toISOString(),
      ownerPid: process.pid,
      repoPath: canonicalizeRepoPath(repoPath),
    };
    const temporaryPath = `${lockPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporaryPath, JSON.stringify(renewed, null, 2), "utf-8");
    renameSync(temporaryPath, lockPath);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(stateDir: string, repoPath: string, expectedRunId?: string): void {
  const lockPath = getLockPath(stateDir, repoPath);
  try {
    if (!existsSync(lockPath)) return;
    if (expectedRunId) {
      const info = readLock(lockPath);
      if (!info || info.runId !== expectedRunId) return;
    }
    unlinkSync(lockPath);
  } catch {
    // Best effort cleanup.
  }
}

export function checkLock(stateDir: string, repoPath: string): LockInfo | null {
  const lockPath = getLockPath(stateDir, repoPath);
  if (!existsSync(lockPath)) return null;

  try {
    const info = readLock(lockPath);
    if (!info || isStale(info)) return null;
    return info;
  } catch {
    return null;
  }
}

function readLock(lockPath: string): LockInfo | null {
  const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockInfo>;
  if (
    typeof parsed.runId !== "string" ||
    typeof parsed.acquiredAt !== "string" ||
    typeof parsed.repoPath !== "string"
  ) {
    return null;
  }
  return parsed as LockInfo;
}

function readClaimedLock(claimPath: string): LockInfo | null {
  try {
    return readLock(claimPath);
  } catch {
    return null;
  }
}

function isStale(info: LockInfo): boolean {
  const heartbeat = new Date(info.heartbeatAt ?? info.acquiredAt).getTime();
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat >= LOCK_STALE_MS) return true;
  // Locks are machine-local: an owner process that no longer exists can never
  // renew its heartbeat. Without this check a crash blocked new runs on the
  // same repository for up to LOCK_STALE_MS.
  if (typeof info.ownerPid === "number" && !isProcessAlive(info.ownerPid)) return true;
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
