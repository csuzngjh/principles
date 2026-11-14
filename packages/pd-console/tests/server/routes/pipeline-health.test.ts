/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3.4 — GET /api/pipeline-health.
 *
 * Focus: route wiring + the honesty contract. The metric VALUES are unit-tested
 * in principles-core; here we prove the route (a) validates input, (b) honours
 * the feature flag, (c) reports UNKNOWN instead of fabricated zeros, and
 * (d) reads a REAL state.db through the owning stores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handlePipelineHealthRoute, disposePipelineHealthModels } from '../../../src/server/routes/pipeline-health.js';
import { RuntimeStateManager } from '@principles/core/runtime';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';

function createMockRequest(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: (statusCode: number, headers?: Record<string, string>) => {
      (res as unknown as { statusCode: number }).statusCode = statusCode;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    end: (data?: string) => {
      if (data !== undefined) (res as unknown as { _body: string })._body = data;
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

function rawBody<T>(res: ServerResponse): T {
  return JSON.parse((res as unknown as { _body: string })._body) as T;
}

/** Unwrap the `{success:true, data}` envelope used by sendSuccess. */
function body<T>(res: ServerResponse): T {
  return rawBody<{ success: true; data: T }>(res).data;
}

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pipeline-health-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  disposePipelineHealthModels();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handlePipelineHealthRoute', () => {
  it('rejects non-GET requests', async () => {
    const res = createMockResponse();
    await handlePipelineHealthRoute(createMockRequest('POST', '/api/pipeline-health'), res, { workspaceDir });
    expect(res.statusCode).toBe(405);
  });

  it('rejects a non-numeric window instead of silently defaulting', async () => {
    const res = createMockResponse();
    await handlePipelineHealthRoute(createMockRequest('GET', '/api/pipeline-health?window=abc'), res, { workspaceDir });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to read when failed_tasks_observability is disabled', async () => {
    const res = createMockResponse();
    await handlePipelineHealthRoute(createMockRequest('GET', '/api/pipeline-health'), res, {
      workspaceDir,
      featureFlags: { failed_tasks_observability: { enabled: false } },
    });
    expect(res.statusCode).toBe(403);
    expect(rawBody<{ error: string }>(res).error).toBe('failed_tasks_observability_disabled');  });

  it('reports UNKNOWN (available:false, never 0) when state.db does not exist yet', async () => {
    const res = createMockResponse();
    await handlePipelineHealthRoute(createMockRequest('GET', '/api/pipeline-health'), res, { workspaceDir });
    expect(res.statusCode).toBe(200);

    const data = body<{
      metrics: {
        queue: { painQueueDepth: number };
        reliability: { leaseRenewalFailureCount: { available: boolean; value: number | null; reason?: string } };
        tokens: { tokensPerPain: { available: boolean } };
      };
      nextAction: string;
    }>(res);

    expect(data.metrics.queue.painQueueDepth).toBe(0);
    expect(data.metrics.reliability.leaseRenewalFailureCount.available).toBe(false);
    expect(data.metrics.reliability.leaseRenewalFailureCount.value).toBeNull();
    expect(typeof data.metrics.reliability.leaseRenewalFailureCount.reason).toBe('string');
    expect(data.metrics.tokens.tokensPerPain.available).toBe(false);
    expect(data.nextAction).toContain('UNKNOWN');
  });

  it('derives real queue metrics from a real state.db', async () => {
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      await manager.createTask({ taskId: 'parent-1', taskKind: 'diagnostician', status: 'pending', attemptCount: 0, maxAttempts: 3 });
      await manager.createTask({ taskId: 'parent-2', taskKind: 'diagnostician', status: 'retry_wait', attemptCount: 1, maxAttempts: 3 });
      await manager.createTask({ taskId: 'dreamer-1', taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    } finally {
      await manager.close();
    }

    const res = createMockResponse();
    await handlePipelineHealthRoute(createMockRequest('GET', '/api/pipeline-health?window=6'), res, { workspaceDir });
    expect(res.statusCode).toBe(200);

    const data = body<{
      windowHours: number;
      metrics: {
        queue: { painQueueDepth: number; readyQueueDepth: number; retryQueueDepth: number; oldestPendingAgeMs: number | null };
        stages: { a: { sampleCount: number } };
        lineage: { available: boolean };
      };
    }>(res);

    expect(data.windowHours).toBe(6);
    expect(data.metrics.queue.painQueueDepth).toBe(2);
    expect(data.metrics.queue.retryQueueDepth).toBe(0); // retry_wait parents are reported as pain queue, not runner queue
    expect(data.metrics.queue.readyQueueDepth).toBe(1);
    expect(data.metrics.queue.oldestPendingAgeMs).not.toBeNull();
    expect(data.metrics.stages.a.sampleCount).toBe(0);
    expect(data.metrics.lineage.available).toBe(false);
  });

  it('fails loud instead of reporting an empty health page when state.db is unreadable', async () => {
    const dbPath = resolveStateDbPath(workspaceDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a sqlite database');

    const res = createMockResponse();
    await handlePipelineHealthRoute(createMockRequest('GET', '/api/pipeline-health'), res, { workspaceDir });

    expect(res.statusCode).toBe(500);
    expect(rawBody<{ error: string }>(res).error).toBe('pipeline_health_read_error');
  });
});
