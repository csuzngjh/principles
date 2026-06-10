import { describe, it, expect } from 'vitest';
import { EmpathyObserver } from '../empathy-observer.js';
import { PiAiRuntimeAdapter } from '../../adapter/pi-ai-runtime-adapter.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

describe('EmpathyObserver Real E2E & Mock Fallback', () => {
  it('runs E2E against local LM Studio if available, otherwise falls back to stable mock validation', async () => {
    const provider = process.env.PD_EMPATHY_PROVIDER || 'lm-studio';
    const model = process.env.PD_EMPATHY_MODEL || 'qwen3.6-27b-mtp';
    const baseUrl = process.env.PD_EMPATHY_BASE_URL || 'http://localhost:12341/v1';
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

    // Detect if LM Studio is running by trying a quick fetch
    try {
      const response = await fetch(`${baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        // LM Studio is running! Use the real LLM adapter.
        adapter = new PiAiRuntimeAdapter({
          provider,
          model,
          apiKeyEnv,
          baseUrl,
          timeoutMs: 60000,
        });
        isRealLlm = true;
        console.log(`[E2E Test] LM Studio detected at ${baseUrl}. Running E2E test with real model: ${model}`);
      } else {
        console.log(`[E2E Test] LM Studio not running at ${baseUrl}. Falling back to stable mock validation.`);
      }
    } catch {
      console.log(`[E2E Test] LM Studio not running at ${baseUrl}. Falling back to stable mock validation.`);
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
