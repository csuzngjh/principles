import { describe, it, expect } from 'vitest';
import { EmpathyObserver } from '../empathy-observer.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';

describe('EmpathyObserver', () => {
  it('correctly builds prompt', () => {
    const prompt = EmpathyObserver.buildPrompt('I am frustrated');
    expect(prompt).toContain('You are an empathy observer.');
    expect(prompt).toContain('I am frustrated');
  });

  it('runs successfully with valid output', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          damageDetected: true,
          severity: 'moderate',
          confidence: 0.9,
          reason: 'Frustration detected',
        },
      }),
    });

    const observer = new EmpathyObserver({ runtimeAdapter: adapter });
    const result = await observer.run({ userMessage: 'I am frustrated' });

    expect(result.damageDetected).toBe(true);
    expect(result.severity).toBe('moderate');
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe('Frustration detected');
  });

  it('throws error when output schema validation fails', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          damageDetected: 'not-a-boolean', // Should fail schema check
          severity: 'unknown-severity',
          confidence: 1.5,
          reason: 123,
        },
      }),
    });

    const observer = new EmpathyObserver({ runtimeAdapter: adapter });
    await expect(observer.run({ userMessage: 'I am frustrated' })).rejects.toThrow(
      'EmpathyObserver output validation failed'
    );
  });

  it('throws error when adapter run fails', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onPollRun: (runId) => ({
        runId,
        status: 'failed' as const,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        reason: 'LLM crashed',
      }),
    });

    const observer = new EmpathyObserver({ runtimeAdapter: adapter });
    await expect(observer.run({ userMessage: 'I am frustrated' })).rejects.toThrow(
      'EmpathyObserver run failed: failed'
    );
  });

  it('throws error when run times out', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onPollRun: (runId) => ({
        runId,
        status: 'running' as const,
        startedAt: new Date().toISOString(),
      }),
    });

    const observer = new EmpathyObserver({ runtimeAdapter: adapter }, { timeoutMs: 50 });
    await expect(observer.run({ userMessage: 'I am frustrated' })).rejects.toThrow(
      'EmpathyObserver run timed out after 50ms'
    );
  });

  it('throws error when confidence is out of range', async () => {
    const adapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId) => ({
        runId,
        payload: {
          damageDetected: true,
          severity: 'moderate',
          confidence: 5.0,
          reason: 'Out of range confidence',
        },
      }),
    });

    const observer = new EmpathyObserver({ runtimeAdapter: adapter });
    await expect(observer.run({ userMessage: 'I am frustrated' })).rejects.toThrow(
      'EmpathyObserver output validation failed'
    );
  });
});
