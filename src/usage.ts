import type { UsageSummary } from "./types.js";

export function usageFromClaudeResult(json: Record<string, unknown>): UsageSummary {
  const costUsd =
    finiteNumber(json.total_cost_usd) ?? finiteNumber(json.cost_usd) ?? nestedCost(json.result);
  const usage = record(json.usage);
  const inputTokens = readNumber(usage, "input_tokens", "inputTokens");
  const cacheReadInputTokens = readNumber(usage, "cache_read_input_tokens", "cacheReadInputTokens");
  const outputTokens = readNumber(usage, "output_tokens", "outputTokens");
  const reasoningTokens = readNumber(usage, "reasoning_tokens", "reasoningTokens");
  const reportedTotal = readNumber(usage, "total_tokens", "totalTokens");
  const computedTotal = sumDefined(inputTokens, cacheReadInputTokens, outputTokens);
  const incomplete = json.cost_is_partial === true || json.usage_is_incomplete === true;

  return compactUsage({
    status: incomplete ? "partial" : costUsd === undefined ? "unknown" : "complete",
    costUsd,
    inputTokens,
    cacheReadInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: reportedTotal ?? computedTotal,
    modelCalls: countModelCalls(record(json.modelUsage)),
  });
}

export function mergeUsage(...items: Array<UsageSummary | undefined>): UsageSummary {
  const defined = items.filter((item): item is UsageSummary => Boolean(item));
  if (defined.length === 0) return { status: "unknown" };
  const costUsd = sumOptional(
    defined.filter((item) => item.status !== "unknown").map((item) => item.costUsd),
  );
  const statuses = defined.map((item) => item.status);
  const status = statuses.every((value) => value === "complete")
    ? "complete"
    : costUsd === undefined && statuses.every((value) => value === "unknown")
      ? "unknown"
      : "partial";

  return compactUsage({
    status,
    costUsd,
    inputTokens: sumOptional(defined.map((item) => item.inputTokens)),
    cacheReadInputTokens: sumOptional(defined.map((item) => item.cacheReadInputTokens)),
    outputTokens: sumOptional(defined.map((item) => item.outputTokens)),
    reasoningTokens: sumOptional(defined.map((item) => item.reasoningTokens)),
    totalTokens: sumOptional(defined.map((item) => item.totalTokens)),
    modelCalls: sumOptional(defined.map((item) => item.modelCalls)),
  });
}

export function usageFromLegacyCost(costUsd: number | undefined): UsageSummary {
  return costUsd === undefined ? { status: "unknown" } : { status: "complete", costUsd };
}

export function coerceUsageSummary(value: unknown, legacyCost?: number): UsageSummary {
  const saved = record(value);
  const status = saved?.status;
  if (status === "complete" || status === "partial" || status === "unknown") {
    return compactUsage({
      status,
      costUsd:
        status === "unknown"
          ? undefined
          : (finiteNumber(saved?.costUsd) ?? finiteNumber(legacyCost)),
      inputTokens: finiteNumber(saved?.inputTokens),
      cacheReadInputTokens: finiteNumber(saved?.cacheReadInputTokens),
      outputTokens: finiteNumber(saved?.outputTokens),
      reasoningTokens: finiteNumber(saved?.reasoningTokens),
      totalTokens: finiteNumber(saved?.totalTokens),
      modelCalls: finiteNumber(saved?.modelCalls),
    });
  }
  return usageFromLegacyCost(finiteNumber(legacyCost));
}

export function formatCost(
  usage: Pick<UsageSummary, "status" | "costUsd"> | undefined,
  digits = 4,
): string {
  if (!usage || usage.status === "unknown" || usage.costUsd === undefined) return "unknown";
  const formatted = `$${usage.costUsd.toFixed(digits)}`;
  return usage.status === "partial" ? `${formatted}+` : formatted;
}

function compactUsage(usage: UsageSummary): UsageSummary {
  return Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  ) as unknown as UsageSummary;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nestedCost(value: unknown): number | undefined {
  const nested = record(value);
  return finiteNumber(nested?.total_cost_usd) ?? finiteNumber(nested?.cost_usd);
}

function readNumber(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const result = finiteNumber(value?.[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  return sumOptional(values);
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : undefined;
}

function countModelCalls(models: Record<string, unknown> | undefined): number | undefined {
  if (!models) return undefined;
  const counts = Object.values(models)
    .map((model) => readNumber(record(model), "modelCalls", "model_calls"))
    .filter((value): value is number => value !== undefined);
  return counts.length > 0 ? counts.reduce((sum, value) => sum + value, 0) : undefined;
}
