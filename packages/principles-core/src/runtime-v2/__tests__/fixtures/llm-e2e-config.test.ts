import { describe, it, expect, afterEach } from 'vitest';
import { getLlmE2eConfig } from './llm-e2e-config.js';

describe('getLlmE2eConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null when no API keys are set', () => {
    delete process.env.LLM_E2E_API_KEY;
    delete process.env.SENSENOVA_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(getLlmE2eConfig()).toBeNull();
  });

  it('sensenova provider gets default baseUrl', () => {
    process.env.LLM_E2E_API_KEY = 'test-key';
    delete process.env.LLM_E2E_PROVIDER;
    delete process.env.LLM_E2E_BASE_URL;
    const config = getLlmE2eConfig();
    expect(config).not.toBeNull();
    if (!config) return;
    expect(config.provider).toBe('sensenova');
    expect(config.baseUrl).toBe('https://token.sensenova.cn/v1');
    expect(config.model).toBe('deepseek-v4-flash');
  });

  it('openrouter provider does not get sensenova baseUrl', () => {
    process.env.LLM_E2E_API_KEY = 'test-key';
    process.env.LLM_E2E_PROVIDER = 'openrouter';
    delete process.env.LLM_E2E_BASE_URL;
    const config = getLlmE2eConfig();
    expect(config).not.toBeNull();
    if (!config) return;
    expect(config.provider).toBe('openrouter');
    expect(config.baseUrl).toBeUndefined();
  });

  it('LLM_E2E_BASE_URL overrides provider default', () => {
    process.env.LLM_E2E_API_KEY = 'test-key';
    delete process.env.LLM_E2E_PROVIDER;
    process.env.LLM_E2E_BASE_URL = 'https://custom.endpoint/v1';
    const config = getLlmE2eConfig();
    expect(config).not.toBeNull();
    if (!config) return;
    expect(config.provider).toBe('sensenova');
    expect(config.baseUrl).toBe('https://custom.endpoint/v1');
  });

  it('non-sensenova provider with explicit LLM_E2E_BASE_URL uses that URL', () => {
    process.env.LLM_E2E_API_KEY = 'test-key';
    process.env.LLM_E2E_PROVIDER = 'openrouter';
    process.env.LLM_E2E_BASE_URL = 'https://openrouter.ai/v1';
    const config = getLlmE2eConfig();
    expect(config).not.toBeNull();
    if (!config) return;
    expect(config.provider).toBe('openrouter');
    expect(config.baseUrl).toBe('https://openrouter.ai/v1');
  });

  it('SENSENOVA_API_KEY fallback uses sensenova provider with baseUrl', () => {
    delete process.env.LLM_E2E_API_KEY;
    process.env.SENSENOVA_API_KEY = 'sensenova-key';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.LLM_E2E_BASE_URL;
    const config = getLlmE2eConfig();
    expect(config).not.toBeNull();
    if (!config) return;
    expect(config.provider).toBe('sensenova');
    expect(config.baseUrl).toBe('https://token.sensenova.cn/v1');
    expect(config.apiKeyEnv).toBe('SENSENOVA_API_KEY');
  });

  it('ANTHROPIC_AUTH_TOKEN fallback uses sensenova provider with baseUrl', () => {
    delete process.env.LLM_E2E_API_KEY;
    delete process.env.SENSENOVA_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-key';
    delete process.env.LLM_E2E_BASE_URL;
    const config = getLlmE2eConfig();
    expect(config).not.toBeNull();
    if (!config) return;
    expect(config.provider).toBe('sensenova');
    expect(config.baseUrl).toBe('https://token.sensenova.cn/v1');
    expect(config.apiKeyEnv).toBe('ANTHROPIC_AUTH_TOKEN');
  });
});
