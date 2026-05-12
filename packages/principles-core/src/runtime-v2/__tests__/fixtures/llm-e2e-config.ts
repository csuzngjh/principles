/**
 * MiniMax E2E Test Configuration
 *
 * Provides configuration and utilities for running E2E tests with real MiniMax LLM API.
 * Uses the same provider/env configuration as the production workflows.yaml:
 *   provider: minimax-cn
 *   apiKeyEnv: MINIMAX_CN_API_KEY
 */

export interface MiniMaxTestConfig {
  apiKey: string;
  model: 'MiniMax-M2.7';
  provider: 'minimax-cn';
  apiKeyEnv: 'MINIMAX_CN_API_KEY';
  timeoutMs: number;
  maxRetries: number;
}

export interface RetryOptions {
  maxRetries?: number;
  delayMs?: number;
}

export function getMiniMaxConfig(): MiniMaxTestConfig | null {
  const apiKey = process.env.MINIMAX_CN_API_KEY;
  if (!apiKey) {
    return null;
  }
  return {
    apiKey,
    model: 'MiniMax-M2.7',
    provider: 'minimax-cn',
    apiKeyEnv: 'MINIMAX_CN_API_KEY',
    timeoutMs: 120_000,
    maxRetries: 2,
  };
}
