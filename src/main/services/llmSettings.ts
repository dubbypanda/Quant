import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { isLlmProvider, normalizeApiBaseUrl, providerDefinition } from '../../shared/llm';
import type { LlmProvider, LlmSettings, LlmSettingsInput } from '../../shared/types';

interface StoredLlmSettings {
  enabled: boolean;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  encryptedApiKey?: string;
}

export interface ResolvedLlmSettings extends LlmSettings {
  apiKey?: string;
}

const LEGACY_BASE_URL = process.env.QUANT_LLM_BASE_URL;
const DEFAULT_PROVIDER: LlmProvider = isLlmProvider(process.env.QUANT_LLM_PROVIDER)
  ? process.env.QUANT_LLM_PROVIDER
  : 'local';

function envEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.QUANT_LLM_ENABLED ?? '') || Boolean(LEGACY_BASE_URL);
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'llm-settings.json');
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function normalizeStored(raw: Partial<StoredLlmSettings> | null | undefined): StoredLlmSettings {
  const provider = isLlmProvider(raw?.provider) ? raw.provider : DEFAULT_PROVIDER;
  const defaults = providerDefinition(provider);
  const rawBase = typeof raw?.baseUrl === 'string' && raw.baseUrl.trim()
    ? raw.baseUrl
    : provider === 'local' && LEGACY_BASE_URL
      ? LEGACY_BASE_URL
      : defaults.baseUrl;
  const baseUrl = normalizeApiBaseUrl(rawBase);
  return {
    enabled: raw?.enabled === true || (raw?.enabled === undefined && envEnabled()),
    provider,
    baseUrl:
      provider === 'local' && !/\/v1$/i.test(baseUrl)
        ? `${baseUrl}/v1`
        : baseUrl,
    model:
      typeof raw?.model === 'string' && raw.model.trim()
        ? raw.model.trim()
        : process.env.QUANT_LLM_MODEL?.trim() || defaults.model,
    encryptedApiKey:
      typeof raw?.encryptedApiKey === 'string' && raw.encryptedApiKey
        ? raw.encryptedApiKey
        : undefined,
  };
}

function readStored(): StoredLlmSettings {
  try {
    return normalizeStored(JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<StoredLlmSettings>);
  } catch {
    return normalizeStored(null);
  }
}

function environmentApiKey(provider: LlmProvider): string | undefined {
  const key = {
    local: 'QUANT_LLM_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    grok: 'XAI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
  }[provider];
  return process.env[key]?.trim() || undefined;
}

function decryptApiKey(encrypted: string | undefined): string | undefined {
  if (!encrypted || !encryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

function publicSettings(stored: StoredLlmSettings): LlmSettings {
  return {
    enabled: stored.enabled,
    provider: stored.provider,
    baseUrl: stored.baseUrl,
    model: stored.model,
    hasApiKey: Boolean(decryptApiKey(stored.encryptedApiKey) || environmentApiKey(stored.provider)),
    credentialStorage: encryptionAvailable() ? 'encrypted' : 'unavailable',
  };
}

export function getLlmSettings(): LlmSettings {
  return publicSettings(readStored());
}

export function getResolvedLlmSettings(): ResolvedLlmSettings {
  const stored = readStored();
  return {
    ...publicSettings(stored),
    apiKey: decryptApiKey(stored.encryptedApiKey) || environmentApiKey(stored.provider),
  };
}

export function resolveTransientLlmSettings(raw: LlmSettingsInput): ResolvedLlmSettings {
  const current = readStored();
  const provider = isLlmProvider(raw.provider) ? raw.provider : current.provider;
  const normalized = normalizeStored({
    enabled: raw.enabled,
    provider,
    baseUrl: raw.baseUrl,
    model: raw.model,
    encryptedApiKey: provider === current.provider ? current.encryptedApiKey : undefined,
  });
  const typedKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const savedKey = provider === current.provider ? decryptApiKey(current.encryptedApiKey) : undefined;
  const apiKey = typedKey || savedKey || environmentApiKey(provider);
  return { ...publicSettings(normalized), hasApiKey: Boolean(apiKey), apiKey };
}

export function saveLlmSettings(raw: LlmSettingsInput): LlmSettings {
  const current = readStored();
  const provider = isLlmProvider(raw.provider) ? raw.provider : current.provider;
  let encryptedApiKey = provider === current.provider ? current.encryptedApiKey : undefined;
  if (raw.clearApiKey) encryptedApiKey = undefined;
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (apiKey) {
    if (!encryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable; the API key was not saved.');
    }
    encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
  }
  const settings = normalizeStored({
    enabled: raw.enabled,
    provider,
    baseUrl: raw.baseUrl,
    model: raw.model,
    encryptedApiKey,
  });
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  return publicSettings(settings);
}
