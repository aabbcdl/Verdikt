/**
 * CLI handler for `verdikt doctor` command.
 */

import type { ExecException } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "./parseArgs.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
  verification?: "confirmed" | "not_checked";
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function handleDoctor(args: string[] = []): Promise<void> {
  parseArgs(args, { positional: { max: 0 } });
  console.log("Verdikt Doctor — Environment Health Check\n");

  const report = await runDoctorChecks();

  for (const c of report.checks) {
    const icon = c.verification === "not_checked" ? "?" : c.ok ? "?" : "?";
    const required = c.required ? "" : " (optional)";
    console.log(`  ${c.name.padEnd(24)} ${c.detail} ${icon}${required}`);
  }

  console.log(
    `\n${report.ok ? "? All required local checks passed. Provider balance and service availability will be confirmed on the first request." : "??  Some required checks failed. Fix the issues above before running Verdikt."}`,
  );
}

export async function runDoctorChecks(): Promise<DoctorReport> {
  const { exec } = await import("node:child_process");
  const checks: DoctorCheck[] = [];

  // Helper to run a command and check result
  async function check(name: string, cmd: string, required = true): Promise<void> {
    return new Promise<void>((resolveCheck) => {
      try {
        exec(cmd, { encoding: "utf-8" }, (err: ExecException | null, stdout: string) => {
          if (err) {
            checks.push({ name, ok: false, detail: "not found", required });
          } else {
            checks.push({ name, ok: true, detail: stdout.trim().split("\n")[0], required });
          }
          resolveCheck();
        });
      } catch {
        checks.push({ name, ok: false, detail: "not found", required });
        resolveCheck();
      }
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
    required: false,
  });
  checks.push({ name: "ANTHROPIC_BASE_URL", ok: true, detail: baseUrl, required: false });
  checks.push({ name: "Model", ok: true, detail: model, required: false });
  checks.push({
    name: "Claude request readiness",
    ok: true,
    detail: "balance and service availability are checked on the first request",
    required: false,
    verification: "not_checked",
  });

  // State directory
  const { getConfig } = await import("../config.js");
  try {
    const config = getConfig();
    checks.push({ name: "Configuration", ok: true, detail: "valid", required: true });
    checks.push({ name: "State dir", ok: true, detail: resolve(config.stateDir), required: true });
  } catch (error) {
    checks.push({
      name: "Configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    });
  }

  return {
    ok: checks.every((check) => check.ok || !check.required),
    checks,
  };
}
