/**
 * CLI handler for `verdikt doctor` command.
 */

import type { ExecException } from "node:child_process";
import { resolve } from "node:path";
import { getConfig } from "../config.js";
import { claudeInstallGuidance, inspectClaudeLogin } from "../provider/probe.js";
import { providerSettingsFromConfig } from "../provider/settings.js";
import { parseArgs } from "./parseArgs.js";

export interface DoctorCheck {
  code?: string;
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
  verification?: "confirmed" | "not_checked";
  fix?: string;
  action?: { label: string; href?: string; command?: string };
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
    const icon = c.verification === "not_checked" ? "[pending]" : c.ok ? "[ok]" : "[failed]";
    const required = c.required ? "" : " (optional)";
    console.log(`  ${c.name.padEnd(24)} ${c.detail} ${icon}${required}`);
  }

  console.log(
    `\n${report.ok ? "All required local checks passed. Use the connection test before the first task." : "Some required checks failed. Fix the issues above before running Verdikt."}`,
  );
}

export async function runDoctorChecks(repoPath?: string): Promise<DoctorReport> {
  const { exec } = await import("node:child_process");
  const install = claudeInstallGuidance();

  async function check(
    code: string,
    name: string,
    cmd: string,
    required = true,
    cwd?: string,
  ): Promise<DoctorCheck> {
    return new Promise<DoctorCheck>((resolveCheck) => {
      try {
        exec(
          cmd,
          { encoding: "utf-8", timeout: 8_000, windowsHide: true, ...(cwd ? { cwd } : {}) },
          (err: ExecException | null, stdout: string) => {
            if (err) {
              resolveCheck({ code, name, ok: false, detail: "未找到或无法运行", required });
            } else {
              resolveCheck({
                code,
                name,
                ok: true,
                detail: stdout.trim().split(/\r?\n/)[0],
                required,
              });
            }
          },
        );
      } catch {
        resolveCheck({ code, name, ok: false, detail: "未找到或无法运行", required });
      }
    });
  }

  const selectedRepoPath = repoPath?.trim() ? resolve(repoPath) : undefined;
  const worktreeCheck: Promise<DoctorCheck> = selectedRepoPath
    ? check("git_worktree", "Git worktree", "git worktree list", true, selectedRepoPath)
    : Promise.resolve({
        code: "git_worktree",
        name: "Git worktree",
        ok: true,
        detail: "选择项目后检查",
        required: true,
        verification: "not_checked",
      });
  const [node, claude, git, pnpm, worktree] = await Promise.all([
    check("node", "Node.js", "node --version"),
    check("claude", "Claude Code", "claude --version"),
    check("git", "Git", "git --version"),
    check("pnpm", "pnpm", "pnpm --version", false),
    worktreeCheck,
  ]);
  if (!node.ok) node.fix = "安装 Node.js 20 或更新版本。";
  if (!git.ok) git.fix = "安装 Git 后重新检查。";
  if (!claude.ok) {
    claude.fix = "安装 Claude Code 后重新检查。";
    claude.action = { label: "查看安装说明", href: install.docsUrl, command: install.command };
  }
  const checks: DoctorCheck[] = [node, claude, git, pnpm, worktree];

  try {
    const config = getConfig();
    const provider = providerSettingsFromConfig(config);
    checks.push({
      code: "provider",
      name: "模型服务",
      ok: true,
      detail:
        provider.mode === "claude_login"
          ? `Claude 账号 · ${provider.model}`
          : `兼容服务 · ${provider.model} · ${provider.baseUrl}`,
      required: true,
    });
    if (provider.mode === "claude_login") {
      const login = claude.ok
        ? await inspectClaudeLogin(provider)
        : { loggedIn: false, detail: "请先安装 Claude Code" };
      checks.push({
        code: "claude_login",
        name: "Claude 登录",
        ok: login.loggedIn,
        detail: login.detail,
        required: true,
        fix: login.loggedIn ? undefined : "在终端运行 claude，并按提示完成登录。",
      });
    }
    checks.push({
      code: "provider_request",
      name: "模型连接测试",
      ok: true,
      detail: "请在模型设置中运行一次真实连接测试",
      required: false,
      verification: "not_checked",
    });
    checks.push({ code: "configuration", name: "配置", ok: true, detail: "有效", required: true });
    checks.push({
      code: "state_dir",
      name: "数据目录",
      ok: true,
      detail: resolve(config.stateDir),
      required: true,
    });
  } catch (error) {
    checks.push({
      code: "configuration",
      name: "配置",
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
