/**
 * CLI handler for `verdikt doctor` command.
 */

import type { ExecException } from "node:child_process";
import { resolve } from "node:path";

export async function handleDoctor(): Promise<void> {
  console.log("Verdikt Doctor — Environment Health Check\n");

  const { exec } = await import("node:child_process");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Helper to run a command and check result
  async function check(name: string, cmd: string): Promise<void> {
    return new Promise<void>((resolve) => {
      exec(cmd, { encoding: "utf-8" }, (err: ExecException | null, stdout: string) => {
        if (err) {
          checks.push({ name, ok: false, detail: "not found" });
        } else {
          checks.push({ name, ok: true, detail: stdout.trim().split("\n")[0] });
        }
        resolve();
      });
    });
  }

  // Core tools
  await check("Node.js", "node --version");
  await check("Claude CLI", "claude --version");
  await check("Git", "git --version");
  await check("pnpm", "pnpm --version");

  // Git worktree support
  await check("Git worktree", "git worktree list");

  // API configuration
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "(default Anthropic)";
  const model = process.env.VERDIKT_MODEL || "sonnet";

  checks.push({
    name: "ANTHROPIC_API_KEY",
    ok: hasApiKey,
    detail: hasApiKey ? "set" : "not set (will use OAuth/keychain)",
  });
  checks.push({ name: "ANTHROPIC_BASE_URL", ok: true, detail: baseUrl });
  checks.push({ name: "Model", ok: true, detail: model });

  // State directory
  const { getConfig } = await import("../config.js");
  const config = getConfig();
  checks.push({ name: "State dir", ok: true, detail: resolve(config.stateDir) });

  // Display results
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? "✓" : "❌";
    console.log(`  ${c.name.padEnd(20)} ${c.detail} ${icon}`);
    if (!c.ok) allOk = false;
  }

  console.log(
    `\n${allOk ? "✅ All checks passed." : "⚠️  Some checks failed. Fix the issues above before running Verdikt."}`,
  );
}
