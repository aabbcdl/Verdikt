import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTree } from "../claude/processTree.js";
import { getConfig } from "../config.js";
import { buildProviderEnvironment } from "./runtime.js";
import { providerSettingsFromConfig } from "./settings.js";
import type { ProviderProbeResult, ProviderSettings } from "./types.js";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  launchError?: string;
}

const OUTPUT_LIMIT = 12_000;

export async function inspectClaudeInstallation(): Promise<{
  installed: boolean;
  version?: string;
  detail: string;
}> {
  const settings = providerSettingsFromConfig(getConfig());
  const result = await runClaude(["--version"], "", settings, 8_000);
  const version = result.stdout.trim().split(/\r?\n/)[0];
  return {
    installed: result.code === 0 && !result.timedOut,
    version: result.code === 0 ? version : undefined,
    detail:
      result.code === 0
        ? version
        : result.timedOut
          ? "检查超时"
          : cleanFailure(result) || "未找到 Claude Code",
  };
}

export async function inspectClaudeLogin(settings: ProviderSettings): Promise<{
  loggedIn: boolean;
  detail: string;
}> {
  const result = await runClaude(["auth", "status"], "", settings, 10_000);
  if (result.code !== 0) {
    return { loggedIn: false, detail: cleanFailure(result) || "尚未登录" };
  }
  try {
    const status = JSON.parse(result.stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiProvider?: unknown;
    };
    return {
      loggedIn: status.loggedIn === true,
      detail:
        status.loggedIn === true
          ? [status.authMethod, status.apiProvider].filter(Boolean).join(" · ") || "已登录"
          : "尚未登录",
    };
  } catch {
    return { loggedIn: false, detail: "无法确认登录状态" };
  }
}

export async function probeProvider(settings: ProviderSettings): Promise<ProviderProbeResult> {
  const startedAt = Date.now();
  const installation = await inspectClaudeInstallation();
  if (!installation.installed) {
    return {
      ok: false,
      stage: "cli",
      message: "没有找到 Claude Code，请先安装后再测试连接。",
      durationMs: Date.now() - startedAt,
    };
  }

  if (settings.mode === "claude_login") {
    const login = await inspectClaudeLogin(settings);
    if (!login.loggedIn) {
      return {
        ok: false,
        stage: "login",
        message: "Claude Code 尚未登录，请先在终端运行 claude 并完成登录。",
        version: installation.version,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const result = await runClaude(
    ["--print", "--output-format", "json", "--model", settings.model, "--tools", ""],
    "Reply with exactly VERDIKT_CONNECTION_OK and nothing else.",
    settings,
    60_000,
  );
  if (result.timedOut) {
    return {
      ok: false,
      stage: "request",
      message: "连接测试超过 60 秒没有完成，请检查服务地址和网络后重试。",
      version: installation.version,
      durationMs: Date.now() - startedAt,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      stage: "request",
      message: providerFailureMessage(cleanFailure(result)),
      version: installation.version,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const payload = JSON.parse(result.stdout) as { is_error?: unknown; result?: unknown };
    if (payload.is_error === true) {
      return {
        ok: false,
        stage: "request",
        message: providerFailureMessage(String(payload.result ?? "服务返回错误")),
        version: installation.version,
        durationMs: Date.now() - startedAt,
      };
    }
  } catch {
    // Some compatible gateways return plain text even when Claude Code exits successfully.
  }

  return {
    ok: true,
    stage: "request",
    message: `连接成功，模型 ${settings.model} 可以使用。`,
    version: installation.version,
    durationMs: Date.now() - startedAt,
  };
}

export function claudeInstallGuidance(platform: NodeJS.Platform = process.platform): {
  command: string;
  docsUrl: string;
} {
  const command =
    platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  return { command, docsUrl: "https://code.claude.com/docs/en/setup" };
}

function runClaude(
  args: string[],
  input: string,
  settings: ProviderSettings,
  timeoutMs: number,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const invocation = buildClaudeInvocation(args);
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildProviderEnvironment(process.env, settings),
      });
    } catch (error) {
      resolveResult({
        code: null,
        stdout,
        stderr,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        launchError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (code: number | null, launchError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        launchError,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf-8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf-8"));
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));
    child.stdin?.on("error", () => undefined);
    if (input) child.stdin?.write(input);
    child.stdin?.end();
  });
}

function buildClaudeInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "claude", args };
  for (const arg of args) {
    if (/[\r\n"&|<>^%]/.test(arg)) throw new Error(`Unsafe Claude CLI argument: ${arg}`);
  }
  const commandLine = ["claude", ...args].map(quoteWindowsArgument).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function quoteWindowsArgument(value: string): string {
  if (!value) return '""';
  return /\s/.test(value) ? `"${value}"` : value;
}

function appendLimited(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= OUTPUT_LIMIT ? combined : combined.slice(-OUTPUT_LIMIT);
}

function cleanFailure(result: CommandResult): string {
  return (result.stderr || result.stdout || result.launchError || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function providerFailureMessage(detail: string): string {
  const normalized = detail.toLowerCase();
  if (/401|unauthorized|authentication|invalid.*key|api key/.test(normalized)) {
    return "连接被拒绝，请检查访问凭据和鉴权方式。";
  }
  if (/402|credit|balance|billing/.test(normalized)) {
    return "账号余额或额度不足，请处理后重新测试。";
  }
  if (/404|model.*not.*found|unknown model/.test(normalized)) {
    return "服务找不到这个模型，请核对模型名称。";
  }
  if (/429|rate.?limit/.test(normalized)) {
    return "服务当前限流，请稍后重新测试。";
  }
  return detail ? `连接失败：${detail}` : "连接失败，请检查服务地址、凭据和模型名称。";
}
