import type { IncomingMessage, ServerResponse } from 'node:http';
import { ThinkingModelsConsoleModel } from '../models/ThinkingModelsConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, ThinkingModelsConsoleModel>();

function getModel(workspaceDir: string): ThinkingModelsConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new ThinkingModelsConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleThinkingModelsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/thinking-models${subPath} not found`);
    return;
  }

  const model = getModel(workspaceDir);

  // GET /api/thinking-models
  if (subPath === '' || subPath === '/') {
    try {
      const result = model.getOverview();
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'thinking_models_error', (err as Error).message);
    }
    return;
  }

  // GET /api/thinking-models/:id
  const detailMatch = /^\/([^/]+)$/.exec(subPath);
  if (detailMatch) {
    const modelId = decodeURIComponent(detailMatch[1]);
    try {
      const detail = model.getModelDetail(modelId);
      if (!detail) {
        sendNotFound(res, `Thinking model ${modelId} not found`);
        return;
      }
      sendSuccess(res, detail);
    } catch (err: unknown) {
      sendError(res, 500, 'thinking_model_detail_error', (err as Error).message);
    }
    return;
  }

  sendNotFound(res, `Route /api/thinking-models${subPath} not found`);
}

export function disposeThinkingModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
