import type { LlmProvider } from './types';

// Connection probes must leave enough budget for reasoning-capable models to
// produce visible text. OpenAI's max_completion_tokens includes reasoning
// tokens, while local OpenAI-compatible servers use the same value as the
// output-token limit.
export const LLM_CONNECTION_TEST_MAX_TOKENS = 128;

export interface LlmProviderDefinition {
  id: LlmProvider;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  requiresApiKey: boolean;
}

export const LLM_PROVIDERS: LlmProviderDefinition[] = [
  {
    id: 'local',
    label: 'Local llama.cpp',
    description: 'Private inference on this Mac through llama-server.',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'gemma-4-e4b-it',
    requiresApiKey: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI API using the Chat Completions interface.',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
    requiresApiKey: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini through Google\'s OpenAI-compatible endpoint.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash',
    requiresApiKey: true,
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    description: 'Grok through xAI\'s OpenAI-compatible endpoint.',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.3',
    requiresApiKey: true,
  },
  {
    id: 'claude',
    label: 'Anthropic Claude',
    description: 'Claude through the native Messages API.',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    requiresApiKey: true,
  },
];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return LLM_PROVIDERS.some((provider) => provider.id === value);
}

export function providerDefinition(provider: LlmProvider): LlmProviderDefinition {
  return LLM_PROVIDERS.find((item) => item.id === provider) ?? LLM_PROVIDERS[0];
}

export function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
