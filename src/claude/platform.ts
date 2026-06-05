/**
 * Platform detection utilities.
 *
 * Claude Code uses different tool names depending on the OS:
 * - Windows: "PowerShell" for shell commands
 * - macOS/Linux: "Bash" for shell commands
 */

/**
 * Get the name of the shell tool that Claude Code uses on this platform.
 */
export function getShellToolName(): string {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

/**
 * Build the allowedTools list with platform-appropriate shell tool.
 * Always includes Bash (for cross-platform compat) plus the native shell.
 */
export function buildAllowedTools(baseTools: string[]): string[] {
  const shell = getShellToolName();
  const tools = [...baseTools];

  // Always include both shell names to handle Claude Code's internal routing
  if (!tools.includes("Bash")) tools.push("Bash");
  if (!tools.includes(shell)) tools.push(shell);

  return tools;
}
