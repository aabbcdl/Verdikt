import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(() => {
    throw new Error("spawn EPERM");
  }),
}));

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
  });
});
