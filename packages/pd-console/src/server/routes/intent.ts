import type { IncomingMessage, ServerResponse } from 'node:http';
import { IntentPageModel } from '../models/IntentPageModel.js';
import { sendSuccess, sendError } from '../utils/response.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';

const MODEL_CACHE_TTL_MS = 30 * 1000;

interface CachedModel {
  model: IntentPageModel;
  cachedAt: number;
}

const models = new Map<string, CachedModel>();

function getModel(workspaceDir: string): IntentPageModel {
  const cached = models.get(workspaceDir);
  if (cached && Date.now() - cached.cachedAt < MODEL_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new IntentPageModel(workspaceDir);
  models.set(workspaceDir, { model, cachedAt: Date.now() });
  return model;
}

export async function handleIntentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
    return;
  }

  try {
    const configResult = loadPdConfig(workspaceDir);
    const flagsResult = computeFlagsFromLoadResult(configResult);
    const flagEnabled = flagsResult.flags.intent_engineering?.enabled === true;

    const model = getModel(workspaceDir);
    const summary = await model.getSummary(flagEnabled);
    sendSuccess(res, summary);
  } catch (err) {
    sendError(res, 500, 'intent_route_error', err instanceof Error ? err.message : 'Unknown error');
  }
}

export function disposeIntentModels(): void {
  // IntentPageModel holds no persistent resources; just clear the cache.
  models.clear();
}