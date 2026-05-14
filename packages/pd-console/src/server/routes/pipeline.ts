import type { IncomingMessage, ServerResponse } from 'node:http';
import { PipelineStatsModel } from '../models/PipelineStatsModel.js';
import { sendSuccess, sendError } from '../utils/response.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedModel {
  model: PipelineStatsModel;
  cachedAt: number;
}

const models = new Map<string, CachedModel>();

function getModel(workspaceDir: string): PipelineStatsModel {
  const cached = models.get(workspaceDir);
  if (cached && Date.now() - cached.cachedAt < MODEL_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new PipelineStatsModel(workspaceDir);
  models.set(workspaceDir, { model, cachedAt: Date.now() });
  return model;
}

export async function handlePipelineRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
    return;
  }

  const model = getModel(workspaceDir);

  try {
    const stats = await model.getPipelineStats();
    sendSuccess(res, stats);
  } catch (err) {
    sendError(res, 500, 'pipeline_stats_error', (err as Error).message);
  }
}

export function disposePipelineModels(): void {
  for (const [, cached] of models) {
    cached.model.dispose();
  }
  models.clear();
}
