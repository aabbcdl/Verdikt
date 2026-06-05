/**
 * Concurrency lock — prevents parallel runs on the same repository.
 *
 * Uses file-based locking with stale detection.
 * Lock file contains runId + timestamp.
 * Stale locks (> 1 hour) are automatically overridden.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour

interface LockInfo {
  runId: string;
  acquiredAt: string;
  repoPath: string;
}

/**
 * Generate a deterministic lock file path for a given repoPath.
 */
function getLockPath(stateDir: string, repoPath: string): string {
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  const locksDir = join(stateDir, "locks");
  if (!existsSync(locksDir)) {
    mkdirSync(locksDir, { recursive: true });
  }
  return join(locksDir, `${hash}.lock`);
}

/**
 * Try to acquire a lock for the given repoPath.
 *
 * Returns true if lock acquired, false if already locked by another run.
 * Throws if the lock file is unreadable (not a stale/active lock scenario).
 */
export function acquireLock(stateDir: string, repoPath: string, runId: string): boolean {
  const lockPath = getLockPath(stateDir, repoPath);

  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const info: LockInfo = JSON.parse(raw);
      const age = Date.now() - new Date(info.acquiredAt).getTime();

      if (age < LOCK_STALE_MS) {
        // Lock is fresh — another run is active
        return false;
      }

      // Lock is stale — override it
    } catch {
      // Lock file is corrupted — override it
    }
  }

  // Acquire lock
  const info: LockInfo = {
    runId,
    acquiredAt: new Date().toISOString(),
    repoPath,
  };
  writeFileSync(lockPath, JSON.stringify(info, null, 2), "utf-8");
  return true;
}

/**
 * Release the lock for the given repoPath.
 * Best effort — does not throw if lock file is already gone.
 */
export function releaseLock(stateDir: string, repoPath: string): void {
  const lockPath = getLockPath(stateDir, repoPath);
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Best effort cleanup
  }
}

/**
 * Check who holds the lock for a given repoPath.
 * Returns null if no lock or lock is stale.
 */
export function checkLock(stateDir: string, repoPath: string): LockInfo | null {
  const lockPath = getLockPath(stateDir, repoPath);

  if (!existsSync(lockPath)) return null;

  try {
    const raw = readFileSync(lockPath, "utf-8");
    const info: LockInfo = JSON.parse(raw);
    const age = Date.now() - new Date(info.acquiredAt).getTime();

    if (age >= LOCK_STALE_MS) return null; // Stale
    return info;
  } catch {
    return null; // Corrupted
  }
}
