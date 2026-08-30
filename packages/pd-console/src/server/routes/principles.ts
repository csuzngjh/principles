import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'path';
import * as fs from 'fs';
import { PrinciplesConsoleModel, type PrincipleFilter } from '../models/PrinciplesConsoleModel.js';
import { PrincipleTrajectoryModel } from '../models/PrincipleTrajectoryModel.js';
import { GovernanceProjectionCollector, GovernanceProjectionCollectionError } from '../models/GovernanceProjectionCollector.js';
import { OwnerGovernanceViewSchema, deriveOwnerGovernanceView } from '@principles/core/runtime-v2';
import { Value } from '@sinclair/typebox/value';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, PrinciplesConsoleModel>();
const trajectoryModels = new Map<string, PrincipleTrajectoryModel>();

function getModel(workspaceDir: string): PrinciplesConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new PrinciplesConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/**
 * Safely read an own string property from an unknown object.
 * Returns the string value if the key exists and the value is a string,
 * otherwise undefined. Uses Object.getOwnPropertyDescriptor to avoid
 * any `as` cast on the row (EP-01 Rule 2).
 */
function getOwnStringField(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined) return undefined;
  return typeof desc.value === 'string' ? desc.value : undefined;
}

/**
 * Query the SQLite state.db for principle IDs that have been decided
 * (approved or rejected) via the approval queue.
 *
 * Returns { ids, unavailableReason } — if the DB is not available or the
 * query fails, ids is empty and unavailableReason explains why, so the
 * caller can surface this to the UI (ERR-002: no silent degradation).
 */
async function getDecidedPrincipleIds(workspaceDir: string): Promise<{
  ids: Set<string>;
  pendingIds: Set<string>;
  unavailableReason?: string;
}> {
  // Runtime V2 uses <workspace>/.pd/state.db (NOT .state/state.db)
  const dbPath = path.join(workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(dbPath)) {
    return { ids: new Set(), pendingIds: new Set(), unavailableReason: 'approval_db_not_found' };
  }

  let closeFn: (() => void) | null = null;
  try {
    const { SqliteConnection } = await import('@principles/core/runtime-v2');
    const conn = new SqliteConnection({ workspaceDir, readonly: true });
    closeFn = () => conn.close();
    const db = conn.getDb();

    // Join approvals with pi_artifacts to find decided principle IDs
    // PRI-629: also resolve PENDING approvals — a pending approval is a real
    // Owner decision (owner_actionable), unlike candidate lifecycle (in_pipeline).
    const rows = db.prepare(
      "SELECT DISTINCT a.source_principle_id, ap.status " +
      "FROM approvals ap " +
      "JOIN pi_artifacts a ON a.artifact_id = ap.artifact_id " +
      "WHERE ap.status IN ('approved', 'rejected', 'pending') " +
      "AND a.source_principle_id IS NOT NULL"
    ).all();

    // EP-01 Rule 1: treat DB rows as unknown; validate before use
    // EP-01 Rule 2: no `as` cast — use getOwnStringField instead
    const ids = new Set<string>();
    const pendingIds = new Set<string>();
    for (const row of rows) {
      const val = getOwnStringField(row, 'source_principle_id');
      if (val === undefined) continue;
      if (getOwnStringField(row, 'status') === 'pending') {
        pendingIds.add(val);
      } else {
        ids.add(val);
      }
    }
    return { ids, pendingIds };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ids: new Set(), pendingIds: new Set(), unavailableReason: `approval_query_failed: ${message}` };
  } finally {
    closeFn?.();
  }
}

interface PrinciplesRouteParams {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceDir: string;
  subPath: string;
  featureFlags?: Record<string, { enabled: boolean }>;
  now?: () => string;
}

export async function handlePrinciplesRoute({
  req,
  res,
  workspaceDir,
  subPath,
  featureFlags,
  now = () => new Date().toISOString(),
}: PrinciplesRouteParams): Promise<void> {
  // GET /api/v1/principles/:id/governance. Gate before constructing any
  // Console model or projection reader so flag-off is a true no-read path.
  const governanceMatch = /^\/([^/]+)\/governance$/.exec(subPath);
  if (req.method === 'GET' && governanceMatch) {
    const flag = featureFlags?.principle_governance_projection_v2;
    if (flag?.enabled !== true) {
      sendError(res, 403, 'feature_disabled',
        'Principle governance projection is disabled.',
        { reason: 'feature_disabled', nextAction: 'Enable features.principle_governance_projection_v2 in .pd/config.yaml.' });
      return;
    }
    const [, rawPrincipleId] = governanceMatch;
    let principleId: string;
    try {
      principleId = decodeURIComponent(rawPrincipleId ?? '');
    } catch {
      sendError(res, 400, 'invalid_principle_id', 'Principle ID contains invalid URL encoding', { nextAction: 'Check the principle ID and retry.' });
      return;
    }
    if (principleId.length === 0) {
      sendError(res, 400, 'invalid_principle_id', 'Principle ID is missing', { nextAction: 'Provide a non-empty principle ID.' });
      return;
    }
    try {
      const facts = await new GovernanceProjectionCollector(workspaceDir).collect(principleId, now());
      const view = deriveOwnerGovernanceView(facts);
      if (!Value.Check(OwnerGovernanceViewSchema, view)) {
        sendError(res, 500, 'governance_projection_error', 'Derived governance view failed contract validation.', { nextAction: 'Inspect projection diagnostics and Runtime state.' });
        return;
      }
      sendSuccess(res, view);
    } catch (error: unknown) {
      if (error instanceof GovernanceProjectionCollectionError) {
        sendError(res, error.reasonCode === 'principle_not_found' ? 404 : 500, error.reasonCode, error.message, { nextAction: error.nextActionCode });
        return;
      }
      sendError(res, 500, 'governance_projection_error', error instanceof Error ? error.message : String(error), { nextAction: 'inspect_runtime_state' });
    }
    return;
  }

  const model = getModel(workspaceDir);

  // ── POST Routes ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    // POST /api/principles/:id/archive
    const archiveMatch = /^\/([^/]*)\/archive$/.exec(subPath);
    if (archiveMatch) {
      const [, rawPrincipleId] = archiveMatch;
      if (!rawPrincipleId) {
        sendError(res, 400, 'invalid_principle_id', 'Principle ID is missing');
        return;
      }
      let principleId: string;
      try {
        principleId = decodeURIComponent(rawPrincipleId);
      } catch {
        sendError(res, 400, 'invalid_principle_id', 'Principle ID contains invalid URL encoding');
        return;
      }
      try {
        const ok = await model.archivePrinciple(principleId);
        if (ok) {
          sendSuccess(res, { success: true, principleId });
        } else {
          sendError(res, 500, 'archive_failed', `Failed to archive principle "${principleId}"`);
        }
      } catch (err: unknown) {
        sendError(res, 500, 'archive_failed', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // POST /api/principles/:id/unarchive
    const unarchiveMatch = /^\/([^/]*)\/unarchive$/.exec(subPath);
    if (unarchiveMatch) {
      const [, rawPrincipleId] = unarchiveMatch;
      if (!rawPrincipleId) {
        sendError(res, 400, 'invalid_principle_id', 'Principle ID is missing');
        return;
      }
      let principleId: string;
      try {
        principleId = decodeURIComponent(rawPrincipleId);
      } catch {
        sendError(res, 400, 'invalid_principle_id', 'Principle ID contains invalid URL encoding');
        return;
      }
      try {
        const ok = await model.unarchivePrinciple(principleId);
        if (ok) {
          sendSuccess(res, { success: true, principleId });
        } else {
          sendError(res, 500, 'unarchive_failed', `Failed to unarchive principle "${principleId}"`);
        }
      } catch (err: unknown) {
        sendError(res, 500, 'unarchive_failed', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    sendNotFound(res, `Route ${req.method} /api/principles${subPath} not found`);
    return;
  }

  // ── GET Routes ──────────────────────────────────────────────────────────────
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/principles${subPath} not found`);
    return;
  }

  if (subPath === '' || subPath === '/') {
    try {
      // Parse query string for filter parameter
      const urlParts = (req.url ?? '').split('?');
      const queryString = urlParts[1] ?? '';
      const params = new URLSearchParams(queryString);
      const filterRaw = params.get('filter');
      const VALID_FILTERS = new Set<string>(['all', 'actionable']);
      const filter = (filterRaw !== null && VALID_FILTERS.has(filterRaw) ? filterRaw : 'actionable') as PrincipleFilter;

      const decidedResult = await getDecidedPrincipleIds(workspaceDir);
      const result = await model.listPrinciples(filter, decidedResult.ids, decidedResult.pendingIds);
      // Surface approval cross-check unavailability to the UI (ERR-002)
      if (decidedResult.unavailableReason) {
        result.approvalCrossCheckUnavailable = decidedResult.unavailableReason;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'principles_list_error', err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // GET /api/principles/:id/trajectory
  const trajectoryMatch = /^\/([^/]+)\/trajectory$/.exec(subPath);
  if (trajectoryMatch) {
    const [, rawPrincipleId] = trajectoryMatch;
    if (!rawPrincipleId) {
      sendError(res, 400, 'invalid_principle_id', 'Principle ID is missing');
      return;
    }
    let decodedPrincipleId: string;
    try {
      decodedPrincipleId = decodeURIComponent(rawPrincipleId);
    } catch {
      sendError(res, 400, 'invalid_principle_id', 'Invalid URL encoding in principle id');
      return;
    }
    try {
      let trajModel = trajectoryModels.get(workspaceDir);
      if (!trajModel) {
        trajModel = new PrincipleTrajectoryModel(workspaceDir);
        trajectoryModels.set(workspaceDir, trajModel);
      }
      const result = await trajModel.getTrajectory(decodedPrincipleId);
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'principle_trajectory_error', message);
    }
    return;
  }

  const detailMatch = /^\/([^/]+)$/.exec(subPath);
  if (detailMatch) {
    const [, principleId] = detailMatch;
    if (!principleId) {
      sendError(res, 400, 'invalid_principle_id', 'Principle ID is missing');
      return;
    }
    try {
      const result = await model.getPrincipleDetail(principleId);
      if (!result) {
        sendNotFound(res, `Principle "${principleId}" not found`);
        return;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'principle_detail_error', err instanceof Error ? err.message : String(err));
    }
    return;
  }

  sendNotFound(res, `Route /api/principles${subPath} not found`);

}

export function disposePrinciplesModels(): void {
  models.clear();
  for (const m of trajectoryModels.values()) {
    m.dispose();
  }
  trajectoryModels.clear();
}
