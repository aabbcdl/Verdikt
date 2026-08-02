import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProviderEnvironment } from "./runtime.js";
import {
  loadProviderSettings,
  markProviderVerified,
  providerSettingsFromInput,
  saveProviderSettings,
  toPublicProviderSettings,
  validateProviderSettings,
} from "./settings.js";
import type { ProviderSettings } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("provider settings", () => {
  it("validates an Anthropic-compatible service and maps its credential into Claude Code", () => {
    const settings = validateProviderSettings({
      mode: "anthropic_compatible",
      model: "vendor/deepseek-v3",
      baseUrl: "https://gateway.example.com/v1/",
      authType: "auth_token",
      credential: "secret-token",
    });

    expect(settings.baseUrl).toBe("https://gateway.example.com/v1");
    expect(
      buildProviderEnvironment(
        {
          ANTHROPIC_BASE_URL: "https://old.example.com",
          ANTHROPIC_API_KEY: "old-key",
        },
        settings,
      ),
    ).toEqual(
      expect.objectContaining({
        ANTHROPIC_BASE_URL: "https://gateway.example.com/v1",
        ANTHROPIC_AUTH_TOKEN: "secret-token",
        ANTHROPIC_API_KEY: undefined,
      }),
    );
  });

  it("removes API overrides when Claude account login is selected", () => {
    const env = buildProviderEnvironment(
      {
        ANTHROPIC_BASE_URL: "https://old.example.com",
        ANTHROPIC_API_KEY: "old-key",
        ANTHROPIC_AUTH_TOKEN: "old-token",
      },
      { mode: "claude_login", model: "sonnet", authType: "api_key" },
    );

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("preserves an existing credential when the form leaves it blank", () => {
    const existing: ProviderSettings = {
      mode: "anthropic_compatible",
      model: "model-a",
      baseUrl: "https://gateway.example.com",
      authType: "api_key",
      credential: "saved-secret",
    };
    const next = providerSettingsFromInput(
      {
        mode: "anthropic_compatible",
        model: "model-b",
        baseUrl: "https://gateway.example.com",
        authType: "api_key",
        credential: "",
      },
      existing,
    );

    expect(next.credential).toBe("saved-secret");
    expect(next.model).toBe("model-b");
  });

  it("stores settings locally but never exposes the credential in the public response", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "verdikt-provider-settings-"));
    tempDirs.push(stateDir);
    const verified = markProviderVerified(
      {
        mode: "anthropic_compatible",
        model: "custom-model",
        baseUrl: "https://gateway.example.com",
        authType: "api_key",
        credential: "top-secret",
      },
      true,
    );
    await saveProviderSettings(stateDir, verified);

    const loaded = await loadProviderSettings(stateDir, {
      mode: "claude_login",
      model: "sonnet",
      authType: "api_key",
    });
    const publicSettings = toPublicProviderSettings(loaded.settings, loaded.source);
    const raw = await readFile(join(stateDir, "provider-settings.json"), "utf-8");

    expect(raw).toContain("top-secret");
    expect(publicSettings.hasCredential).toBe(true);
    expect(publicSettings.verified).toBe(true);
    expect(JSON.stringify(publicSettings)).not.toContain("top-secret");
    expect(publicSettings).not.toHaveProperty("credential");
  });

  it("rejects shell metacharacters in model names and non-http service addresses", () => {
    expect(() =>
      validateProviderSettings({
        mode: "anthropic_compatible",
        model: "model & whoami",
        baseUrl: "https://gateway.example.com",
        authType: "api_key",
      }),
    ).toThrow("模型名称");
    expect(() =>
      validateProviderSettings({
        mode: "anthropic_compatible",
        model: "model-a",
        baseUrl: "file:///tmp/provider",
        authType: "api_key",
      }),
    ).toThrow("http");
  });
});
