import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApprovalsGroupedConsoleModel } from '../models/ApprovalsGroupedConsoleModel.js';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';
import type { PromptInjectionTargetHost } from '@principles/host-runtime';

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

  // PD_PROMPT_CAPACITY_V1 R-A1: request-level target host for the capacity
  // forecast — the request-scoped selection entry when the workspace's
  // applicable hosts would take different routes. No new persisted config.
  const url = new URL(req.url ?? '/api/v1/approvals/grouped', 'http://localhost');
  let targetHost: PromptInjectionTargetHost | undefined;
  const rawHost = url.searchParams.get('host');
  if (rawHost !== null) {
    if (rawHost !== 'openclaw' && rawHost !== 'codex') {
      sendBadRequest(res, 'host must be one of: openclaw, codex');
      return;
    }
    targetHost = rawHost;
  }

  const model = getModel(workspaceDir);
  try {
    const result = await model.getApprovalsGrouped(targetHost);
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
