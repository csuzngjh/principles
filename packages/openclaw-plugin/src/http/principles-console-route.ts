import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi, OpenClawPluginHttpRouteParams } from '../openclaw-sdk.js';
import { ControlUiQueryService } from '../service/control-ui-query-service.js';
import { getEvolutionQueryService } from '../service/evolution-query-service.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { getCentralDatabase } from '../service/central-database.js';

const ROUTE_PREFIX = '/plugins/principles';
const API_PREFIX = `${ROUTE_PREFIX}/api`;
const ASSETS_PREFIX = `${ROUTE_PREFIX}/assets`;

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function text(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
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

function safeStaticPath(rootDir: string, requestPath: string): string | null {
  const relative = requestPath.startsWith(ASSETS_PREFIX)
    ? requestPath.slice(ASSETS_PREFIX.length).replace(/^\/+/, '')
    : '';
  const normalized = path.normalize(relative);
  const webRoot = path.join(rootDir, 'dist', 'web');
  const assetsRoot = path.join(webRoot, 'assets');
  const target = path.join(assetsRoot, normalized);
  const relativeTarget = path.relative(assetsRoot, target);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    return null;
  }
  return target;
}

function serveFile(res: ServerResponse, filePath: string): boolean {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypeFor(filePath));
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.statusCode = 500;
    res.end('Internal Server Error');
  });
  stream.pipe(res);
  return true;
}

function createService(api: OpenClawPluginApi): ControlUiQueryService {
  const workspaceDir = api.resolvePath('.');
  return new ControlUiQueryService(workspaceDir);
}

function handleApiRoute(
  api: OpenClawPluginApi,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> | boolean {
  // Check authentication for API routes
  if (!validateGatewayAuth(req)) {
    json(res, 401, { error: 'unauthorized', message: 'Valid Gateway token required.' });
    return true;
  }

  const service = createService(api);
  const url = new URL(req.url || pathname, 'http://127.0.0.1');
  const method = (req.method || 'GET').toUpperCase();

  const done = (fn: () => unknown): boolean => {
    try {
      const payload = fn();
      json(res, 200, payload);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] API request failed for ${pathname}: ${String(error)}`);
      json(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  };

  if (pathname === `${API_PREFIX}/overview` && method === 'GET') {
    const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 30;
    return done(() => service.getOverview(days));
  }

  if (pathname === `${API_PREFIX}/central/overview` && method === 'GET') {
    const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 30;
    return done(() => {
      const centralDb = getCentralDatabase();
      const stats = centralDb.getOverviewStats();
      const trend = centralDb.getDailyTrend(days);
      const regressions = centralDb.getTopRegressions(5);
      const thinkingStats = centralDb.getThinkingModelStats();
      const workspaces = centralDb.getWorkspaces();
      
      return {
        workspaceDir: 'central',
        generatedAt: new Date().toISOString(),
        dataFreshness: workspaces.length > 0 ? (workspaces[0].lastSync ?? null) : null,
        dataSource: 'central_aggregated_db',
        runtimeControlPlaneSource: 'all_workspaces',
        summary: {
          repeatErrorRate: stats.totalToolCalls > 0 
            ? stats.totalFailures / stats.totalToolCalls 
            : 0,
          userCorrectionRate: stats.totalToolCalls > 0 
            ? stats.totalCorrections / stats.totalToolCalls 
            : 0,
          pendingSamples: stats.pendingSamples,
          approvedSamples: stats.approvedSamples,
          thinkingCoverageRate: stats.totalToolCalls > 0 
            ? stats.totalThinkingEvents / stats.totalToolCalls 
            : 0,
          painEvents: stats.totalPainEvents,
          principleEventCount: 0,
          gateBlocks: 0,
          taskOutcomes: 0,
        },
        dailyTrend: trend,
        topRegressions: regressions,
        sampleQueue: {
          counters: {
            pending: stats.pendingSamples,
            approved: stats.approvedSamples,
            rejected: stats.rejectedSamples,
          },
          preview: [],
        },
        thinkingSummary: {
          activeModels: thinkingStats.activeModels,
          dormantModels: thinkingStats.totalModels - thinkingStats.activeModels,
          effectiveModels: thinkingStats.models.filter(m => m.coverageRate > 0.1).length,
          coverageRate: stats.totalToolCalls > 0 
            ? stats.totalThinkingEvents / stats.totalToolCalls 
            : 0,
        },
        centralInfo: {
          workspaceCount: stats.workspaceCount,
          enabledWorkspaceCount: stats.enabledWorkspaceCount,
          workspaces: stats.workspaceNames,
          enabledWorkspaces: stats.enabledWorkspaceNames,
        },
      };
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

  const workspaceConfigMatch = pathname.match(/^\/plugins\/principles\/api\/central\/workspaces\/([^/]+)$/);
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
        const body = await readJsonBody(req) as Record<string, unknown>;
        const centralDb = getCentralDatabase();
        const workspaceName = decodeURIComponent(workspaceConfigMatch[1]);
        centralDb.updateWorkspaceConfig(workspaceName, {
          enabled: body.enabled as boolean | undefined,
          displayName: body.displayName as string | null | undefined,
          syncEnabled: body.syncEnabled as boolean | undefined,
        });
        const configs = centralDb.getWorkspaceConfigs();
        json(res, 200, configs.find(c => c.workspaceName === workspaceName));
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_json') {
          json(res, 400, { error: 'bad_request', message: 'Request body must be valid JSON.' });
          return true;
        }
        api.logger.warn(`[PD:ControlUI] Workspace config update failed: ${String(error)}`);
        json(res, 500, { error: 'internal_error', message: String(error) });
        return true;
      }
    })();
  }

  if (pathname === `${API_PREFIX}/central/workspaces` && method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        const workspacePath = typeof body.path === 'string' ? body.path : '';
        if (!name || !workspacePath) {
          json(res, 400, { error: 'bad_request', message: 'name and path are required.' });
          return true;
        }
        const centralDb = getCentralDatabase();
        centralDb.addCustomWorkspace(name, workspacePath);
        json(res, 201, { success: true, workspace: name });
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_json') {
          json(res, 400, { error: 'bad_request', message: 'Request body must be valid JSON.' });
          return true;
        }
        api.logger.warn(`[PD:ControlUI] Add workspace failed: ${String(error)}`);
        json(res, 500, { error: 'internal_error', message: String(error) });
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

  const sampleDetailMatch = pathname.match(/^\/plugins\/principles\/api\/samples\/([^/]+)$/);
  if (sampleDetailMatch && method === 'GET') {
    try {
      const detail = service.getSampleDetail(decodeURIComponent(sampleDetailMatch[1]));
      if (!detail) {
        json(res, 404, { error: 'not_found', message: 'Sample not found.' });
        return true;
      }
      json(res, 200, detail);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] API request failed for ${pathname}: ${String(error)}`);
      json(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  }

  const sampleReviewMatch = pathname.match(/^\/plugins\/principles\/api\/samples\/([^/]+)\/review$/);
  if (sampleReviewMatch && method === 'POST') {
    return (async () => {
      try {
        const body = await readJsonBody(req);
        const decision = body.decision === 'approved' || body.decision === 'rejected'
          ? body.decision
          : null;
        if (!decision) {
          json(res, 400, { error: 'bad_request', message: 'decision must be approved or rejected' });
          return true;
        }
        const record = service.reviewSample(
          decodeURIComponent(sampleReviewMatch[1]),
          decision,
          typeof body.note === 'string' ? body.note : undefined,
        );
        json(res, 200, record);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_json') {
          json(res, 400, { error: 'bad_request', message: 'Request body must be valid JSON.' });
          return true;
        }
        api.logger.warn(`[PD:ControlUI] Review request failed for ${pathname}: ${String(error)}`);
        json(res, 500, { error: 'internal_error', message: String(error) });
        return true;
      } finally {
        service.dispose();
      }
    })();
  }

  if (pathname === `${API_PREFIX}/thinking` && method === 'GET') {
    return done(() => service.getThinkingOverview());
  }

  const thinkingDetailMatch = pathname.match(/^\/plugins\/principles\/api\/thinking\/models\/([^/]+)$/);
  if (thinkingDetailMatch && method === 'GET') {
    try {
      const detail = service.getThinkingModelDetail(decodeURIComponent(thinkingDetailMatch[1]));
      if (!detail) {
        json(res, 404, { error: 'not_found', message: 'Thinking model not found.' });
        return true;
      }
      json(res, 200, detail);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] API request failed for ${pathname}: ${String(error)}`);
      json(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  }

  // === Evolution API ===
  const evolutionService = () => {
    const workspaceDir = api.resolvePath('.');
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
    const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 30;
    return done(() => {
      const evoService = evolutionService();
      return evoService.getStats(days);
    });
  }

  const evolutionTraceMatch = pathname.match(/^\/plugins\/principles\/api\/evolution\/trace\/([^/]+)$/);
  if (evolutionTraceMatch && method === 'GET') {
    const evoService = evolutionService();
    try {
      const trace = evoService.getTrace(decodeURIComponent(evolutionTraceMatch[1]));
      if (!trace) {
        json(res, 404, { error: 'not_found', message: 'Evolution trace not found.' });
        return true;
      }
      json(res, 200, trace);
      return true;
    } catch (error) {
      api.logger.warn(`[PD:ControlUI] Evolution trace request failed for ${pathname}: ${String(error)}`);
      json(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      evoService.dispose();
    }
  }

  if (pathname === `${API_PREFIX}/export/corrections` && method === 'GET') {
    try {
      const mode = url.searchParams.get('mode') === 'redacted' ? 'redacted' : 'raw';
      const result = service.exportCorrections(mode);
      if (!fs.existsSync(result.filePath)) {
        json(res, 404, { error: 'not_found', message: 'Export file not found.' });
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
      json(res, 500, { error: 'internal_error', message: String(error) });
      return true;
    } finally {
      service.dispose();
    }
  }

  service.dispose();
  json(res, 404, { error: 'not_found', message: 'Unknown Principles Console API route.' });
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
    // No token configured, allow all requests
    return true;
  }
  const authHeader = (req.headers?.['authorization'] as string) || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = tokenMatch?.[1];
  return providedToken === gatewayToken;
}

/**
 * Create routes for Principles Console.
 * Returns an array of routes:
 * 1. Static files route (no auth required for HTML/CSS/JS)
 * 2. API route (gateway auth required)
 */
export function createPrinciplesConsoleRoutes(api: OpenClawPluginApi): OpenClawPluginHttpRouteParams[] {
  // Route 1: Static files (HTML, CSS, JS) - no auth check
  const staticRoute: OpenClawPluginHttpRouteParams = {
    path: ROUTE_PREFIX,
    auth: 'plugin',
    match: 'prefix',
    async handler(req, res) {
      const url = new URL(req.url || ROUTE_PREFIX, 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      // Skip API routes - they'll be handled by the API route
      if (pathname.startsWith(API_PREFIX)) {
        return false; // Let the API route handle this
      }

      // Serve assets
      if (pathname.startsWith(ASSETS_PREFIX)) {
        if (method !== 'GET' && method !== 'HEAD') {
          text(res, 405, 'Method Not Allowed');
          return true;
        }
        const assetPath = safeStaticPath(api.rootDir, pathname);
        if (!assetPath || !serveFile(res, assetPath)) {
          text(res, 404, 'Asset Not Found');
        }
        return true;
      }

      // Serve index.html for the main route
      if (method !== 'GET' && method !== 'HEAD') {
        text(res, 405, 'Method Not Allowed');
        return true;
      }

      const indexPath = path.join(api.rootDir, 'dist', 'web', 'index.html');
      if (!serveFile(res, indexPath)) {
        text(res, 503, 'Principles Console UI is not built yet.');
      }
      return true;
    },
  };

  // Route 2: API endpoints - gateway auth required
  const apiRoute: OpenClawPluginHttpRouteParams = {
    path: API_PREFIX,
    auth: 'gateway',
    match: 'prefix',
    async handler(req, res) {
      const url = new URL(req.url || API_PREFIX, 'http://127.0.0.1');
      const pathname = url.pathname;
      return handleApiRoute(api, pathname, req, res);
    },
  };

  return [staticRoute, apiRoute];
}

// Legacy export for backwards compatibility
export function createPrinciplesConsoleRoute(api: OpenClawPluginApi): OpenClawPluginHttpRouteParams {
  const routes = createPrinciplesConsoleRoutes(api);
  // Return the combined behavior - this will be called from index.ts
  return {
    path: ROUTE_PREFIX,
    auth: 'plugin',
    match: 'prefix',
    async handler(req, res) {
      const url = new URL(req.url || ROUTE_PREFIX, 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (!pathname.startsWith(ROUTE_PREFIX)) {
        return false;
      }

      // For API routes, check auth manually
      if (pathname.startsWith(API_PREFIX)) {
        if (!validateGatewayAuth(req)) {
          json(res, 401, { error: 'unauthorized', message: 'Valid Gateway token required.' });
          return true;
        }
        return handleApiRoute(api, pathname, req, res);
      }

      // Static files - no auth required
      if (pathname.startsWith(ASSETS_PREFIX)) {
        if (method !== 'GET' && method !== 'HEAD') {
          text(res, 405, 'Method Not Allowed');
          return true;
        }
        const assetPath = safeStaticPath(api.rootDir, pathname);
        if (!assetPath || !serveFile(res, assetPath)) {
          text(res, 404, 'Asset Not Found');
        }
        return true;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        text(res, 405, 'Method Not Allowed');
        return true;
      }

      const indexPath = path.join(api.rootDir, 'dist', 'web', 'index.html');
      if (!serveFile(res, indexPath)) {
        text(res, 503, 'Principles Console UI is not built yet.');
      }
      return true;
    },
  };
}
