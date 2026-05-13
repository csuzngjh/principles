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

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleGatesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Method not allowed');
    return;
  }

  if (subPath === '/stats' || subPath === '') {
    try {
      const stats = await model.getGateStats();
      sendSuccess(res, stats);
    } catch (err: unknown) {
      sendError(res, 500, 'gate_stats_error', getErrorMessage(err));
    }
    return;
  }

  if (subPath === '/blocks') {
    try {
      const limitParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit');
      const parsedLimit = limitParam ? parseInt(limitParam, 10) : 100;
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 100 : Math.min(parsedLimit, 500);
      const blocks = await model.getGateBlocks(limit);
      sendSuccess(res, blocks);
    } catch (err: unknown) {
      sendError(res, 500, 'gate_blocks_error', getErrorMessage(err));
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
