/**
 * CLI handler for `verdikt benchmark` command.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function handleBenchmark(args: string[]): Promise<void> {
  const suiteIdx = args.indexOf("--suite");
  if (suiteIdx === -1 || !args[suiteIdx + 1]) {
    console.error("Error: --suite <file> is required");
    console.error("Usage: verdikt benchmark --suite <suite-file.json>");
    process.exit(1);
  }

  const suitePath = resolve(args[suiteIdx + 1]);

  if (!existsSync(suitePath)) {
    console.error(`\n❌ Suite file not found: ${suitePath}`);
    console.error("\nCreate one with: verdikt init --suite");
    console.error("Or use an existing: benchmarks/m4-hard.json");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;

  const { loadSuite, runBenchmark } = await import("../benchmark/runner.js");

  let suite: Awaited<ReturnType<typeof loadSuite>>;
  try {
    suite = loadSuite(suitePath);
  } catch (err) {
    console.error(`\n❌ Invalid suite file: ${suitePath}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`\n📊 Benchmark: ${suite.id}`);
  console.log(`   Tasks: ${suite.tasks.length}`);
  if (dryRun) console.log("   Mode: DRY RUN (no execution)");

  const result = await runBenchmark(suite, { outDir, dryRun });

  // Exit code: 0 if all matched expectations, 1 if any unexpected
  const hasUnexpected = result.totals.unexpectedFailures > 0 || result.totals.unexpectedPasses > 0;
  process.exit(hasUnexpected ? 1 : 0);
}
