import { forkRunFromIteration, rewindRunToIteration } from "./checkpointActions.js";
import { getFlag, parseArgs } from "./parseArgs.js";

export async function handleRewind(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {
    positional: { min: 2, max: 2, names: ["run-id", "iteration-number"] },
  });
  const runId = positional[0];
  const iteration = parseIteration(positional[1]);
  if (!runId || iteration === null)
    throw new Error("Usage: verdikt rewind <run-id> <iteration-number>");
  const result = await rewindRunToIteration(runId, iteration);
  console.log(
    `Run ${result.runId} restored to iteration ${iteration + 1}. Use resume to continue.`,
  );
}

export async function handleFork(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    optional: ["run-id"],
    positional: { min: 2, max: 2, names: ["run-id", "iteration-number"] },
  });
  const runId = parsed.positional[0];
  const iteration = parseIteration(parsed.positional[1]);
  const newRunId = getFlag(parsed, "run-id", "") || undefined;
  if (!runId || iteration === null)
    throw new Error("Usage: verdikt fork <run-id> <iteration-number> [--run-id=<new-id>]");
  const result = await forkRunFromIteration(runId, iteration, newRunId);
  console.log(`Created ${result.runId} from ${runId} at iteration ${iteration + 1}.`);
  console.log(`Run: verdikt resume ${result.runId}`);
}

function parseIteration(value: string | undefined): number | null {
  const oneBased = Number.parseInt(value ?? "", 10);
  return Number.isInteger(oneBased) && oneBased > 0 ? oneBased - 1 : null;
}
