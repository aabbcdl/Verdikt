/**
 * Cross-platform process-tree termination.
 *
 * On Windows, Claude and judge commands are spawned through a cmd.exe
 * wrapper. `child.kill()` only terminates that wrapper (TerminateProcess on
 * the direct child), leaving the real claude/test process running as an
 * orphan — still billing, still writing to the workspace. `taskkill /T`
 * terminates the whole tree rooted at the wrapper.
 *
 * On POSIX the target command is the direct child, so a plain signal keeps
 * the existing semantics (no `detached` process groups — that would remove
 * children from the terminal's foreground group and break Ctrl+C).
 */

import { type ChildProcess, execFile } from "node:child_process";

export type KillSignal = "SIGTERM" | "SIGKILL";

export function killProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: KillSignal = "SIGTERM",
): void {
  const pid = child.pid;
  if (pid === undefined) {
    safeKill(child, signal);
    return;
  }

  if (process.platform === "win32") {
    // /T walks the tree from the still-alive root, so the wrapper must not be
    // killed first (its children would reparent and escape the walk).
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error) safeKill(child, "SIGKILL");
    });
    return;
  }

  safeKill(child, signal);
}

function safeKill(child: Pick<ChildProcess, "kill">, signal: KillSignal): void {
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}
