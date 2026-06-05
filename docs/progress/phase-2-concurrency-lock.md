# Phase 2: Concurrency Lock

## Problem

Two `verdikt run` on the same repoPath create conflicting worktrees and branches.
No locking, no detection, silent corruption.

## Solution

File-based lock: create `.verdikt/locks/<repoPath-hash>.lock` before starting run.
Lock contains runId + timestamp. Reject if lock exists and is fresh (< 1 hour).
Release on completion, error, or process exit.

## Files to Modify

- `src/workspace/lock.ts` — NEW: acquire/release/check lock
- `src/loop/supervisor.ts` — acquire lock before run, release after

## Tests

- `src/workspace/lock.test.ts` — NEW
  - Acquire lock succeeds when no lock exists
  - Acquire lock fails when lock exists and is fresh
  - Acquire lock succeeds when lock is stale (> 1 hour)
  - Release lock removes file
  - Lock file contains correct runId

## Acceptance

- [ ] Only one run per repoPath at a time
- [ ] Stale locks (> 1 hour) are automatically overridden
- [ ] Lock released on normal exit, error, and process crash (best effort)
- [ ] Error message includes the holding runId
