# Phase 6: Integration Tests

## Problem

`verdikt resume`, `verdikt compare`, `verdikt analyze`, `verdikt dashboard`
have minimal or zero test coverage. They "look like they work" but real
data paths are unverified.

## Solution

Add integration tests that exercise the full command flow with real
(temporary) state directories.

## Files to Create

- `src/cli/resume.test.ts`
- `src/cli/compare.test.ts`
- `src/cli/analyze.test.ts`
- `src/cli/dashboard.test.ts`

## Test Cases

### resume.test.ts
- Resume from valid state file continues from correct iteration
- Resume from completed run (has summary) fails with clear error
- Resume from nonexistent run fails with clear error

### compare.test.ts
- Compare two runs produces formatted output
- Compare with missing run fails with clear error
- Compare shows delta correctly

### analyze.test.ts
- Analyze with no runs returns empty report
- Analyze with mixed runs produces failure patterns
- Analyze with all-passing runs reports 100% pass rate

### dashboard.test.ts
- Dashboard serves HTML on /
- Dashboard serves JSON on /data/dashboard.json
- Dashboard returns 404 for unknown paths

## Acceptance

- [ ] Each command has ≥3 test cases
- [ ] Tests use temporary directories (no real .verdikt)
- [ ] All tests pass
