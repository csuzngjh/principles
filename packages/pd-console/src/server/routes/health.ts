import type { IncomingMessage, ServerResponse } from 'node:http';
import { HealthCheckModel } from '../models/HealthCheckModel.js';
import { CodexGovernanceHealthModel, type CodexGovernanceHealth, type CodexGovernanceHealthResult } from '../models/CodexGovernanceHealthModel.js';
import { IngestionHealthModel, type IngestionHealthResult } from '../models/IngestionHealthModel.js';
import { sendSuccess, sendError, errorMessage } from '../utils/response.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * PRI-1069/G1 P0-1 (SPEC v1.2 §14): one-shot launcher nonce, read once at
 * process start. The installer spawns this server with
 * PD_CONSOLE_VERIFY_NONCE in the child env; the health response echoes it so
 * the probe can bind the answer to THIS child instance. Absent on normal
 * (user-launched) consoles. Never logged.
 */
const VERIFY_NONCE = process.env.PD_CONSOLE_VERIFY_NONCE && process.env.PD_CONSOLE_VERIFY_NONCE.length > 0
  ? process.env.PD_CONSOLE_VERIFY_NONCE
  : null;

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

// PRI-1171 ticket ⑦: unified three-host ingestion health — SAME authority
// discipline as the codex block above (the CLI report is the one truth; the
// Console executes it and renders verbatim). Cached per workspace.
const INGESTION_WORKSPACE_CACHE_TTL_MS = MODEL_CACHE_TTL_MS;
const ingestionModels = new Map<string, { model: IngestionHealthModel; cachedAt: number }>();
const ingestionCache = new Map<string, { result: IngestionHealthResult; cachedAt: number }>();

function getIngestionModel(workspaceDir: string): IngestionHealthModel {
  const cached = ingestionModels.get(workspaceDir);
  if (cached !== undefined && Date.now() - cached.cachedAt < INGESTION_WORKSPACE_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new IngestionHealthModel(workspaceDir);
  ingestionModels.set(workspaceDir, { model, cachedAt: Date.now() });
  return model;
}

/**
 * `?refresh=1` is the page's explicit Refresh button path: bypass the
 * 5-minute cache so the operator actually gets a fresh CLI report instead
 * of the same snapshot with a spinning icon (PR #2563 review).
 */
function isIngestionRefresh(req: IncomingMessage): boolean {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams.has('refresh');
  } catch {
    return false;
  }
}

/**
 * GET /api/health/ingestion — the unified three-host conversation-ingestion
 * health section, verbatim from the CLI authority. A collection failure is
 * the explicit unknown block (rc-9), never an empty-but-healthy row.
 */
export async function handleIngestionHealthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  options: { workspaceDir: string },
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET method is allowed');
    return;
  }
  const cached = isIngestionRefresh(req) ? undefined : ingestionCache.get(options.workspaceDir);
  if (cached !== undefined && Date.now() - cached.cachedAt < INGESTION_WORKSPACE_CACHE_TTL_MS) {
    sendSuccess(res, cached.result);
    return;
  }
  let result: IngestionHealthResult;
  try {
    result = await getIngestionModel(options.workspaceDir).collect();
  } catch (error) {
    result = {
      status: 'unknown',
      reason: 'health_collection_failed',
      nextAction: `Run \`pd health --workspace <dir> --json\` manually to see the structured ingestion section. (${errorMessage(error).slice(0, 160)})`,
      productClaim: 'degraded',
    };
  }
  // An unknown result is NEVER cached: a transient CLI outage must not pin
  // the panel to "unable to determine" for five minutes — the next request
  // retries the collection immediately (a recovered CLI refreshes the page).
  // A FAILED forced refresh must also EVICT a previous successful snapshot:
  // otherwise the next plain GET keeps serving stale "healthy" data for the
  // rest of the TTL (PR #2563 re-review 4546345447).
  if (result.status === 'ok') {
    ingestionCache.set(options.workspaceDir, { result, cachedAt: Date.now() });
  } else {
    ingestionCache.delete(options.workspaceDir);
  }
  sendSuccess(res, result);
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
        const message = errorMessage(error).slice(0, 200);
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
      // PRI-1069/G1 P0-1: installer identity binding. When the launching
      // installer passes a one-shot nonce via env, echo it back so the probe
      // can prove THIS child answered — an old console, another local service,
      // or a proxy 502 cannot know the value. The nonce is short-lived,
      // machine-local, never logged here, and absent entirely for consoles
      // launched without it (normal user launches), keeping the legacy shape.
      ...(VERIFY_NONCE !== null ? { verifyNonce: VERIFY_NONCE } : {}),
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
  ingestionModels.clear();
  ingestionCache.clear();
}
