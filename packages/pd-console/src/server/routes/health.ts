import type { IncomingMessage, ServerResponse } from 'node:http';
import { HealthCheckModel } from '../models/HealthCheckModel.js';
import { sendSuccess, sendError } from '../utils/response.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedModel {
  model: HealthCheckModel;
  cachedAt: number;
}

const models = new Map<string, CachedModel>();

function getModel(workspaceDir: string): HealthCheckModel {
  const cached = models.get(workspaceDir);
  if (cached && Date.now() - cached.cachedAt < MODEL_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new HealthCheckModel(workspaceDir);
  models.set(workspaceDir, { model, cachedAt: Date.now() });
  return model;
}

export async function handleHealthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  options: { workspaceDir: string; authenticationMode: 'authenticated' | 'no_auth' },
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
    return;
  }

  const model = getModel(options.workspaceDir);

  try {
    const health = await model.checkSystemHealth();
    sendSuccess(res, { ...health, authenticationMode: options.authenticationMode });
  } catch (err) {
    sendError(res, 500, 'health_check_error', (err as Error).message);
  }
}

export function disposeHealthModels(): void {
  for (const [, cached] of models) {
    cached.model.dispose();
  }
  models.clear();
}
