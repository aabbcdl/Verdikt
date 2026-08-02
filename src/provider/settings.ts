import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VerdiktConfig } from "../config.js";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";
import type {
  ProviderAuthType,
  ProviderMode,
  ProviderSettings,
  PublicProviderSettings,
} from "./types.js";

interface StoredProviderSettings extends ProviderSettings {
  version: 1;
}

export interface LoadedProviderSettings {
  settings: ProviderSettings;
  source: PublicProviderSettings["source"];
}

const SETTINGS_FILE = "provider-settings.json";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

export function providerSettingsFromConfig(config: VerdiktConfig): ProviderSettings {
  return {
    mode: config.providerMode,
    model: config.model,
    baseUrl: config.providerBaseUrl,
    authType: config.providerAuthType,
    credential: config.providerCredential,
  };
}

export function applyProviderSettingsToConfig(settings: ProviderSettings): Partial<VerdiktConfig> {
  return {
    model: settings.model,
    providerMode: settings.mode,
    providerBaseUrl: settings.baseUrl,
    providerAuthType: settings.authType,
    providerCredential: settings.credential,
  };
}

export async function loadProviderSettings(
  stateDir: string,
  fallback: ProviderSettings,
): Promise<LoadedProviderSettings> {
  const stored = await readJsonFile<StoredProviderSettings>(settingsPath(stateDir));
  if (!stored || stored.version !== 1) {
    return {
      settings: validateProviderSettings(fallback),
      source: providerSettingsUseEnvironment(fallback) ? "environment" : "default",
    };
  }

  try {
    const settings = validateProviderSettings(stored);
    const verified = stored.verifiedFingerprint === providerFingerprint(settings);
    return {
      settings: {
        ...settings,
        updatedAt: stored.updatedAt,
        verifiedAt: verified ? stored.verifiedAt : undefined,
        verifiedFingerprint: verified ? stored.verifiedFingerprint : undefined,
      },
      source: "saved",
    };
  } catch {
    return {
      settings: validateProviderSettings(fallback),
      source: providerSettingsUseEnvironment(fallback) ? "environment" : "default",
    };
  }
}

export async function saveProviderSettings(
  stateDir: string,
  settings: ProviderSettings,
): Promise<ProviderSettings> {
  const validated = validateProviderSettings(settings);
  const verified = settings.verifiedFingerprint === providerFingerprint(validated);
  const saved: StoredProviderSettings = {
    version: 1,
    ...validated,
    updatedAt: new Date().toISOString(),
    verifiedAt: verified ? settings.verifiedAt : undefined,
    verifiedFingerprint: verified ? settings.verifiedFingerprint : undefined,
  };
  const filePath = settingsPath(stateDir);
  await writeJsonAtomic(filePath, saved);
  await chmod(filePath, 0o600).catch(() => undefined);
  return saved;
}

export function providerSettingsFromInput(
  input: Record<string, unknown>,
  existing: ProviderSettings,
): ProviderSettings {
  const mode = readProviderMode(input.mode, existing.mode);
  const model = typeof input.model === "string" ? input.model : existing.model;
  const authType = readAuthType(input.authType, existing.authType);
  const clearCredential = input.clearCredential === true;
  const credential = clearCredential
    ? undefined
    : typeof input.credential === "string"
      ? input.credential.trim() || existing.credential
      : existing.credential;
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : existing.baseUrl;

  const candidate: ProviderSettings =
    mode === "claude_login"
      ? { mode, model, authType: "api_key" }
      : { mode, model, baseUrl, authType, credential };
  const validated = validateProviderSettings(candidate);
  const unchanged = providerFingerprint(validated) === providerFingerprint(existing);
  return {
    ...validated,
    verifiedAt: unchanged ? existing.verifiedAt : undefined,
    verifiedFingerprint: unchanged ? existing.verifiedFingerprint : undefined,
  };
}

export function validateProviderSettings(settings: ProviderSettings): ProviderSettings {
  const mode = readProviderMode(settings.mode);
  const model = String(settings.model ?? "").trim();
  if (!model || model.length > 200 || !MODEL_PATTERN.test(model)) {
    throw new Error("模型名称只能包含字母、数字以及 . _ : / @ -，长度不能超过 200。 ");
  }

  if (mode === "claude_login") {
    return { mode, model, authType: "api_key" };
  }

  const rawBaseUrl = String(settings.baseUrl ?? "").trim();
  if (!rawBaseUrl || rawBaseUrl.length > 2048) {
    throw new Error("请填写第三方服务地址。");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("服务地址不是有效的网址。");
  }
  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("服务地址必须是 http 或 https，且不能在网址中包含账号或密码。");
  }

  const authType = readAuthType(settings.authType);
  const credential = settings.credential?.trim() || undefined;
  if (credential && (credential.length > 4096 || /[\r\n\0]/.test(credential))) {
    throw new Error("访问凭据格式无效。");
  }

  return {
    mode,
    model,
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    authType,
    credential,
  };
}

export function markProviderVerified(
  settings: ProviderSettings,
  verified: boolean,
): ProviderSettings {
  return {
    ...settings,
    verifiedAt: verified ? new Date().toISOString() : undefined,
    verifiedFingerprint: verified ? providerFingerprint(settings) : undefined,
  };
}

export function toPublicProviderSettings(
  settings: ProviderSettings,
  source: PublicProviderSettings["source"],
): PublicProviderSettings {
  return {
    mode: settings.mode,
    model: settings.model,
    baseUrl: settings.baseUrl,
    authType: settings.authType,
    hasCredential: Boolean(settings.credential),
    verified:
      Boolean(settings.verifiedAt) &&
      settings.verifiedFingerprint === providerFingerprint(settings),
    verifiedAt: settings.verifiedAt,
    source,
  };
}

export function providerFingerprint(settings: ProviderSettings): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: settings.mode,
        model: settings.model,
        baseUrl: settings.baseUrl ?? "",
        authType: settings.authType,
        credential: settings.credential ?? "",
      }),
    )
    .digest("hex");
}

function providerSettingsUseEnvironment(settings: ProviderSettings): boolean {
  return Boolean(settings.baseUrl || settings.credential);
}

function settingsPath(stateDir: string): string {
  return join(resolve(stateDir), SETTINGS_FILE);
}

function readProviderMode(value: unknown, fallback?: ProviderMode): ProviderMode {
  if (value === undefined && fallback) return fallback;
  if (value === "claude_login" || value === "anthropic_compatible") return value;
  throw new Error("连接方式无效。");
}

function readAuthType(value: unknown, fallback?: ProviderAuthType): ProviderAuthType {
  if (value === undefined && fallback) return fallback;
  if (value === "api_key" || value === "auth_token") return value;
  throw new Error("鉴权方式无效。");
}
