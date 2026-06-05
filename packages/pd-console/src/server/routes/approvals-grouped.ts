import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApprovalsGroupedConsoleModel } from '../models/ApprovalsGroupedConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, ApprovalsGroupedConsoleModel>();

function getModel(workspaceDir: string): ApprovalsGroupedConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new ApprovalsGroupedConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export async function handleApprovalsGroupedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, 'Route /api/v1/approvals/grouped not found');
    return;
  }

  const model = getModel(workspaceDir);
  try {
    const result = await model.getApprovalsGrouped();
    sendSuccess(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'approvals_grouped_error', message);
  }
}

export function disposeApprovalsGroupedModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
