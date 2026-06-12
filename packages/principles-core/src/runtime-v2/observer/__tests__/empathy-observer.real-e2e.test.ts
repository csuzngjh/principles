import { describe, it, expect } from 'vitest';
import { EmpathyObserver } from '../empathy-observer.js';
import { PiAiRuntimeAdapter } from '../../adapter/pi-ai-runtime-adapter.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import { getLlmE2eConfig } from '../../__tests__/fixtures/llm-e2e-config.js';

const llmConfig = getLlmE2eConfig();

// Local LM Studio probe — only attempted when LLM_E2E_ENABLED=true
const LM_STUDIO_BASE_URL = process.env.PD_EMPATHY_BASE_URL || 'http://localhost:12341/v1';

describe('EmpathyObserver Real E2E & Mock Fallback', () => {
  it('runs E2E against local LM Studio if available, otherwise falls back to stable mock validation', async () => {
    const apiKeyEnv = 'LM_STUDIO_API_KEY';

    // Temporary set key if absent
    if (!process.env[apiKeyEnv]) {
      process.env[apiKeyEnv] = 'lm-studio-dummy-key';
    }

    // Initialize with stable mock adapter to satisfy ESLint constraints
    let adapter: PDRuntimeAdapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          damageDetected: true,
          severity: 'moderate',
          confidence: 0.85,
          reason: 'Frustration detected via stable mock fallback',
        },
      }),
    });
    let isRealLlm = false;

    // Only probe LM Studio when LLM_E2E_ENABLED=true (same gate as other real-LLM tests)
    if (llmConfig) {
      try {
        const response = await fetch(`${LM_STUDIO_BASE_URL}/models`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          const provider = process.env.PD_EMPATHY_PROVIDER || 'lm-studio';
          const model = process.env.PD_EMPATHY_MODEL || 'qwen3.6-27b-mtp';
          adapter = new PiAiRuntimeAdapter({
            provider,
            model,
            apiKeyEnv,
            baseUrl: LM_STUDIO_BASE_URL,
            timeoutMs: 60000,
          });
          isRealLlm = true;
          console.log(`[E2E Test] LM Studio detected at ${LM_STUDIO_BASE_URL}. Running E2E test with real model: ${model}`);
        } else {
          console.log(`[E2E Test] LM Studio not running at ${LM_STUDIO_BASE_URL}. Falling back to stable mock validation.`);
        }
      } catch {
        console.log(`[E2E Test] LM Studio not running at ${LM_STUDIO_BASE_URL}. Falling back to stable mock validation.`);
      }
    } else {
      console.log('[E2E Test] LLM_E2E_ENABLED is not true. Skipping LM Studio probe, using stable mock.');
    }

    const observer = new EmpathyObserver({ runtimeAdapter: adapter });
    const result = await observer.run({ userMessage: 'I am extremely frustrated! This is not working!' });

    // Assert structured schema shape and type bounds to tolerate LLM output variance
    expect(typeof result.damageDetected).toBe('boolean');
    expect(['mild', 'moderate', 'severe']).toContain(result.severity);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.reason).toBe('string');

    if (isRealLlm) {
      console.log(`[E2E Test] Real LLM result:`, JSON.stringify(result, null, 2));
    } else {
      expect(result.damageDetected).toBe(true);
      expect(result.reason).toBe('Frustration detected via stable mock fallback');
    }
  }, 120000);
});
