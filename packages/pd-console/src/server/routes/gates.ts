import type { IncomingMessage, ServerResponse } from 'node:http';
import { GateConsoleModel } from '../models/GateConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, GateConsoleModel>();

function getModel(workspaceDir: string): GateConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new GateConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export async function handleGatesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method !== 'GET') {
    sendNotFound(res, 'Method not allowed');
    return;
  }

  if (subPath === '/stats' || subPath === '') {
    try {
      const stats = await model.getGateStats([]);
      sendSuccess(res, stats);
    } catch (err: any) {
      sendError(res, 500, 'gate_stats_error', err.message);
    }
    return;
  }

  if (subPath === '/blocks') {
    try {
      const limitParam = new URL(req.url!, `http://localhost`).searchParams.get('limit');
      const parsedLimit = limitParam ? parseInt(limitParam, 10) : 100;
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 100 : Math.min(parsedLimit, 500);
      const blocks = await model.getGateBlocks(limit);
      sendSuccess(res, blocks);
    } catch (err: any) {
      sendError(res, 500, 'gate_blocks_error', err.message);
    }
    return;
  }

  sendNotFound(res, `Route /api/gate${subPath} not found`);
}

export function disposeGateModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
