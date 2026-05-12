import type { IncomingMessage, ServerResponse } from 'node:http';
import { OverviewConsoleModel } from '../models/OverviewConsoleModel.js';
import { sendSuccess, sendError, sendNotFound, sendMethodNotAllowed } from '../utils/response.js';

const models = new Map<string, OverviewConsoleModel>();

function getModel(workspaceDir: string): OverviewConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new OverviewConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export async function handleOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    try {
      const overview = await model.getOverview();
      sendSuccess(res, overview);
    } catch (err: any) {
      sendError(res, 500, 'overview_error', err.message);
    }
    return;
  }

  if (req.method === 'GET' && subPath === '/health') {
    try {
      const health = await model.getHealth();
      sendSuccess(res, health);
    } catch (err: any) {
      sendError(res, 500, 'health_error', err.message);
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
