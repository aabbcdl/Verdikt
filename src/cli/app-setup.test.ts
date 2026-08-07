import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import type { ProviderProbeResult } from "../provider/types.js";
import { startAppServer } from "./app.js";

const servers: Array<{ close: () => Promise<void> }> = [];
const execFileAsync = promisify(execFile);
let tempDir = "";
let stateDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-app-setup-"));
  stateDir = join(tempDir, ".verdikt");
  await mkdir(stateDir, { recursive: true });
  setConfig({ stateDir });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetConfig();
  await rm(tempDir, { recursive: true, force: true });
});

describe("app first-run setup APIs", () => {
  it("saves and tests a compatible provider without returning its credential", async () => {
    const probeResult: ProviderProbeResult = {
      ok: true,
      stage: "request",
      message: "connection ok",
      version: "test-version",
      durationMs: 5,
    };
    const app = await startAppServer({
      port: 0,
      logStartup: false,
      doctorChecks: async () => ({
        ok: true,
        checks: [
          {
            code: "provider_request",
            name: "Provider request",
            ok: true,
            detail: "not checked",
            required: false,
            verification: "not_checked",
          },
        ],
      }),
      providerProbe: async (settings) => {
        expect(settings.credential).toBe("private-key");
        expect(settings.model).toBe("vendor/model-v1");
        return probeResult;
      },
    });
    servers.push(app);

    const saveResponse = await appFetch(app, "/api/provider/settings", {
      method: "POST",
      body: JSON.stringify({
        mode: "anthropic_compatible",
        model: "vendor/model-v1",
        baseUrl: "https://gateway.example.com/v1",
        authType: "api_key",
        credential: "private-key",
      }),
    });
    const saveText = await saveResponse.text();
    expect(saveResponse.status).toBe(200);
    expect(saveText).not.toContain("private-key");
    expect(JSON.parse(saveText).settings.hasCredential).toBe(true);

    const testResponse = await appFetch(app, "/api/provider/test", { method: "POST" });
    const tested = await testResponse.json();
    expect(testResponse.status).toBe(200);
    expect(tested.result.ok).toBe(true);
    expect(tested.settings.verified).toBe(true);
    expect(JSON.stringify(tested)).not.toContain("private-key");

    const doctorResponse = await fetch(`${app.url}/api/doctor`);
    const doctor = await doctorResponse.json();
    expect(doctor.checks[0]).toEqual(
      expect.objectContaining({
        verification: "confirmed",
        detail: "真实连接测试已通过 · vendor/model-v1",
      }),
    );

    const getResponse = await fetch(`${app.url}/api/provider/settings`);
    const getText = await getResponse.text();
    expect(getResponse.status).toBe(200);
    expect(getText).not.toContain("private-key");

    const stored = await readFile(join(stateDir, "provider-settings.json"), "utf-8");
    expect(stored).toContain("private-key");
    expect(stored).toContain("verifiedAt");
  });

  it("exposes folder selection and project inspection to the local workbench", async () => {
    const app = await startAppServer({
      port: 0,
      logStartup: false,
      folderPicker: async () => ({ selectedPath: "D:\\project\\sample", cancelled: false }),
      projectInspector: async (repoPath) => ({
        ok: true,
        repoPath,
        projectName: "sample",
        git: { isRepository: true, clean: true, branch: "main", dirtyFiles: [] },
        projectType: "Node.js",
        packageManager: "pnpm",
        recommendedSteps: [{ id: "test", command: "pnpm", args: ["run", "test"], required: true }],
        summary: "ready",
        issues: [],
      }),
    });
    servers.push(app);

    const selectResponse = await appFetch(app, "/api/project/select", { method: "POST" });
    expect(await selectResponse.json()).toEqual({
      selectedPath: "D:\\project\\sample",
      cancelled: false,
    });

    const inspectResponse = await appFetch(app, "/api/project/inspect", {
      method: "POST",
      body: JSON.stringify({ repoPath: "D:\\project\\sample" }),
    });
    const inspected = await inspectResponse.json();
    expect(inspected.ok).toBe(true);
    expect(inspected.recommendedSteps[0]).toEqual(
      expect.objectContaining({ command: "pnpm", args: ["run", "test"] }),
    );
  });

  it("creates and resets a dependency-free demo project inside the state directory", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(app);

    const firstResponse = await appFetch(app, "/api/demo/reset", { method: "POST" });
    const first = (await firstResponse.json()) as {
      repoPath: string;
      inspection: {
        ok: boolean;
        git: { isRepository: boolean; clean: boolean };
        recommendedSteps: Array<{ id: string; command: string; args: string[] }>;
      };
    };

    expect(firstResponse.status).toBe(200);
    const relativeDemoPath = relative(stateDir, first.repoPath);
    expect(relativeDemoPath.startsWith("..")).toBe(false);
    expect(isAbsolute(relativeDemoPath)).toBe(false);
    expect(first.inspection).toEqual(
      expect.objectContaining({
        ok: true,
        git: expect.objectContaining({ isRepository: true, clean: true }),
        recommendedSteps: [expect.objectContaining({ id: "test", command: "npm", args: ["test"] })],
      }),
    );
    expect(await readFile(join(first.repoPath, "src", "sum.js"), "utf-8")).toContain("a - b");
    expect(existsSync(join(first.repoPath, "node_modules"))).toBe(false);
    await expect(
      execFileAsync(process.execPath, ["--test"], { cwd: first.repoPath }),
    ).rejects.toThrow();

    await writeFile(
      join(first.repoPath, "src", "sum.js"),
      "export const sum = (a, b) => a + b;\n",
      "utf-8",
    );
    await writeFile(join(first.repoPath, "temporary.txt"), "remove me", "utf-8");

    const resetResponse = await appFetch(app, "/api/demo/reset", { method: "POST" });
    const reset = (await resetResponse.json()) as { repoPath: string };
    expect(resetResponse.status).toBe(200);
    expect(reset.repoPath).toBe(first.repoPath);
    expect(await readFile(join(reset.repoPath, "src", "sum.js"), "utf-8")).toContain("a - b");
    expect(existsSync(join(reset.repoPath, "temporary.txt"))).toBe(false);
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], {
      cwd: reset.repoPath,
    });
    expect(stdout).toBe("");
  });
});

function appFetch(
  app: { url: string; sessionHeaders: Readonly<Record<string, string>> },
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  for (const [name, value] of Object.entries(app.sessionHeaders)) headers.set(name, value);
  return fetch(`${app.url}${path}`, { ...init, headers });
}
