import type { LlmConnectionResult } from '../../shared/types';
import { LLM_CONNECTION_TEST_MAX_TOKENS } from '../../shared/llm';
import type { ResolvedLlmSettings } from './llmSettings';

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface ClaudeResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

function errorMessage(json: unknown, fallback: string): string {
  if (!json || typeof json !== 'object') return fallback;
  const error = (json as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' && error.message ? error.message : fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function completeLlm(
  settings: ResolvedLlmSettings,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs = 45_000,
): Promise<string> {
  if (settings.provider !== 'local' && !settings.apiKey) {
    throw new Error(`${settings.provider} API key is required`);
  }
  if (settings.provider === 'claude') {
    const response = await fetch(`${settings.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const json = (await responseJson(response)) as ClaudeResponse | null;
    if (!response.ok) throw new Error(errorMessage(json, `Claude HTTP ${response.status}`));
    const answer = json?.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n').trim();
    if (!answer) throw new Error('Claude returned an empty answer');
    return answer;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const tokenLimit = settings.provider === 'openai'
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.15,
      ...tokenLimit,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = (await responseJson(response)) as OpenAiChatResponse | null;
  if (!response.ok) throw new Error(errorMessage(json, `LLM HTTP ${response.status}`));
  const answer = json?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('LLM returned an empty answer');
  return answer;
}

export async function testLlmConnection(settings: ResolvedLlmSettings): Promise<LlmConnectionResult> {
  const started = Date.now();
  try {
    const answer = await completeLlm(
      settings,
      'This is a connection check.',
      'Reply with OK only.',
      LLM_CONNECTION_TEST_MAX_TOKENS,
      20_000,
    );
    return {
      ok: true,
      provider: settings.provider,
      model: settings.model,
      latencyMs: Date.now() - started,
      message: `Connected successfully: ${answer.slice(0, 80)}`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: settings.provider,
      model: settings.model,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}
