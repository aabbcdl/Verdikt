import { spawn } from "node:child_process";

export interface FolderPickerResult {
  selectedPath?: string;
  cancelled: boolean;
  error?: string;
}

export async function pickProjectFolder(
  platform: NodeJS.Platform = process.platform,
): Promise<FolderPickerResult> {
  const invocation = folderPickerInvocation(platform);
  if (!invocation) {
    return {
      cancelled: false,
      error: "当前系统没有可用的文件夹选择器，请直接填写项目路径。",
    };
  }

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ cancelled: false, error: "文件夹选择超时，请重新尝试。" });
    }, 5 * 60_000);

    const finish = (result: FolderPickerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.once("error", (error) => finish({ cancelled: false, error: error.message }));
    child.once("close", (code) => {
      const selectedPath = stdout.trim().replace(/[\r\n]+$/, "");
      if (selectedPath) finish({ selectedPath, cancelled: false });
      else if (code === 0 || code === 1) finish({ cancelled: true });
      else finish({ cancelled: false, error: stderr.trim() || "无法打开文件夹选择器。" });
    });
  });
}

export function folderPickerInvocation(
  platform: NodeJS.Platform,
): { command: string; args: string[] } | null {
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$utf8 = New-Object System.Text.UTF8Encoding($false)",
      "[Console]::OutputEncoding = $utf8",
      "$OutputEncoding = $utf8",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择要交给 Verdikt 的项目文件夹'",
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", script],
    };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "选择要交给 Verdikt 的项目文件夹")'],
    };
  }
  if (platform === "linux") {
    return {
      command: "zenity",
      args: ["--file-selection", "--directory", "--title=选择要交给 Verdikt 的项目文件夹"],
    };
  }
  return null;
}
