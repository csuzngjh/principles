import type { IncomingMessage, ServerResponse } from 'node:http';
import { OverviewConsoleModel } from '../models/OverviewConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, OverviewConsoleModel>();

function getModel(workspaceDir: string): OverviewConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new OverviewConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET is allowed for this route');
    return;
  }

  if (subPath === '' || subPath === '/') {
    try {
      const overview = await model.getOverview();
      sendSuccess(res, overview);
    } catch (err: unknown) {
      sendError(res, 500, 'overview_error', getErrorMessage(err));
    }
    return;
  }

  if (subPath === '/health') {
    try {
      const health = await model.getHealth();
      sendSuccess(res, health);
    } catch (err: unknown) {
      sendError(res, 500, 'health_error', getErrorMessage(err));
    }
    return;
  }

  sendNotFound(res, `Route /api/overview${subPath} not found`);
}

export function disposeOverviewModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
