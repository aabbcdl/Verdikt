import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../config.js";

const execMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

beforeEach(() => {
  execMock.mockReset();
  execMock.mockImplementation(() => {
    throw new Error("spawn EPERM");
  });
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
  resetConfig();
});

describe("doctor checks", () => {
  it("turns process launch permission errors into failed checks instead of throwing", async () => {
    const { runDoctorChecks } = await import("./doctor.js");
    const report = await runDoctorChecks();

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "Node.js")).toEqual(
      expect.objectContaining({ ok: false, detail: "未找到或无法运行" }),
    );
    expect(report.checks.find((check) => check.name === "模型连接测试")).toEqual(
      expect.objectContaining({
        ok: true,
        required: false,
        verification: "not_checked",
      }),
    );
    expect(report.checks.find((check) => check.code === "git_worktree")).toEqual(
      expect.objectContaining({
        ok: true,
        detail: "选择项目后检查",
        verification: "not_checked",
      }),
    );
  });

  it("runs the Git worktree check inside the selected project", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    execMock.mockImplementation(
      (
        command: string,
        _options: { cwd?: string },
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(null, command === "git worktree list" ? "D:/project/sample  abc123 [main]" : "v1");
        return {};
      },
    );
    const { runDoctorChecks } = await import("./doctor.js");

    const report = await runDoctorChecks("D:\\project\\sample");

    const worktreeCall = execMock.mock.calls.find((call) => call[0] === "git worktree list");
    expect(worktreeCall?.[1]).toEqual(expect.objectContaining({ cwd: "D:\\project\\sample" }));
    expect(report.checks.find((check) => check.code === "git_worktree")).toEqual(
      expect.objectContaining({ ok: true, detail: "D:/project/sample  abc123 [main]" }),
    );
  });
});
