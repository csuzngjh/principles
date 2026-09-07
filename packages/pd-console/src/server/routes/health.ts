import type { IncomingMessage, ServerResponse } from 'node:http';
import { HealthCheckModel } from '../models/HealthCheckModel.js';
import { CodexGovernanceHealthModel, type CodexGovernanceHealth, type CodexGovernanceHealthResult } from '../models/CodexGovernanceHealthModel.js';
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

// PRI-625 Slice D (SPEC §15): Codex governance health comes from the ONE
// authority — `pd health --host codex --json` — executed by the Console
// model as a subprocess. Cached per workspace with the same TTL discipline
// as the system health model. Keyed by workspace: the route can serve
// multiple workspaces.
const CODEX_WORKSPACE_CACHE_TTL_MS = MODEL_CACHE_TTL_MS;
const codexModels = new Map<string, { model: CodexGovernanceHealthModel; cachedAt: number }>();
/** Either the CLI authority's report (ok) or the explicit unknown block (collection failure). */
type CodexHealthResult = CodexGovernanceHealth | CodexGovernanceHealthResult;const codexCache = new Map<string, { result: CodexHealthResult; cachedAt: number }>();

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
    // Governance consistency (review round 2 + round 3): a codexGovernance
    // collection failure is reported as status:'unknown' + ready:false +
    // blockers — never omitted and never rendered as healthy (rc-9). The
    // collect call has its OWN catch so a throwing model converts to the
    // unknown block here instead of escaping to the system-health 500 path.
    let codexGovernance: CodexHealthResult;
    const cached = codexCache.get(options.workspaceDir);
    if (cached !== undefined && Date.now() - cached.cachedAt < CODEX_WORKSPACE_CACHE_TTL_MS) {
      codexGovernance = cached.result;
    } else {
      try {
        const collected = await getCodexModel(options.workspaceDir).collect();
        codexGovernance = collected.status === 'ok' ? collected.health : collected;
        codexCache.set(options.workspaceDir, { result: codexGovernance, cachedAt: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
        codexGovernance = {
          status: 'unknown',
          ready: false,
          readyBlockers: [`health_collection_failed: ${message}`],
          reason: 'health_collection_failed',
          nextAction: 'Run `pd health --host codex --workspace <dir>` manually to see the structured reason.',
          productClaim: 'degraded',
        };
      }
    }
    sendSuccess(res, {
      ...health,
      authenticationMode: options.authenticationMode,
      codexGovernance,
    });
  } catch (error) {
    // A SYSTEM-health failure (checkSystemHealth threw) is a different fact
    // from a codexGovernance-block failure: it must keep the 500
    // health_check_error contract so status-code-based probes and monitors do
    // not read a broken system health as success (review round 3).
    sendError(res, 500, 'health_check_error', (error as Error).message);
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
