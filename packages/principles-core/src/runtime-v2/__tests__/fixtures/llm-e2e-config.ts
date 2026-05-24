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

export function getLlmE2eConfig(): LlmE2eTestConfig | null {
  const llmE2eApiKey = process.env.LLM_E2E_API_KEY;
  const minimaxApiKey = process.env.MINIMAX_CN_API_KEY;

  if (llmE2eApiKey) {
    return {
      apiKey: llmE2eApiKey,
      model: process.env.LLM_E2E_MODEL ?? 'deepseek-v4-flash',
      provider: process.env.LLM_E2E_PROVIDER ?? 'sensenova',
      apiKeyEnv: 'LLM_E2E_API_KEY',
      baseUrl: process.env.LLM_E2E_BASE_URL ?? 'https://token.sensenova.cn/v1',
      timeoutMs: 120_000,
      maxRetries: 2,
    };
  }

  if (minimaxApiKey) {
    return {
      apiKey: minimaxApiKey,
      model: process.env.LLM_E2E_MODEL ?? 'MiniMax-M2.7',
      provider: process.env.LLM_E2E_PROVIDER ?? 'minimax-cn',
      apiKeyEnv: 'MINIMAX_CN_API_KEY',
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
