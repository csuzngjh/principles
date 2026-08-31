import type { IncomingMessage, ServerResponse } from 'node:http';
import { GovernanceConsoleModel } from '../models/GovernanceConsoleModel.js';
import { GovernanceExperienceCollector } from '../models/GovernanceExperienceCollector.js';
import type { OwnerConfigSnapshot, OwnerIdentityResolved } from '@principles/core/runtime-v2';
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

const experienceCollectors = new Map<string, GovernanceExperienceCollector>();

function getExperienceCollector(workspaceDir: string): GovernanceExperienceCollector {
  let collector = experienceCollectors.get(workspaceDir);
  if (!collector) {
    collector = new GovernanceExperienceCollector(workspaceDir);
    experienceCollectors.set(workspaceDir, collector);
  }
  return collector;
}

export interface GovernanceExperienceContext {
  workspaceDir: string;
  featureFlags?: Record<string, { enabled: boolean } | undefined>;
  ownerConfig: OwnerConfigSnapshot;
}

/**
 * Owner identity evidence for the governance experience snapshot. Mirrors the
 * activations authority wiring in server/index.ts (authConfig.isEnabled() +
 * PD_OWNER_ID + PD_OWNER_CREDENTIAL_ID) — the two must stay in sync; the route
 * tests lock the mapping.
 */
export function resolveOwnerConfigSnapshot(
  authConfig: { isEnabled(): boolean },
  identity: OwnerIdentityResolved,
): OwnerConfigSnapshot {
  const authEnabled = authConfig.isEnabled();
  const ownerIdentityConfiguration = identity.source === 'invalid_env' || identity.error !== undefined
    ? 'invalid'
    : (identity.source === 'env' || identity.source === 'file') && identity.ownerId && identity.credentialId
      ? 'configured'
      : 'missing';
  return {
    authenticationMode: authEnabled ? 'authenticated' : 'no_auth',
    ownerIdentityConfiguration,
  };
}

/**
 * GET /api/v1/governance/experience — read-only Governance Experience Snapshot
 * v1.5.1 (PRI-585).
 *
 * Flag contract (SPEC §14.1): with `governance_experience_v1` disabled the
 * route returns 403 `feature_disabled` BEFORE any DB / ledger / config access.
 * The snapshot explains governance state; it never authorizes mutations.
 */
export async function handleGovernanceExperienceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GovernanceExperienceContext,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Use GET for /api/v1/governance/experience.', { nextAction: 'Retry with GET.' });
    return;
  }

  // Gate first — flag-off must not touch the database, ledger, or config files.
  if (ctx.featureFlags?.governance_experience_v1?.enabled !== true) {
    sendError(
      res,
      403,
      'feature_disabled',
      'governance_experience_v1 feature flag is disabled. The governance experience snapshot endpoint is inactive.',
      { nextAction: 'Enable features.governance_experience_v1.enabled: true in .pd/config.yaml and restart the Console server.' },
    );
    return;
  }

  try {
    const snapshot = getExperienceCollector(ctx.workspaceDir).collectSnapshot({ ownerConfig: ctx.ownerConfig });
    sendSuccess(res, snapshot);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'governance_experience_error', message, { nextAction: 'Inspect the workspace state (.pd/state.db, .state/principle_training_state.json, .pd/config.yaml) and retry.' });
  }
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
  experienceCollectors.clear();
}
