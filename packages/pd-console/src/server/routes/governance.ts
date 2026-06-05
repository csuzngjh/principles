import type { IncomingMessage, ServerResponse } from 'node:http';
import { GovernanceConsoleModel } from '../models/GovernanceConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, GovernanceConsoleModel>();

function getModel(workspaceDir: string): GovernanceConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new GovernanceConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export async function handleGovernanceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, 'Route /api/v1/governance/queue not found');
    return;
  }

  const model = getModel(workspaceDir);
  try {
    const result = await model.getGovernanceQueue();
    sendSuccess(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'governance_queue_error', message);
  }
}

export function disposeGovernanceModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
