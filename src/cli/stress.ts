import { formatStressReport, parseStressArgs, runStress } from "../stress/runner.js";

export async function handleStress(args: string[]): Promise<void> {
  const options = parseStressArgs(args);
  const result = await runStress(options);
  console.log(formatStressReport(result));

  if (!result.passed) {
    process.exitCode = 1;
  }
}
