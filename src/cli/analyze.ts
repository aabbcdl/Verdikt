/**
 * CLI handler for `verdikt analyze` command.
 */

import { parseArgs } from "./parseArgs.js";

export async function handleAnalyze(args: string[] = []): Promise<void> {
  parseArgs(args, { positional: { max: 0 } });
  const config = (await import("../config.js")).getConfig();
  const { analyzeRuns } = await import("../improvement/analyzer.js");

  console.log(`\n🔍 Analyzing runs in ${config.stateDir}...\n`);

  const report = await analyzeRuns(config.stateDir);

  // Print summary
  console.log(`${"═".repeat(60)}`);
  console.log("Improvement Report");
  console.log(`${"═".repeat(60)}`);
  console.log(`\nTotal runs: ${report.totalRuns}`);
  console.log(`Passed: ${report.passedRuns} (${(report.passRate * 100).toFixed(0)}%)`);
  console.log(`Failed: ${report.totalRuns - report.passedRuns}`);

  // Print failure patterns
  if (report.failurePatterns.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log("Common Failure Patterns:");
    console.log(`${"─".repeat(60)}`);
    for (const p of report.failurePatterns.slice(0, 10)) {
      const rate = (p.recoveryRate * 100).toFixed(0);
      console.log(`  ${p.pattern}: ${p.count} occurrences, ${rate}% recovery`);
    }
  }

  // Print recovery strategies
  if (report.recoveryStrategies.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log("Successful Recovery Strategies:");
    console.log(`${"─".repeat(60)}`);
    for (const s of report.recoveryStrategies.slice(0, 5)) {
      console.log(`  Problem: ${s.problem}`);
      console.log(`  Solution: ${s.solution}`);
      console.log(`  Example: ${s.exampleRun}\n`);
    }
  }

  // Print recommendations
  if (report.recommendations.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log("Recommendations:");
    console.log(`${"─".repeat(60)}`);
    for (const r of report.recommendations) {
      console.log(`  ${r}`);
    }
  }

  console.log();
}
