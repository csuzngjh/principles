import type { IncomingMessage, ServerResponse } from 'node:http';
import { EvolutionConsoleModel } from '../models/EvolutionConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';
import { parseQuery, safeParseInt } from '../utils/request.js';

const models = new Map<string, EvolutionConsoleModel>();

function getModel(workspaceDir: string): EvolutionConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new EvolutionConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/* eslint-disable @typescript-eslint/max-params */
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

  if (subPath === '/stats' || subPath === '/stats/') {
    try {
      const result = await model.getStats();
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'evolution_stats_error', (err as Error).message);
    }
    return;
  }

  if (subPath === '/tasks' || subPath === '/tasks/') {
    try {
      const query = parseQuery(req.url ?? '');
      const result = await model.getTasks({
        status: query.status,
        taskKind: query.taskKind,
        page: safeParseInt(query.page, 1, 1, 10000),
        pageSize: safeParseInt(query.pageSize, 20, 1, 100),
      });
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'evolution_tasks_error', (err as Error).message);
    }
    return;
  }

  if (subPath === '/principles' || subPath === '/principles/') {
    try {
      const result = await model.getPrinciples();
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'evolution_principles_error', (err as Error).message);
    }
    return;
  }

  if (subPath === '/queue' || subPath === '/queue/') {
    try {
      const result = await model.getQueueHealth();
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'evolution_queue_error', (err as Error).message);
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
