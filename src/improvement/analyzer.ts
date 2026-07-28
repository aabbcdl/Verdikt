/**
 * Agent Self-Improvement Analyzer
 *
 * M6: Analyzes verifier feedback patterns across runs to extract
 * successful recovery strategies and common failure modes.
 *
 * Output: Actionable insights for improving the executor's system prompt.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface FeedbackPattern {
  /** The feedback pattern (e.g., "type error", "missing import") */
  pattern: string;
  /** How many times this pattern appeared */
  count: number;
  /** Whether runs with this pattern eventually passed */
  recoveredCount: number;
  /** Recovery rate */
  recoveryRate: number;
  /** Example feedback text */
  example: string;
}

export interface ImprovementReport {
  /** Total runs analyzed */
  totalRuns: number;
  /** Runs that eventually passed */
  passedRuns: number;
  /** Overall pass rate */
  passRate: number;
  /** Common failure patterns */
  failurePatterns: FeedbackPattern[];
  /** Successful recovery strategies */
  recoveryStrategies: Array<{
    problem: string;
    solution: string;
    exampleRun: string;
  }>;
  /** Recommended prompt improvements */
  recommendations: string[];
}

/**
 * Analyze all runs in the state directory.
 */
export async function analyzeRuns(stateDir: string): Promise<ImprovementReport> {
  const runs = await loadAllRuns(stateDir);

  if (runs.length === 0) {
    return {
      totalRuns: 0,
      passedRuns: 0,
      passRate: 0,
      failurePatterns: [],
      recoveryStrategies: [],
      recommendations: ["No runs to analyze. Run some tasks first."],
    };
  }

  const passedRuns = runs.filter((r) => r.stopReason === "passed");
  // Extract feedback patterns from verifier responses
  const patterns = extractFeedbackPatterns(runs);

  // Find recovery strategies (failed → passed transitions)
  const strategies = extractRecoveryStrategies(runs);

  // Generate recommendations
  const recommendations = generateRecommendations(
    patterns,
    strategies,
    passedRuns.length / runs.length,
  );

  return {
    totalRuns: runs.length,
    passedRuns: passedRuns.length,
    passRate: passedRuns.length / runs.length,
    failurePatterns: patterns,
    recoveryStrategies: strategies,
    recommendations,
  };
}

interface RunData {
  runId: string;
  taskId: string;
  stopReason: string;
  iterations: Array<{
    index: number;
    judgePassed: boolean;
    verifierProblems: string[];
    verifierNextInstruction: string | null;
    filesChanged: string[];
  }>;
}

async function loadAllRuns(stateDir: string): Promise<RunData[]> {
  const runs: RunData[] = [];

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    // State directory doesn't exist — no runs to analyze
    return [];
  }

  for (const entry of entries) {
    const summaryPath = join(stateDir, entry, "summary.json");
    if (!existsSync(summaryPath)) continue;

    try {
      const raw = await readFile(summaryPath, "utf-8");
      const summary = JSON.parse(raw);

      const summaryRecord = isRecord(summary) ? summary : {};
      const iterations = asArray(summaryRecord.iterations).map((iter, i) => {
        const iterRecord = isRecord(iter) ? iter : {};
        const judge = isRecord(iterRecord.judge) ? iterRecord.judge : {};
        const verifier = isRecord(iterRecord.verifier) ? iterRecord.verifier : {};
        const patch = isRecord(iterRecord.patch) ? iterRecord.patch : {};

        return {
          index: i,
          judgePassed: judge.passed === true,
          verifierProblems: stringArray(verifier.problems),
          verifierNextInstruction: optionalString(verifier.nextInstruction),
          filesChanged: stringArray(patch.filesChanged),
        };
      });

      runs.push({
        runId: entry,
        taskId: optionalString(summaryRecord.taskId) ?? "?",
        stopReason: optionalString(summaryRecord.stopReason) ?? "unknown",
        iterations,
      });
    } catch {
      // Skip invalid summaries
    }
  }

  return runs;
}

function extractFeedbackPatterns(runs: RunData[]): FeedbackPattern[] {
  const patternMap = new Map<string, { count: number; recoveredCount: number; example: string }>();

  for (const run of runs) {
    const recovered = run.stopReason === "passed";

    for (const iter of run.iterations) {
      for (const problem of iter.verifierProblems) {
        // Normalize the problem into a pattern
        const pattern = normalizeProblem(problem);
        const existing = patternMap.get(pattern);

        if (existing) {
          existing.count++;
          if (recovered) existing.recoveredCount++;
        } else {
          patternMap.set(pattern, {
            count: 1,
            recoveredCount: recovered ? 1 : 0,
            example: problem.slice(0, 200),
          });
        }
      }
    }
  }

  return Array.from(patternMap.entries())
    .map(([pattern, data]) => ({
      pattern,
      count: data.count,
      recoveredCount: data.recoveredCount,
      recoveryRate: data.count > 0 ? data.recoveredCount / data.count : 0,
      example: data.example,
    }))
    .sort((a, b) => b.count - a.count);
}

function normalizeProblem(problem: string): string {
  const lower = problem.toLowerCase();

  // Categorize common failure patterns
  if (lower.includes("type") && (lower.includes("error") || lower.includes("mismatch"))) {
    return "type-error";
  }
  if (lower.includes("import") || lower.includes("module") || lower.includes("cannot find")) {
    return "import-error";
  }
  if (lower.includes("undefined") || lower.includes("null") || lower.includes("not a function")) {
    return "runtime-error";
  }
  if (lower.includes("test") && (lower.includes("fail") || lower.includes("assert"))) {
    return "test-failure";
  }
  if (lower.includes("lint") || lower.includes("eslint") || lower.includes("prettier")) {
    return "lint-error";
  }
  if (lower.includes("build") || lower.includes("compile")) {
    return "build-error";
  }
  if (lower.includes("timeout") || lower.includes("slow")) {
    return "performance";
  }
  if (lower.includes("async") || lower.includes("promise") || lower.includes("await")) {
    return "async-error";
  }

  // Fallback: use first 50 chars as pattern
  return problem.slice(0, 50).replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => {
    return typeof item === "string" && item.trim().length > 0;
  });
}

function extractRecoveryStrategies(runs: RunData[]): Array<{
  problem: string;
  solution: string;
  exampleRun: string;
}> {
  const strategies: Array<{ problem: string; solution: string; exampleRun: string }> = [];

  for (const run of runs) {
    if (run.stopReason !== "passed") continue;

    // Look for failed → passed transitions
    for (let i = 0; i < run.iterations.length - 1; i++) {
      const failed = run.iterations[i];
      const passed = run.iterations[i + 1];

      if (!failed.judgePassed && passed.judgePassed) {
        // This is a successful recovery
        const problems = failed.verifierProblems;
        const filesChanged = passed.filesChanged;

        if (problems.length > 0 && filesChanged.length > 0) {
          strategies.push({
            problem: problems[0].slice(0, 100),
            solution: `Changed ${filesChanged.length} file(s): ${filesChanged.slice(0, 3).join(", ")}`,
            exampleRun: run.runId,
          });
        }
      }
    }
  }

  return strategies.slice(0, 20); // Top 20 strategies
}

function generateRecommendations(
  patterns: FeedbackPattern[],
  strategies: Array<{ problem: string; solution: string; exampleRun: string }>,
  passRate: number,
): string[] {
  const recommendations: string[] = [];

  // High-frequency patterns with low recovery
  const problematicPatterns = patterns.filter((p) => p.count >= 2 && p.recoveryRate < 0.5);
  for (const p of problematicPatterns.slice(0, 3)) {
    recommendations.push(
      `⚠️ "${p.pattern}" appears ${p.count} times with only ${(p.recoveryRate * 100).toFixed(0)}% recovery. Consider adding specific guidance for this failure mode.`,
    );
  }

  // Overall pass rate feedback
  if (passRate < 0.3) {
    recommendations.push(
      "🔴 Low pass rate (<30%). Tasks may be too complex or acceptance criteria too strict.",
    );
  } else if (passRate < 0.6) {
    recommendations.push(
      "🟡 Moderate pass rate. Consider improving the executor's system prompt with common fix patterns.",
    );
  } else {
    recommendations.push("🟢 Good pass rate (>60%). Focus on optimizing cost and iteration count.");
  }

  // Recovery strategy insights
  if (strategies.length > 0) {
    const commonSolutions = new Map<string, number>();
    for (const s of strategies) {
      const key = s.solution.split(":")[0];
      commonSolutions.set(key, (commonSolutions.get(key) ?? 0) + 1);
    }
    const topSolution = Array.from(commonSolutions.entries()).sort((a, b) => b[1] - a[1])[0];
    if (topSolution) {
      recommendations.push(
        `💡 Most common recovery strategy: ${topSolution[0]} (${topSolution[1]} times). This pattern could be emphasized in the executor prompt.`,
      );
    }
  }

  return recommendations;
}
