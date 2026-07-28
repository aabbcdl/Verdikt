import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumeActionGrant, requestActionApproval } from "../approval/actionStore.js";
import type { RiskCategory } from "../types.js";
import { evaluateCommandPolicy } from "./commandPolicy.js";

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
}

interface HookPolicy {
  repoRoot: string;
  approvedCategories: RiskCategory[];
  allowAll?: boolean;
  approvedActionSignatures?: string[];
  runDir?: string;
}

export function buildHookDecision(input: HookInput, policy: HookPolicy): object {
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command || !["Bash", "PowerShell"].includes(input.tool_name ?? "")) return {};
  const decision = evaluateCommandPolicy(
    command,
    policy.repoRoot,
    policy.approvedCategories,
    policy.allowAll,
    policy.approvedActionSignatures ?? [],
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.allowed ? "allow" : "deny",
      permissionDecisionReason: decision.reason,
    },
  };
}

export async function resolveHookDecision(input: HookInput, policy: HookPolicy): Promise<object> {
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command || !["Bash", "PowerShell"].includes(input.tool_name ?? "")) return {};

  const initial = evaluateCommandPolicy(
    command,
    policy.repoRoot,
    policy.approvedCategories,
    policy.allowAll,
    policy.approvedActionSignatures ?? [],
  );
  if (policy.runDir && initial.requiresExactApproval) {
    const granted = await consumeActionGrant(policy.runDir, initial.signature);
    if (granted) {
      return buildHookDecision(input, {
        ...policy,
        approvedActionSignatures: [...(policy.approvedActionSignatures ?? []), initial.signature],
      });
    }
    if (!initial.allowed) {
      await requestActionApproval(policy.runDir, {
        signature: initial.signature,
        command,
        tool: input.tool_name ?? "Bash",
        categories: initial.categories,
        reason: initial.reason,
        cwd: policy.repoRoot,
      });
    }
  }
  return buildHookDecision(input, policy);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as HookInput;
  const policy = JSON.parse(process.env.VERDIKT_COMMAND_POLICY ?? "{}") as HookPolicy;
  process.stdout.write(JSON.stringify(await resolveHookDecision(input, policy)));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Verdikt command policy failed closed: ${error instanceof Error ? error.message : String(error)}`,
        },
      }),
    );
  });
}
