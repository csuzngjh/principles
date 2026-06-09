export interface LlmE2eTestConfig {
  apiKey: string;
  model: string;
  provider: string;
  apiKeyEnv: string;
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | false;
}

export interface RetryOptions {
  maxRetries?: number;
  delayMs?: number;
}

const SENSENOVA_DEFAULT_BASE_URL = 'https://token.sensenova.cn/v1';
const SENSENOVA_DEFAULT_MODEL = 'deepseek-v4-flash';

export function getLlmE2eConfig(): LlmE2eTestConfig | null {
  if (process.env.LLM_E2E_ENABLED !== 'true') {
    return null;
  }

  const llmE2eApiKey = process.env.LLM_E2E_API_KEY;
  const sensenovaApiKey = process.env.SENSENOVA_API_KEY;

  if (llmE2eApiKey) {
    const provider = process.env.LLM_E2E_PROVIDER ?? 'sensenova';
    const isSensenova = provider === 'sensenova';
    return {
      apiKey: llmE2eApiKey,
      model: process.env.LLM_E2E_MODEL ?? SENSENOVA_DEFAULT_MODEL,
      provider,
      apiKeyEnv: 'LLM_E2E_API_KEY',
      baseUrl: process.env.LLM_E2E_BASE_URL ?? (isSensenova ? SENSENOVA_DEFAULT_BASE_URL : undefined),
      timeoutMs: 120_000,
      maxRetries: 2,
    };
  }

  if (sensenovaApiKey) {
    const provider = process.env.LLM_E2E_PROVIDER ?? 'sensenova';
    const isSensenova = provider === 'sensenova';
    return {
      apiKey: sensenovaApiKey,
      model: process.env.LLM_E2E_MODEL ?? SENSENOVA_DEFAULT_MODEL,
      provider,
      apiKeyEnv: 'SENSENOVA_API_KEY',
      baseUrl: process.env.LLM_E2E_BASE_URL ?? (isSensenova ? SENSENOVA_DEFAULT_BASE_URL : undefined),
      timeoutMs: 120_000,
      maxRetries: 2,
      reasoning: false,
    };
  }

  return null;
}

/** @deprecated Use getLlmE2eConfig() instead */
export function getMiniMaxConfig(): LlmE2eTestConfig | null {
  return getLlmE2eConfig();
}

/** @deprecated Use LlmE2eTestConfig instead */
export type MiniMaxTestConfig = LlmE2eTestConfig;
