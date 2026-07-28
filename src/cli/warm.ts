import { resolve } from "node:path";
import { getConfig } from "../config.js";
import { warmRepository } from "../workspace/warm.js";
import { hasFlag, parseArgs } from "./parseArgs.js";

export async function handleWarm(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ["json"],
    positional: { min: 1, max: 1, names: ["repo-path"] },
  });
  const repoPath = parsed.positional[0];

  const result = await warmRepository(resolve(repoPath), getConfig().stateDir);
  if (hasFlag(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`Prepared a clean workspace for ${result.repoPath}`);
  console.log(`Base commit: ${result.baseCommit.slice(0, 12)}`);
  console.log(`Ready in ${result.durationMs}ms`);
}
