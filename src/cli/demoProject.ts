import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const DEMO_DIRECTORY = "demo-project";

export async function prepareDemoProject(stateDirInput: string): Promise<string> {
  const stateDir = resolve(stateDirInput);
  const repoPath = resolve(stateDir, DEMO_DIRECTORY);
  const relativePath = relative(stateDir, repoPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Demo project path must stay inside the Verdikt state directory");
  }

  const sourcePath = resolve(import.meta.dirname, "../../assets/demo-project");
  await rm(repoPath, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
  await cp(sourcePath, repoPath, { recursive: true, force: true });

  await git(repoPath, ["init", "--quiet"]);
  await git(repoPath, ["config", "user.name", "Verdikt Demo"]);
  await git(repoPath, ["config", "user.email", "demo@verdikt.local"]);
  await git(repoPath, ["add", "--all"]);
  await git(repoPath, ["commit", "--quiet", "-m", "Initial demo project"]);
  await git(repoPath, ["branch", "-M", "main"]);
  return repoPath;
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 15_000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolveResult();
      },
    );
  });
}
