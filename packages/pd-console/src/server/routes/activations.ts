import type { IncomingMessage, ServerResponse } from 'node:http';
import { ActivationsConsoleModel } from '../models/ActivationsConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, ActivationsConsoleModel>();

function getModel(workspaceDir: string): ActivationsConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new ActivationsConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleActivationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/v1/activations${subPath} not found`);
    return;
  }

  // GET /api/v1/activations
  if (subPath === '' || subPath === '/') {
    const model = getModel(workspaceDir);
    try {
      const result = await model.getActivations();
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'activations_error', message);
    }
    return;
  }

  sendNotFound(res, `Route /api/v1/activations${subPath} not found`);
}

export function disposeActivationsModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
