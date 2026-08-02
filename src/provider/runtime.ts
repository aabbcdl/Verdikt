import type { ProviderSettings } from "./types.js";

export function buildProviderEnvironment(
  base: NodeJS.ProcessEnv,
  settings: ProviderSettings,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.ANTHROPIC_BASE_URL = undefined;
  env.ANTHROPIC_API_KEY = undefined;
  env.ANTHROPIC_AUTH_TOKEN = undefined;

  if (settings.mode === "anthropic_compatible") {
    env.ANTHROPIC_BASE_URL = settings.baseUrl;
    if (settings.credential) {
      if (settings.authType === "auth_token") env.ANTHROPIC_AUTH_TOKEN = settings.credential;
      else env.ANTHROPIC_API_KEY = settings.credential;
    }
  }

  return env;
}
