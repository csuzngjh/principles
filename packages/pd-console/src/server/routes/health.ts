import type { IncomingMessage, ServerResponse } from 'node:http';
import { HealthCheckModel } from '../models/HealthCheckModel.js';
import { sendSuccess, sendError } from '../utils/response.js';

const models = new Map<string, HealthCheckModel>();

function getModel(workspaceDir: string): HealthCheckModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new HealthCheckModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export async function handleHealthRoute(
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
    const health = await model.checkSystemHealth();
    sendSuccess(res, health);
  } catch (err) {
    sendError(res, 500, 'health_check_error', (err as Error).message);
  }
}

export function disposeHealthModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
