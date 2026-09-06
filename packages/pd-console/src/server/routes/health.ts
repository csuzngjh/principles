import type { IncomingMessage, ServerResponse } from 'node:http';
import { HealthCheckModel } from '../models/HealthCheckModel.js';
import { CodexGovernanceHealthModel } from '../models/CodexGovernanceHealthModel.js';
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

// PRI-625 Slice D (SPEC §15): Codex governance health is read-only and cheap;
// cache it with the same TTL discipline as the system health model. Keyed by
// workspace — the route can serve multiple workspaces.
const CODEX_WORKSPACE_CACHE_TTL_MS = MODEL_CACHE_TTL_MS;
const codexModels = new Map<string, { model: CodexGovernanceHealthModel; cachedAt: number }>();
const codexCache = new Map<string, { health: Awaited<ReturnType<CodexGovernanceHealthModel['collect']>>; cachedAt: number }>();

function getCodexModel(workspaceDir: string): CodexGovernanceHealthModel {
  const cached = codexModels.get(workspaceDir);
  if (cached && Date.now() - cached.cachedAt < CODEX_WORKSPACE_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new CodexGovernanceHealthModel(workspaceDir);
  codexModels.set(workspaceDir, { model, cachedAt: Date.now() });
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
    let codexGovernance: Awaited<ReturnType<CodexGovernanceHealthModel['collect']>> | undefined;
    const cachedCodex = codexCache.get(options.workspaceDir);
    if (cachedCodex !== undefined && Date.now() - cachedCodex.cachedAt < CODEX_WORKSPACE_CACHE_TTL_MS) {
      codexGovernance = cachedCodex.health;
    } else {
      try {
        codexGovernance = await getCodexModel(options.workspaceDir).collect();
        codexCache.set(options.workspaceDir, { health: codexGovernance, cachedAt: Date.now() });
      } catch {
        // The §15 block degrades independently of the base system health —
        // the route stays 200 with the block absent rather than failing the
        // whole health surface (rc-9: absence is observable to clients that
        // require it; the CLI health command reports the structured reason).
        codexGovernance = undefined;
      }
    }
    sendSuccess(res, {
      ...health,
      authenticationMode: options.authenticationMode,
      ...(codexGovernance !== undefined ? { codexGovernance } : {}),
    });
  } catch (err) {
    sendError(res, 500, 'health_check_error', (err as Error).message);
  }
}

export function disposeHealthModels(): void {
  for (const [, cached] of models) {
    cached.model.dispose();
  }
  models.clear();
  codexModels.clear();
  codexCache.clear();
}
