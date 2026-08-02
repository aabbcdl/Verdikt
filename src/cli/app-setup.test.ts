import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import type { ProviderProbeResult } from "../provider/types.js";
import { startAppServer } from "./app.js";

const servers: Array<{ close: () => Promise<void> }> = [];
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
