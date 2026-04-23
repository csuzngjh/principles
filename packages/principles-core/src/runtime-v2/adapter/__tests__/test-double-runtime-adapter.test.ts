/**
 * TestDoubleRuntimeAdapter unit tests.
 *
 * Verifies default behavior (succeed-on-first-poll) and callback override mechanism.
 */
import { describe, it, expect } from 'vitest';
import { TestDoubleRuntimeAdapter } from '../test-double-runtime-adapter.js';
import type { TestDoubleBehaviorOverrides } from '../test-double-runtime-adapter.js';

describe('TestDoubleRuntimeAdapter', () => {
  describe('default behavior', () => {
    it('returns kind "test-double"', () => {
      const adapter = new TestDoubleRuntimeAdapter();
      expect(adapter.kind()).toBe('test-double');
    });

    it('startRun returns RunHandle with runId, runtimeKind, and valid ISO startedAt', async () => {
      const adapter = new TestDoubleRuntimeAdapter();
      const handle = await adapter.startRun({
        agentSpec: { agentId: 'test', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 5000,
      });
      expect(handle.runId).toMatch(/^td-\d+$/);
      expect(handle.runtimeKind).toBe('test-double');
      expect(new Date(handle.startedAt).toISOString()).toBe(handle.startedAt);
    });

    it('pollRun returns succeeded status on first call', async () => {
      const adapter = new TestDoubleRuntimeAdapter();
      const status = await adapter.pollRun('td-1');
      expect(status.runId).toBe('td-1');
      expect(status.status).toBe('succeeded');
      expect(status.endedAt).toBeDefined();
    });

    it('fetchOutput returns valid DiagnosticianOutputV1 payload by default', async () => {
      const adapter = new TestDoubleRuntimeAdapter({}, 'task-42');
      const output = await adapter.fetchOutput('td-1');
      expect(output).not.toBeNull();
      const result = output as { runId: string; payload: Record<string, unknown> };
      expect(result.runId).toBe('td-1');
      const {payload} = result;
      expect(payload.valid).toBe(true);
      expect(payload.taskId).toBe('task-42');
      expect(payload.summary).toBeTruthy();
      expect(payload.rootCause).toBeTruthy();
      expect(payload.confidence).toBeGreaterThanOrEqual(0);
      expect(payload.confidence).toBeLessThanOrEqual(1);
    });

    it('getCapabilities returns capabilities with structuredJsonOutput=true and cancellation=true', async () => {
      const adapter = new TestDoubleRuntimeAdapter();
      const caps = await adapter.getCapabilities();
      expect(caps.supportsStructuredJsonOutput).toBe(true);
      expect(caps.supportsCancellation).toBe(true);
      expect(caps.supportsToolUse).toBe(false);
    });

    it('healthCheck returns healthy=true, degraded=false', async () => {
      const adapter = new TestDoubleRuntimeAdapter();
      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.degraded).toBe(false);
      expect(health.warnings).toEqual([]);
    });

    it('cancelRun resolves without error', async () => {
      const adapter = new TestDoubleRuntimeAdapter();
      await expect(adapter.cancelRun('td-1')).resolves.toBeUndefined();
    });

    it('fetchArtifacts returns empty array', async () => {
      const adapter = new TestDoubleRuntimeAdapter();
      const artifacts = await adapter.fetchArtifacts('td-1');
      expect(artifacts).toEqual([]);
    });
  });

  describe('behavior overrides', () => {
    it('onStartRun callback overrides default startRun behavior', async () => {
      const overrides: TestDoubleBehaviorOverrides = {
        onStartRun: (_input) => ({
          runId: 'custom-run-999',
          runtimeKind: 'test-double',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
      };
      const adapter = new TestDoubleRuntimeAdapter(overrides);
      const handle = await adapter.startRun({
        agentSpec: { agentId: 'test', schemaVersion: 'v1' },
        inputPayload: {},
        contextItems: [],
        timeoutMs: 5000,
      });
      expect(handle.runId).toBe('custom-run-999');
    });

    it('onPollRun callback overrides default pollRun behavior', async () => {
      const overrides: TestDoubleBehaviorOverrides = {
        onPollRun: (runId) => ({
          runId,
          status: 'failed' as const,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:01:00.000Z',
          reason: 'Injected failure',
        }),
      };
      const adapter = new TestDoubleRuntimeAdapter(overrides);
      const status = await adapter.pollRun('td-1');
      expect(status.status).toBe('failed');
      expect(status.reason).toBe('Injected failure');
    });

    it('onFetchOutput callback overrides default fetchOutput behavior', async () => {
      const overrides: TestDoubleBehaviorOverrides = {
        onFetchOutput: () => null,
      };
      const adapter = new TestDoubleRuntimeAdapter(overrides);
      const output = await adapter.fetchOutput('td-1');
      expect(output).toBeNull();
    });

    it('onCancelRun callback is invoked when cancelRun is called', async () => {
      const cancelledRunIds: string[] = [];
      const overrides: TestDoubleBehaviorOverrides = {
        onCancelRun: (runId) => { cancelledRunIds.push(runId); },
      };
      const adapter = new TestDoubleRuntimeAdapter(overrides);
      await adapter.cancelRun('td-42');
      expect(cancelledRunIds).toEqual(['td-42']);
    });
  });
});
