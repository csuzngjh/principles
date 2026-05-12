import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import {
  RuntimeStateManager,
  PainChainReadModel,
  PruningReadModel,
  OperatorHealthReadModel,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';
import { AuthConfig } from '../../src/server/config/AuthConfig.js';
import { WorkspaceConfigStore } from '../../src/server/config/WorkspaceConfigStore.js';
import { WorkspaceService } from '../../src/server/models/WorkspaceService.js';
import { handleOverviewRoute, disposeOverviewModels } from '../../src/server/routes/overview.js';
import { handleGatesRoute, disposeGateModels } from '../../src/server/routes/gates.js';
import { handleFeedbackRoute, disposeFeedbackModels } from '../../src/server/routes/feedback.js';
import { handleSamplesRoute, disposeSampleModels } from '../../src/server/routes/samples.js';
import { handleEvolutionRoute, disposeEvolutionModels } from '../../src/server/routes/evolution.js';
import { handleThinkingModelsRoute, disposeThinkingModels } from '../../src/server/routes/thinking-models.js';
import { createWorkspacesRoutes } from '../../src/server/routes/workspaces.js';
import { createCentralRoutes } from '../../src/server/routes/central.js';
import { sendJson, sendSuccess, sendNotFound } from '../../src/server/utils/response.js';
import { createTestWorkspace, cleanupTestWorkspace, sampleThinkingOsMd, sampleTrainingState } from '../test-utils.js';
import type { TestWorkspace } from '../test-utils.js';

let server: http.Server;
let baseUrl: string;
let ws: TestWorkspace;

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

describe('API Integration Tests - Full HTTP Server', () => {
  beforeAll(async () => {
    ws = await createTestWorkspace({
      tasks: [
        { taskId: 't-1', taskKind: 'diagnostician', status: 'succeeded' },
        { taskId: 't-2', taskKind: 'dreamer', status: 'pending' },
        { taskId: 't-3', taskKind: 'diagnostician', status: 'failed' },
      ],
      candidates: [
        { candidateId: 'c-1', taskId: 't-1', title: 'Test candidate 1', description: 'First test candidate', status: 'pending' },
        { candidateId: 'c-2', taskId: 't-1', title: 'Test candidate 2', description: 'Already consumed', status: 'consumed' },
      ],
      principles: [
        { id: 'p-1', status: 'active', text: 'Active principle', triggerPattern: 'on-error', action: 'fix' },
        { id: 'p-2', status: 'candidate', text: 'Candidate principle', triggerPattern: 'on-ambiguity', action: 'ask' },
      ],
      thinkingOs: sampleThinkingOsMd(),
      trainingState: sampleTrainingState(),
    });

    const authConfig = new AuthConfig({ noAuth: true });
    const configStore = new WorkspaceConfigStore();
    const workspaceService = new WorkspaceService(configStore);
    const { handleWorkspacesRoute } = createWorkspacesRoutes(configStore);
    const { handleCentralRoute } = createCentralRoutes(workspaceService);

    function asyncHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
      return (req: http.IncomingMessage, res: http.ServerResponse) => {
        fn(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
          }
        });
      };
    }

    server = http.createServer((req, res) => {
      const urlPath = req.url?.split('?')[0] ?? '/';

      if (!urlPath.startsWith('/api/')) {
        sendNotFound(res, 'Not found');
        return;
      }

      if (urlPath === '/api/health') {
        sendSuccess(res, { status: 'ok', timestamp: new Date().toISOString() });
        return;
      }

      if (urlPath === '/api/overview' || urlPath.startsWith('/api/overview/')) {
        asyncHandler(() => handleOverviewRoute(req, res, ws.workspaceDir, urlPath.slice('/api/overview'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/gate' || urlPath.startsWith('/api/gate/')) {
        asyncHandler(() => handleGatesRoute(req, res, ws.workspaceDir, urlPath.slice('/api/gate'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/feedback' || urlPath.startsWith('/api/feedback/')) {
        asyncHandler(() => handleFeedbackRoute(req, res, ws.workspaceDir, urlPath.slice('/api/feedback'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/samples' || urlPath.startsWith('/api/samples/')) {
        asyncHandler(() => handleSamplesRoute(req, res, ws.workspaceDir, urlPath.slice('/api/samples'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/evolution' || urlPath.startsWith('/api/evolution/')) {
        asyncHandler(() => handleEvolutionRoute(req, res, ws.workspaceDir, urlPath.slice('/api/evolution'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/thinking-models' || urlPath.startsWith('/api/thinking-models/')) {
        asyncHandler(() => handleThinkingModelsRoute(req, res, ws.workspaceDir, urlPath.slice('/api/thinking-models'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/workspaces' || urlPath.startsWith('/api/workspaces/')) {
        asyncHandler(() => handleWorkspacesRoute(req, res, urlPath.slice('/api/workspaces'.length)))(req, res);
        return;
      }

      if (urlPath === '/api/central' || urlPath.startsWith('/api/central/')) {
        asyncHandler(() => handleCentralRoute(req, res, urlPath.slice('/api/central'.length)))(req, res);
        return;
      }

      sendNotFound(res, `Route ${urlPath} not found`);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }, 30000);

  afterAll(async () => {
    disposeOverviewModels();
    disposeGateModels();
    disposeFeedbackModels();
    disposeSampleModels();
    disposeEvolutionModels();
    disposeThinkingModels();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTestWorkspace(ws);
  });

  describe('GET /api/health', () => {
    it('returns ok status', async () => {
      const { status, body } = await fetchJson('/api/health');
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).success).toBe(true);
    });
  });

  describe('GET /api/overview', () => {
    it('returns overview with real runtime-v2 data', async () => {
      const { status, body } = await fetchJson('/api/overview');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.workspaceDir).toBe(ws.workspaceDir);
      expect(data.health).toBeDefined();
      expect(data.summary).toBeDefined();
    });

    it('health contains GFI and principles data', async () => {
      const { body } = await fetchJson('/api/overview');
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      const health = data.health as Record<string, unknown>;
      expect(health.status).toBeDefined();
      expect(health.gfi).toBeDefined();
      expect(health.principles).toBeDefined();
    });
  });

  describe('GET /api/overview/health', () => {
    it('returns health subset', async () => {
      const { status, body } = await fetchJson('/api/overview/health');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.status).toBeDefined();
      expect(data.gfi).toBeDefined();
    });
  });

  describe('GET /api/samples', () => {
    it('returns samples from real candidate data', async () => {
      const { status, body } = await fetchJson('/api/samples');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.items).toBeDefined();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.pagination).toBeDefined();
      expect(data.counters).toBeDefined();
    });

    it('maps candidate statuses to review statuses', async () => {
      const { body } = await fetchJson('/api/samples');
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      const items = data.items as Array<Record<string, unknown>>;
      const pendingItem = items.find((i) => i.sampleId === 'c-1');
      const consumedItem = items.find((i) => i.sampleId === 'c-2');
      expect(pendingItem?.reviewStatus).toBe('pending');
      expect(consumedItem?.reviewStatus).toBe('approved');
    });

    it('filters by status', async () => {
      const { body } = await fetchJson('/api/samples?status=pending');
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      const items = data.items as Array<Record<string, unknown>>;
      expect(items.length).toBe(1);
      expect(items[0].reviewStatus).toBe('pending');
    });
  });

  describe('GET /api/samples/:id', () => {
    it('returns sample detail', async () => {
      const { status, body } = await fetchJson('/api/samples/c-1');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.sampleId).toBe('c-1');
      expect(data.title).toBe('Test candidate 1');
      expect(data.reviewStatus).toBe('pending');
    });

    it('returns 404 for unknown sample', async () => {
      const { status } = await fetchJson('/api/samples/nonexistent');
      expect(status).toBe(404);
    });
  });

  describe('POST /api/samples/:id/review', () => {
    it('rejects a non-pending sample', async () => {
      const { status } = await fetchJson('/api/samples/c-2/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });
      expect(status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /api/evolution/stats', () => {
    it('returns task stats from RuntimeStateManager', async () => {
      const { status, body } = await fetchJson('/api/evolution/stats');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(typeof data.total).toBe('number');
      expect(typeof data.completed).toBe('number');
      expect(typeof data.pending).toBe('number');
      expect(data.stageDistribution).toBeDefined();
    });
  });

  describe('GET /api/evolution/tasks', () => {
    it('returns tasks list', async () => {
      const { status, body } = await fetchJson('/api/evolution/tasks');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.pagination).toBeDefined();
    });
  });

  describe('GET /api/evolution/principles', () => {
    it('returns principle lifecycle data', async () => {
      const { status, body } = await fetchJson('/api/evolution/principles');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.summary).toBeDefined();
      expect(typeof (data.summary as Record<string, unknown>).total).toBe('number');
    });
  });

  describe('GET /api/evolution/queue', () => {
    it('returns queue health data', async () => {
      const { status, body } = await fetchJson('/api/evolution/queue');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(typeof data.pendingCount).toBe('number');
    });
  });

  describe('GET /api/thinking-models', () => {
    it('returns parsed thinking models', async () => {
      const { status, body } = await fetchJson('/api/thinking-models');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.totalModels).toBe(2);
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.source).toBe('workspace');
    });

    it('models have correct structure', async () => {
      const { body } = await fetchJson('/api/thinking-models');
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      const models = data.models as Array<Record<string, unknown>>;
      const first = models[0];
      expect(first.id).toBeDefined();
      expect(first.name).toBeDefined();
      expect(first.trigger).toBeDefined();
      expect(first.must).toBeDefined();
      expect(first.forbidden).toBeDefined();
    });
  });

  describe('GET /api/thinking-models/:id', () => {
    it('returns specific model detail', async () => {
      const { status, body } = await fetchJson('/api/thinking-models/error-prevention');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.id).toBe('error-prevention');
      expect(data.name).toBe('Error Prevention');
    });

    it('returns 404 for unknown model', async () => {
      const { status } = await fetchJson('/api/thinking-models/nonexistent');
      expect(status).toBe(404);
    });
  });

  describe('GET /api/gate/stats', () => {
    it('returns gate statistics', async () => {
      const { status, body } = await fetchJson('/api/gate/stats');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.trust).toBeDefined();
      expect(data.gfi).toBeDefined();
    });
  });

  describe('GET /api/feedback/gfi', () => {
    it('returns GFI data', async () => {
      const { status, body } = await fetchJson('/api/feedback/gfi');
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.current).toBeDefined();
    });
  });
});
