import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi, OpenClawPluginHttpRouteParams } from '../openclaw-sdk.js';
import { ControlUiQueryService } from '../service/control-ui-query-service.js';
import { getEvolutionQueryService } from '../service/evolution-query-service.js';
import { TrajectoryRegistry } from '../core/trajectory.js';

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
    return done(() => service.getOverview());
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
    return done(() => {
      const evoService = evolutionService();
      return evoService.getStats();
    });
  }

  const evolutionTraceMatch = pathname.match(/^\/plugins\/principles\/api\/evolution\/trace\/([^/]+)$/);
  if (evolutionTraceMatch && method === 'GET') {
    try {
      const evoService = evolutionService();
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

export function createPrinciplesConsoleRoute(api: OpenClawPluginApi): OpenClawPluginHttpRouteParams {
  return {
    path: ROUTE_PREFIX,
    auth: 'gateway',
    match: 'prefix',
    async handler(req, res) {
      const url = new URL(req.url || ROUTE_PREFIX, 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (!pathname.startsWith(ROUTE_PREFIX)) {
        return false;
      }

      if (pathname.startsWith(API_PREFIX)) {
        return handleApiRoute(api, pathname, req, res);
      }

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
