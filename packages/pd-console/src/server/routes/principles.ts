import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'path';
import * as fs from 'fs';
import { PrinciplesConsoleModel, type PrincipleFilter } from '../models/PrinciplesConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, PrinciplesConsoleModel>();

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
  unavailableReason?: string;
}> {
  // Runtime V2 uses <workspace>/.pd/state.db (NOT .state/state.db)
  const dbPath = path.join(workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(dbPath)) {
    return { ids: new Set(), unavailableReason: 'approval_db_not_found' };
  }

  let closeFn: (() => void) | null = null;
  try {
    const { SqliteConnection } = await import('@principles/core/runtime-v2');
    const conn = new SqliteConnection({ workspaceDir, readonly: true });
    closeFn = () => conn.close();
    const db = conn.getDb();

    // Join approvals with pi_artifacts to find decided principle IDs
    const rows = db.prepare(
      "SELECT DISTINCT a.source_principle_id " +
      "FROM approvals ap " +
      "JOIN pi_artifacts a ON a.artifact_id = ap.artifact_id " +
      "WHERE ap.status IN ('approved', 'rejected') " +
      "AND a.source_principle_id IS NOT NULL"
    ).all();

    // EP-01 Rule 1: treat DB rows as unknown; validate before use
    // EP-01 Rule 2: no `as` cast — use getOwnStringField instead
    const ids = new Set<string>();
    for (const row of rows) {
      const val = getOwnStringField(row, 'source_principle_id');
      if (val !== undefined) {
        ids.add(val);
      }
    }
    return { ids };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ids: new Set(), unavailableReason: `approval_query_failed: ${message}` };
  } finally {
    closeFn?.();
  }
}

interface PrinciplesRouteParams {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceDir: string;
  subPath: string;
}

export async function handlePrinciplesRoute({
  req,
  res,
  workspaceDir,
  subPath,
}: PrinciplesRouteParams): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/principles${subPath} not found`);
    return;
  }

  const model = getModel(workspaceDir);

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
      const result = await model.listPrinciples(filter, decidedResult.ids);
      // Surface approval cross-check unavailability to the UI (ERR-002)
      if (decidedResult.unavailableReason) {
        result.approvalCrossCheckUnavailable = decidedResult.unavailableReason;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'principles_list_error', (err as Error).message);
    }
    return;
  }

  const detailMatch = /^\/([^/]+)$/.exec(subPath);
  if (detailMatch) {
    const [, principleId] = detailMatch;
    try {
      const result = await model.getPrincipleDetail(principleId);
      if (!result) {
        sendNotFound(res, `Principle "${principleId}" not found`);
        return;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'principle_detail_error', (err as Error).message);
    }
    return;
  }

  sendNotFound(res, `Route /api/principles${subPath} not found`);
}

export function disposePrinciplesModels(): void {
  models.clear();
}
