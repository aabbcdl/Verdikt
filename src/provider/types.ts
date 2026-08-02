export type ProviderMode = "claude_login" | "anthropic_compatible";

export type ProviderAuthType = "api_key" | "auth_token";

export interface ProviderSettings {
  mode: ProviderMode;
  model: string;
  baseUrl?: string;
  authType: ProviderAuthType;
  credential?: string;
  updatedAt?: string;
  verifiedAt?: string;
  verifiedFingerprint?: string;
}

export interface PublicProviderSettings {
  mode: ProviderMode;
  model: string;
  baseUrl?: string;
  authType: ProviderAuthType;
  hasCredential: boolean;
  verified: boolean;
  verifiedAt?: string;
  source: "saved" | "environment" | "default";
}

export interface ProviderProbeResult {
  ok: boolean;
  stage: "cli" | "login" | "request";
  message: string;
  version?: string;
  durationMs: number;
}
