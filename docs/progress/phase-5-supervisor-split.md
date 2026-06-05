# Phase 5: Supervisor Lifecycle Split

## Problem

`runSupervisorLoop` handles both normal runs and resume in one function.
Resume passes `{} as any` (now `placeholderTask`) which is never used.
The `activeTask` branching makes every subsequent line ambiguous about
which lifecycle it serves.

## Solution

Extract `resumeSupervisorLoop` as a separate function.
It loads state, reconstructs the task, then calls a shared `executeLoop`
function that contains the actual iteration logic.

## Files to Modify

- `src/loop/supervisor.ts` — split into:
  - `runSupervisorLoop(task, options)` — normal entry, creates runId/runDir
  - `resumeSupervisorLoop(runDir, options)` — resume entry, loads state
  - `executeLoop(task, runDir, options)` — shared iteration logic
- `src/cli/resume.ts` — call resumeSupervisorLoop directly
- `src/cli/run.ts` — no change (already calls runSupervisorLoop)

## Tests

- `src/loop/supervisor.test.ts` — add:
  - Resume starts from correct iteration
  - Resume uses saved instruction and cost
  - Normal run creates fresh runId
  - Both paths share same iteration logic

## Acceptance

- [ ] `runSupervisorLoop` no longer handles resume
- [ ] `resumeSupervisorLoop` loads state and delegates to `executeLoop`
- [ ] No `placeholderTask` or `{} as any` anywhere
- [ ] `activeTask` is set once at function entry, never branched
