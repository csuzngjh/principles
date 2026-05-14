import type { IncomingMessage, ServerResponse } from 'node:http';
import { PipelineStatsModel } from '../models/PipelineStatsModel.js';
import { sendSuccess, sendError } from '../utils/response.js';

const models = new Map<string, PipelineStatsModel>();

function getModel(workspaceDir: string): PipelineStatsModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new PipelineStatsModel(workspaceDir);
    models.set(workspaceDir, model);
  }
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
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
