import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { JudgeStep } from "../types.js";

export interface ProjectInspection {
  ok: boolean;
  repoPath: string;
  projectName: string;
  git: {
    isRepository: boolean;
    clean: boolean;
    branch?: string;
    dirtyFiles: string[];
  };
  projectType: string;
  packageManager?: string;
  recommendedSteps: JudgeStep[];
  summary: string;
  issues: Array<{ code: string; message: string; fix: string }>;
}

const MAX_DIRTY_FILES = 20;

export async function inspectProject(inputPath: string): Promise<ProjectInspection> {
  const requestedPath = resolve(String(inputPath ?? "").trim());
  const issues: ProjectInspection["issues"] = [];
  let projectName = basename(requestedPath);

  try {
    if (!(await stat(requestedPath)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    return {
      ok: false,
      repoPath: requestedPath,
      projectName,
      git: { isRepository: false, clean: false, dirtyFiles: [] },
      projectType: "未知项目",
      recommendedSteps: [],
      summary: "没有找到这个项目文件夹。",
      issues: [
        {
          code: "missing_directory",
          message: "项目文件夹不存在或无法访问。",
          fix: "重新选择一个本机项目文件夹。",
        },
      ],
    };
  }

  let repoPath = requestedPath;
  let isRepository = false;
  try {
    repoPath = resolve((await git(requestedPath, ["rev-parse", "--show-toplevel"])).trim());
    isRepository = true;
    projectName = basename(repoPath);
  } catch {
    issues.push({
      code: "not_git",
      message: "这个文件夹还不是 Git 项目。",
      fix: "先用 Git 保存一次当前项目，再重新检查。",
    });
  }

  let branch: string | undefined;
  let dirtyFiles: string[] = [];
  if (isRepository) {
    branch =
      (await git(repoPath, ["branch", "--show-current"]).catch(() => "")).trim() || undefined;
    const status = await git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    dirtyFiles = parseDirtyFiles(status).slice(0, MAX_DIRTY_FILES);
    if (dirtyFiles.length > 0) {
      issues.push({
        code: "dirty_repo",
        message: `项目有 ${dirtyFiles.length} 个未保存到版本记录的文件。`,
        fix: "先提交这些改动，或暂存后再开始任务。",
      });
    }
  }

  const detection = await detectProject(repoPath);
  if (detection.steps.length === 0) {
    issues.push({
      code: "no_acceptance",
      message: "没有自动找到可用的验收方式。",
      fix: "在“验收方式”中手动添加项目已有的测试或构建命令。",
    });
  }

  const blockingIssues = issues.filter((issue) => issue.code !== "no_acceptance");
  const ok = blockingIssues.length === 0;
  const summary = !isRepository
    ? "需要先把项目交给 Git 管理。"
    : dirtyFiles.length > 0
      ? "项目还有未提交的改动，暂时不能安全开始。"
      : detection.steps.length > 0
        ? `项目已就绪，自动找到 ${detection.steps.length} 项验收方式。`
        : "项目本身已就绪，但需要手动填写验收方式。";

  return {
    ok,
    repoPath,
    projectName,
    git: { isRepository, clean: isRepository && dirtyFiles.length === 0, branch, dirtyFiles },
    projectType: detection.projectType,
    packageManager: detection.packageManager,
    recommendedSteps: detection.steps,
    summary,
    issues,
  };
}

async function detectProject(repoPath: string): Promise<{
  projectType: string;
  packageManager?: string;
  steps: JudgeStep[];
}> {
  const packageJsonPath = join(repoPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
        packageManager?: unknown;
        scripts?: unknown;
      };
      const manager = detectPackageManager(repoPath, packageJson.packageManager);
      const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
      const steps = ["test", "typecheck", "check", "lint", "build"]
        .filter((name) => usableScript(scripts[name]))
        .slice(0, 4)
        .map((name) => ({
          id: name,
          command: manager,
          args: manager === "npm" && name === "test" ? ["test"] : ["run", name],
          required: true,
        }));
      return { projectType: "Node.js", packageManager: manager, steps };
    } catch {
      return { projectType: "Node.js", packageManager: detectPackageManager(repoPath), steps: [] };
    }
  }

  if (existsSync(join(repoPath, "Cargo.toml"))) {
    return {
      projectType: "Rust",
      packageManager: "cargo",
      steps: [{ id: "test", command: "cargo", args: ["test"], required: true }],
    };
  }
  if (existsSync(join(repoPath, "go.mod"))) {
    return {
      projectType: "Go",
      packageManager: "go",
      steps: [{ id: "test", command: "go", args: ["test", "./..."], required: true }],
    };
  }
  if (
    existsSync(join(repoPath, "pyproject.toml")) ||
    existsSync(join(repoPath, "pytest.ini")) ||
    existsSync(join(repoPath, "requirements.txt"))
  ) {
    const command = existsSync(join(repoPath, "uv.lock")) ? "uv" : "python";
    const args = command === "uv" ? ["run", "pytest"] : ["-m", "pytest"];
    return {
      projectType: "Python",
      packageManager: command,
      steps: [{ id: "test", command, args, required: true }],
    };
  }

  const rootFiles = await readdir(repoPath).catch(() => []);
  if (rootFiles.some((file) => /\.(?:sln|csproj)$/i.test(file))) {
    return {
      projectType: ".NET",
      packageManager: "dotnet",
      steps: [{ id: "test", command: "dotnet", args: ["test"], required: true }],
    };
  }

  return { projectType: "未识别", steps: [] };
}

function detectPackageManager(repoPath: string, declared?: unknown): string {
  if (typeof declared === "string") {
    const name = declared.trim().split("@")[0];
    if (["pnpm", "npm", "yarn", "bun"].includes(name)) return name;
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

function usableScript(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/no test specified|exit 1/i.test(value);
}

function parseDirtyFiles(status: string): string[] {
  return status
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const path = line.length > 3 ? line.slice(3) : line;
      const arrow = path.indexOf(" -> ");
      return (arrow >= 0 ? path.slice(arrow + 4) : path).trim();
    })
    .filter(Boolean);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolveResult(stdout ?? "");
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
