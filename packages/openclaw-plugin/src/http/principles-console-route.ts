import * as crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi, OpenClawPluginHttpRouteParams } from '../openclaw-sdk.js';
import { ControlUiQueryService } from '../service/control-ui-query-service.js';
import { getEvolutionQueryService } from '../service/evolution-query-service.js';
import { HealthQueryService } from '../service/health-query-service.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { getCentralDatabase } from '../service/central-database.js';
import { CentralOverviewService } from '../service/central-overview-service.js';
import { CentralHealthService } from '../service/central-health-service.js';
import { resolveRequiredWorkspaceDir } from '../core/workspace-dir-service.js';

const ROUTE_PREFIX = '/plugins/principles';
const API_PREFIX = `${ROUTE_PREFIX}/api`;

function sendJson(res: unknown, statusCode: number, payload: unknown): void {
  const r = res as { statusCode?: number; setHeader: (n: string, v: string) => void; end: (b?: string) => void };
  r.statusCode = statusCode;
  r.setHeader('Content-Type', 'application/json; charset=utf-8');
  r.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_json');
  }
}

function createService(api: OpenClawPluginApi): ControlUiQueryService {
  const workspaceDir = resolveRequiredWorkspaceDir(api, { agentId: 'main' }, { source: 'principles_console.control_ui', fallbackAgentId: 'main' });
  return new ControlUiQueryService(workspaceDir);
}

function handleApiRoute(
  api: OpenClawPluginApi,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> | boolean {
  if (!validateGatewayAuth(req)) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Valid Gateway token required.' });
    return true;
  }

  let service: ControlUiQueryService;
  try {
    service = createService(api);
  } catch (error) {
    api.logger.warn(`[PD:ControlUI] Failed to resolve workspace for ${pathname}: ${String(error)}`);
    sendJson(res, 500, { error: 'internal_error', message: String(error) });
    return true;
  }
  const url = new URL(req.url || pathname, 'http://127.0.0.1');
  const method = (req.method || 'GET').toUpperCase();

  const done = (fn: () => unknown): boolean => {
    try {
      const payload = fn();
      sendJson(res, 200, payload);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] API request failed for ${pathname}: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  };

  const parseDays = (param: string | null): number => {
    const value = param ? Number(param) : 30;
    if (!Number.isFinite(value) || value < 1) return 30;
    return Math.min(365, Math.max(1, Math.floor(value)));
  };

  if (pathname === `${API_PREFIX}/overview` && method === 'GET') {
    const days = parseDays(url.searchParams.get('days'));
    return done(() => service.getOverview(days));
  }

  if (pathname === `${API_PREFIX}/central/overview` && method === 'GET') {
    const days = parseDays(url.searchParams.get('days'));
    return done(() => {
      const centralOverviewService = new CentralOverviewService();
      try {
        return centralOverviewService.getOverview(days);
      } finally {
        centralOverviewService.dispose();
      }
    });
  }

  if (pathname === `${API_PREFIX}/central/sync` && method === 'POST') {
    return done(() => {
      const centralDb = getCentralDatabase();
      const results = centralDb.syncEnabled();
      const summary: Record<string, number> = {};
      results.forEach((count, name) => {
        summary[name] = count;
      });
      return { synced: summary, timestamp: new Date().toISOString() };
    });
  }

  if (pathname === `${API_PREFIX}/central/workspaces` && method === 'GET') {
    return done(() => {
      const centralDb = getCentralDatabase();
      const configs = centralDb.getWorkspaceConfigs();
      const workspaces = centralDb.getWorkspaces();
      return {
        configs,
        workspaces: workspaces.map(ws => ({
          name: ws.name,
          path: ws.path,
          lastSync: ws.lastSync,
          config: configs.find(c => c.workspaceName === ws.name) ?? null,
        })),
      };
    });
  }

  if (pathname === `${API_PREFIX}/central/health` && method === 'GET') {
    return done(() => {
      return new CentralHealthService().getAllWorkspaceHealth();
    });
  }

  const workspaceConfigMatch = /^\/plugins\/principles\/api\/central\/workspaces\/([^/]+)$/.exec(pathname);
  if (workspaceConfigMatch && method === 'GET') {
    return done(() => {
      const centralDb = getCentralDatabase();
      const workspaceName = decodeURIComponent(workspaceConfigMatch[1]);
      const configs = centralDb.getWorkspaceConfigs();
      const config = configs.find(c => c.workspaceName === workspaceName);
      return config ?? { workspaceName, enabled: true, displayName: workspaceName, syncEnabled: true };
    });
  }

  if (workspaceConfigMatch && method === 'PATCH') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const centralDb = getCentralDatabase();
        const workspaceName = decodeURIComponent(workspaceConfigMatch[1]);
        centralDb.updateWorkspaceConfig(workspaceName, {
          enabled: body.enabled as boolean | undefined,
          displayName: body.displayName as string | null | undefined,
          syncEnabled: body.syncEnabled as boolean | undefined,
        });
        const configs = centralDb.getWorkspaceConfigs();
        sendJson(res, 200, configs.find(c => c.workspaceName === workspaceName));
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_json') {
          sendJson(res, 400, { error: 'bad_request', message: 'Request body must be valid JSON.' });
          return true;
        }
        api.logger.warn(`[PD:ControlUI] Workspace config update failed: ${String(error)}`);
        sendJson(res, 500, { error: 'internal_error', message: String(error) });
        return true;
      }
    })();
  }

  if (pathname === `${API_PREFIX}/central/workspaces` && method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name : '';
        const workspacePath = typeof body.path === 'string' ? body.path : '';
        if (!name || !workspacePath) {
          sendJson(res, 400, { error: 'bad_request', message: 'name and path are required.' });
          return true;
        }
        const centralDb = getCentralDatabase();
        centralDb.addCustomWorkspace(name, workspacePath);
        sendJson(res, 201, { success: true, workspace: name });
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_json') {
          sendJson(res, 400, { error: 'bad_request', message: 'Request body must be valid JSON.' });
          return true;
        }
        api.logger.warn(`[PD:ControlUI] Add workspace failed: ${String(error)}`);
        sendJson(res, 500, { error: 'internal_error', message: String(error) });
        return true;
      }
    })();
  }

  if (pathname === `${API_PREFIX}/samples` && method === 'GET') {
    return done(() => service.listSamples({
      status: url.searchParams.get('status') ?? undefined,
      qualityMin: url.searchParams.has('qualityMin') ? Number(url.searchParams.get('qualityMin')) : undefined,
      dateFrom: url.searchParams.get('dateFrom') ?? undefined,
      dateTo: url.searchParams.get('dateTo') ?? undefined,
      failureMode: url.searchParams.get('failureMode') ?? undefined,
      page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
      pageSize: url.searchParams.has('pageSize') ? Number(url.searchParams.get('pageSize')) : undefined,
    }));
  }

  const sampleDetailMatch = /^\/plugins\/principles\/api\/samples\/([^/]+)$/.exec(pathname);
  if (sampleDetailMatch && method === 'GET') {
    try {
      const detail = service.getSampleDetail(decodeURIComponent(sampleDetailMatch[1]));
      if (!detail) {
        sendJson(res, 404, { error: 'not_found', message: 'Sample not found.' });
        return true;
      }
      sendJson(res, 200, detail);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] API request failed for ${pathname}: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  }

  const sampleReviewMatch = /^\/plugins\/principles\/api\/samples\/([^/]+)\/review$/.exec(pathname);
  if (sampleReviewMatch && method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const decision = body.decision === 'approved' || body.decision === 'rejected'
          ? body.decision
          : null;
        if (!decision) {
          sendJson(res, 400, { error: 'bad_request', message: 'decision must be approved or rejected' });
          return true;
        }
        const record = service.reviewSample(
          decodeURIComponent(sampleReviewMatch[1]),
          decision,
          typeof body.note === 'string' ? body.note : undefined,
        );
        sendJson(res, 200, record);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_json') {
          sendJson(res, 400, { error: 'bad_request', message: 'Request body must be valid JSON.' });
          return true;
        }
        api.logger.warn(`[PD:ControlUI] Review request failed for ${pathname}: ${String(error)}`);
        sendJson(res, 500, { error: 'internal_error', message: String(error) });
        return true;
      } finally {
        service.dispose();
      }
    })();
  }

  if (pathname === `${API_PREFIX}/thinking` && method === 'GET') {
    return done(() => service.getThinkingOverview());
  }

  const thinkingDetailMatch = /^\/plugins\/principles\/api\/thinking\/models\/([^/]+)$/.exec(pathname);
  if (thinkingDetailMatch && method === 'GET') {
    try {
      const detail = service.getThinkingModelDetail(decodeURIComponent(thinkingDetailMatch[1]));
      if (!detail) {
        sendJson(res, 404, { error: 'not_found', message: 'Thinking model not found.' });
        return true;
      }
      sendJson(res, 200, detail);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] API request failed for ${pathname}: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  }

  const evolutionService = () => {
    const workspaceDir = resolveRequiredWorkspaceDir(api, { agentId: 'main' }, { source: 'principles_console.evolution', fallbackAgentId: 'main' });
    const trajectory = TrajectoryRegistry.get(workspaceDir);
    return getEvolutionQueryService(trajectory);
  };

  if (pathname === `${API_PREFIX}/evolution/tasks` && method === 'GET') {
    return done(() => {
      const evoService = evolutionService();
      return evoService.getTasks({
        status: url.searchParams.get('status') ?? undefined,
        dateFrom: url.searchParams.get('dateFrom') ?? undefined,
        dateTo: url.searchParams.get('dateTo') ?? undefined,
        page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
        pageSize: url.searchParams.has('pageSize') ? Number(url.searchParams.get('pageSize')) : undefined,
      });
    });
  }

  if (pathname === `${API_PREFIX}/evolution/events` && method === 'GET') {
    return done(() => {
      const evoService = evolutionService();
      return evoService.getEvents({
        traceId: url.searchParams.get('traceId') ?? undefined,
        stage: url.searchParams.get('stage') ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined,
      });
    });
  }

  if (pathname === `${API_PREFIX}/evolution/stats` && method === 'GET') {
    const days = parseDays(url.searchParams.get('days'));
    return done(() => {
      const evoService = evolutionService();
      return evoService.getStats(days);
    });
  }

  const evolutionTraceMatch = /^\/plugins\/principles\/api\/evolution\/trace\/([^/]+)$/.exec(pathname);
  if (evolutionTraceMatch && method === 'GET') {
    const evoService = evolutionService();
    try {
      const trace = evoService.getTrace(decodeURIComponent(evolutionTraceMatch[1]));
      if (!trace) {
        sendJson(res, 404, { error: 'not_found', message: 'Evolution trace not found.' });
        return true;
      }
      sendJson(res, 200, trace);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Evolution trace request failed for ${pathname}: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      evoService.dispose();
    }
  }

  const healthService = () => {
    const workspaceDir = resolveRequiredWorkspaceDir(api, { agentId: 'main' }, { source: 'principles_console.health', fallbackAgentId: 'main' });
    return new HealthQueryService(workspaceDir);
  };

  if (pathname === `${API_PREFIX}/overview/health` && method === 'GET') {
    const hs = healthService();
    try {
      sendJson(res, 200, hs.getOverviewHealth());
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Health overview failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/evolution/principles` && method === 'GET') {
    const hs = healthService();
    try {
      sendJson(res, 200, hs.getEvolutionPrinciples());
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Evolution principles failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/feedback/gfi` && method === 'GET') {
    const hs = healthService();
    try {
      sendJson(res, 200, hs.getFeedbackGfi());
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Feedback GFI failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/feedback/empathy-events` && method === 'GET') {
    const hs = healthService();
    try {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
      sendJson(res, 200, hs.getFeedbackEmpathyEvents(limit));
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Feedback empathy events failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/feedback/gate-blocks` && method === 'GET') {
    const hs = healthService();
    try {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
      sendJson(res, 200, hs.getFeedbackGateBlocks(limit));
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Feedback gate blocks failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/gate/stats` && method === 'GET') {
    const hs = healthService();
    try {
      sendJson(res, 200, hs.getGateStats());
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Gate stats failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/gate/blocks` && method === 'GET') {
    const hs = healthService();
    try {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
      sendJson(res, 200, hs.getGateBlocks(limit));
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Gate blocks failed: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      hs.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/export/corrections` && method === 'GET') {
    try {
      const mode = url.searchParams.get('mode') === 'redacted' ? 'redacted' : 'raw';
      const result = service.exportCorrections(mode);
      if (!fs.existsSync(result.filePath)) {
        sendJson(res, 404, { error: 'not_found', message: 'Export file not found.' });
        return true;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(result.filePath)}"`);
      const stream = fs.createReadStream(result.filePath);
      stream.on('error', () => {
        res.statusCode = 500;
        res.end('Internal Server Error');
      });
      stream.pipe(res);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Export request failed for ${pathname}: ${String(error)}`);
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  }

  service.dispose();
  sendJson(res, 404, { error: 'not_found', message: 'Unknown Principles Console API route.' });
  return true;
}

function getGatewayToken(): string | null {
  try {
    const configPath = path.join(process.env.HOME || '', '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.gateway?.auth?.token || null;
  } catch {
    return null;
  }
}

function validateGatewayAuth(req: IncomingMessage): boolean {
  const gatewayToken = getGatewayToken();
  if (!gatewayToken) {
    return true;
  }
  const authHeader = (req.headers?.authorization as string) || '';
  const tokenMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const providedToken = tokenMatch?.[1];

  if (!providedToken) {
    return false;
  }

  const providedBuffer = Buffer.from(providedToken, 'utf8');
  const expectedBuffer = Buffer.from(gatewayToken, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createPrinciplesConsoleRoute(api: OpenClawPluginApi): OpenClawPluginHttpRouteParams {
  return {
    path: API_PREFIX,
    auth: 'gateway',
    match: 'prefix',

    async handler(req: unknown, res: unknown) {
      const httpReq = req as { url?: string; method?: string };
      const url = new URL(httpReq.url || API_PREFIX, 'http://127.0.0.1');
      const { pathname } = url;
      return handleApiRoute(api, pathname, req as IncomingMessage, res as ServerResponse);
    },
  };
}
