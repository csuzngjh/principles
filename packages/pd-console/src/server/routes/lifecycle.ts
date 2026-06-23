import type { IncomingMessage, ServerResponse } from 'node:http';
import { LifecycleConsoleModel } from '../models/LifecycleConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, LifecycleConsoleModel>();

function getModel(workspaceDir: string): LifecycleConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new LifecycleConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleLifecycleRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/v1/lifecycle${subPath} not found`);
    return;
  }

  // GET /api/v1/lifecycle/principles/:principleId
  const principleMatch = /^[/]principles[/]([^/]+)$/.exec(subPath);
  if (principleMatch) {
    const [, rawId] = principleMatch;
    if (!rawId) {
      sendError(res, 400, 'invalid_encoding', 'Principle ID is missing');
      return;
    }
    let principleId: string;
    try {
      principleId = decodeURIComponent(rawId);
    } catch {
      sendError(res, 400, 'invalid_encoding', 'Principle ID contains invalid percent encoding');
      return;
    }
    const model = getModel(workspaceDir);
    try {
      const result = model.getLifecycleMetrics(principleId);
      if (!result) {
        sendNotFound(res, `Principle "${principleId}" not found in lifecycle read model`);
        return;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'lifecycle_metrics_error', message);
    }
    return;
  }

  sendNotFound(res, `Route /api/v1/lifecycle${subPath} not found`);
}

export function disposeLifecycleModels(): void {
  models.clear();
}
