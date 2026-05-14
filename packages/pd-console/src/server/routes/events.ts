import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'path';
import { EventLogReadModel } from '../models/EventLogReadModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const MAX_PAGE_SIZE = 1000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedModel {
  model: EventLogReadModel;
  cachedAt: number;
}

const models = new Map<string, CachedModel>();

function getModel(workspaceDir: string): EventLogReadModel {
  const stateDir = path.join(workspaceDir, '.state');
  const cached = models.get(stateDir);
  if (cached && Date.now() - cached.cachedAt < MODEL_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new EventLogReadModel(stateDir);
  models.set(stateDir, { model, cachedAt: Date.now() });
  return model;
}

interface EventsRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceDir: string;
  subPath: string;
}

export async function handleEventsRoute(ctx: EventsRouteContext): Promise<void> {
  const { req, res, workspaceDir, subPath } = ctx;
  const model = getModel(workspaceDir);
  const parsedUrl = new URL(req.url || '', 'http://localhost');
  const { searchParams } = parsedUrl;

  // GET /api/events
  if (subPath === '' || subPath === '/') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
      return;
    }

    const types = searchParams.getAll('type');
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    const searchQuery = searchParams.get('q') || undefined;
    const pageStr = searchParams.get('page');
    const pageSizeStr = searchParams.get('pageSize');
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    const pageSize = pageSizeStr ? Math.min(parseInt(pageSizeStr, 10), MAX_PAGE_SIZE) : 50;

    try {
      const result = await model.getEventsPaginated({
        types: types.length > 0 ? types : undefined,
        startDate,
        endDate,
        searchQuery,
        page,
        pageSize,
      });
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, 500, 'server_error', (err as Error).message);
    }
    return;
  }

  // GET /api/events/grouped
  if (subPath === '/grouped') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
      return;
    }

    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    try {
      const counts = await model.countEventsGroupedByType({ startDate, endDate });
      sendSuccess(res, counts);
    } catch (err) {
      sendError(res, 500, 'server_error', (err as Error).message);
    }
    return;
  }

  // GET /api/events/:id/related
  if (subPath.startsWith('/') && subPath.endsWith('/related')) {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
      return;
    }

    const match = /\/([^/]+)\/related$/.exec(subPath);
    if (!match) {
      sendNotFound(res, 'Invalid event ID');
      return;
    }
    const [, eventId] = match;
    const maxDistanceStr = searchParams.get('maxDistance');
    const maxDistance = maxDistanceStr ? parseInt(maxDistanceStr, 10) : 10;

    try {
      const relatedEvents = await model.getRelatedEvents(eventId, maxDistance);
      sendSuccess(res, { events: relatedEvents });
    } catch (err) {
      sendError(res, 500, 'server_error', (err as Error).message);
    }
    return;
  }

  sendNotFound(res, 'Route not found');
}

export function disposeEventsModels(): void {
  for (const [, cached] of models) {
    cached.model.dispose();
  }
  models.clear();
}
