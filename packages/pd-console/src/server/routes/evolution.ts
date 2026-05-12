import type { IncomingMessage, ServerResponse } from 'node:http';
import { EvolutionConsoleModel } from '../models/EvolutionConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, EvolutionConsoleModel>();

function getModel(workspaceDir: string): EvolutionConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new EvolutionConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function parseQuery(url: string): Record<string, string> {
  const query: Record<string, string> = {};
  const searchIndex = url.indexOf('?');
  if (searchIndex === -1) return query;
  const search = url.slice(searchIndex + 1);
  for (const pair of search.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIndex));
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    query[key] = value;
  }
  return query;
}

export async function handleEvolutionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/evolution${subPath} not found`);
    return;
  }

  const model = getModel(workspaceDir);

  // GET /api/evolution/stats
  if (subPath === '/stats' || subPath === '/stats/') {
    try {
      const result = await model.getStats();
      sendSuccess(res, result);
    } catch (err: any) {
      sendError(res, 500, 'evolution_stats_error', err.message);
    }
    return;
  }

  // GET /api/evolution/tasks
  if (subPath === '/tasks' || subPath === '/tasks/') {
    try {
      const query = parseQuery(req.url ?? '');
      const page = query.page ? Math.max(1, parseInt(query.page, 10) || 1) : undefined;
      const pageSize = query.pageSize ? Math.min(Math.max(1, parseInt(query.pageSize, 10) || 20), 100) : undefined;
      const result = await model.getTasks({
        status: query.status,
        taskKind: query.taskKind,
        page,
        pageSize,
      });
      sendSuccess(res, result);
    } catch (err: any) {
      sendError(res, 500, 'evolution_tasks_error', err.message);
    }
    return;
  }

  // GET /api/evolution/principles
  if (subPath === '/principles' || subPath === '/principles/') {
    try {
      const result = await model.getPrinciples();
      sendSuccess(res, result);
    } catch (err: any) {
      sendError(res, 500, 'evolution_principles_error', err.message);
    }
    return;
  }

  // GET /api/evolution/queue
  if (subPath === '/queue' || subPath === '/queue/') {
    try {
      const result = await model.getQueueHealth();
      sendSuccess(res, result);
    } catch (err: any) {
      sendError(res, 500, 'evolution_queue_error', err.message);
    }
    return;
  }

  sendNotFound(res, `Route /api/evolution${subPath} not found`);
}

export function disposeEvolutionModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
