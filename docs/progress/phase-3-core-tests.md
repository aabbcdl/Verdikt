# Phase 3: Core Module Tests

## Problem

Three critical modules have zero tests:
- `src/claude/driver.ts` (264 lines) — external process invocation
- `src/judges/runJudges.ts` (270 lines) — subprocess execution for test commands
- `src/workspace/worktree.ts` (280 lines) — git worktree operations

## Solution

Add unit tests with mocked subprocesses for each module.

## Files to Create

- `src/claude/driver.test.ts`
- `src/judges/runJudges.test.ts`
- `src/workspace/worktree.test.ts`

## Test Cases

### driver.test.ts
- Returns text on successful JSON output
- Returns cost from JSON output
- Handles non-JSON output gracefully
- Handles timeout (idle)
- Handles process error
- Cleans up temp file

### runJudges.test.ts
- All steps pass → passed=true
- One step fails → passed=false
- Required step fails → passed=false
- Optional step fails → passed=true
- Custom judge script execution
- Custom judge timeout

### worktree.test.ts
- createRunWorktree creates worktree and returns info
- captureIterationDiff generates patch file
- discardRun cleans up worktree and branch
- getFinalPatch produces correct diff

## Acceptance

- [ ] Each module has ≥5 test cases
- [ ] Tests use mocked subprocesses (no real git/claude calls)
- [ ] All tests pass
