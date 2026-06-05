# Phase 4: CLI Structured Args

## Problem

CLI arguments parsed with `args.indexOf("--task")` — no validation, no schema,
illegal combinations silently accepted. `--out` without value crashes.

## Solution

Create `src/cli/parseArgs.ts` with structured argument parser.
Validates required args, detects unknown flags, provides clear errors.

## Files to Create/Modify

- `src/cli/parseArgs.ts` — NEW: argument parsing and validation
- `src/cli/run.ts` — use parseArgs
- `src/cli/benchmark.ts` — use parseArgs
- `src/cli/view.ts` — use parseArgs
- Other CLI handlers — use parseArgs where applicable

## parseArgs API

```typescript
interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(args: string[], spec: ArgSpec): ParsedArgs;
// spec defines: required flags, optional flags, positional count
// throws on missing required, unknown flags, or invalid combinations
```

## Tests

- `src/cli/parseArgs.test.ts` — NEW
  - Parses --task <file> correctly
  - Rejects missing required flag
  - Rejects unknown flags
  - Handles boolean flags (--json, --dry-run)
  - Handles value flags (--task file.json)
  - Reports clear error messages

## Acceptance

- [ ] All CLI commands use parseArgs
- [ ] Missing required args produce clear error with usage hint
- [ ] Unknown flags produce warning
- [ ] `--out` without value produces error, not crash
