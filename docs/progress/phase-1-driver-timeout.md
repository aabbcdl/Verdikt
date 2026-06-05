# Phase 1: Claude Driver — Hard Wall-Clock Timeout

## Problem

`callClaude()` uses idle timeout only — resets on each output chunk.
If Claude outputs tiny amounts continuously, the idle timer never fires.
A single run can hang forever.

## Solution

Add `absoluteTimeoutMs` (default 10 minutes) alongside existing `idleTimeoutMs`.
Absolute timer starts when process spawns, never resets, kills unconditionally.

## Files to Modify

- `src/claude/driver.ts` — add absolute timeout logic
- `src/config.ts` — add `defaultAbsoluteTimeoutMs` config field

## Tests

- `src/claude/driver.test.ts` — NEW
  - Process exits normally before absolute timeout
  - Process killed by absolute timeout when idle timeout bypassed
  - Process killed by idle timeout (existing behavior preserved)
  - Temp file cleaned up on both timeout types

## Acceptance

- [ ] `callClaude` has both idle and absolute timeout
- [ ] Absolute timeout defaults to 600000ms (10 min)
- [ ] SIGKILL sent after absolute timeout (not just SIGTERM)
- [ ] Temp file always cleaned up
