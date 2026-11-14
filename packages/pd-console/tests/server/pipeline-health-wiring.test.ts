/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3.4 — route registration.
 *
 * The pipeline-health handler is only useful if the console server actually
 * mounts it. The route-specific behaviour is covered in
 * `routes/pipeline-health.test.ts`; here we prove the wiring in `handleRequest`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRequest } from '../../src/server/index.js';
import { disposePipelineHealthModels } from '../../src/server/routes/pipeline-health.js';

type Services = Parameters<typeof handleRequest>[0];

function createMockResponse(onEnd: (body: string) => void): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    writeHead: (statusCode: number) => {
      (res as unknown as { statusCode: number }).statusCode = statusCode;
      return res;
    },
    end: (data?: string) => {
      onEnd(data ?? '');
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

describe('console server /api/pipeline-health wiring', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    disposePipelineHealthModels();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('mounts the pipeline-health route before the failed-tasks mount', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-wiring-'));
    const workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    const handler = handleRequest({ workspaceDir } as unknown as Services);
    const body = await new Promise<string>((resolve) => {
      const res = createMockResponse(resolve);
      handler(
        { method: 'GET', url: '/api/pipeline-health', headers: { host: 'localhost' } } as IncomingMessage,
        res,
      );
    });

    const payload = JSON.parse(body) as { success: boolean; data?: { metrics?: unknown } };
    expect(payload.success).toBe(true);
    expect(payload.data?.metrics).toBeDefined();
  });
});
