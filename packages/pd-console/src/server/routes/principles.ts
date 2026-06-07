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
 * Query the SQLite state.db for principle IDs that have been decided
 * (approved or rejected) via the approval queue. Returns an empty Set
 * if the database is not available (graceful degradation with reason).
 */
async function getDecidedPrincipleIds(workspaceDir: string): Promise<Set<string>> {
  const dbPath = path.join(workspaceDir, '.state', 'state.db');
  if (!fs.existsSync(dbPath)) {
    return new Set();
  }

  try {
    // Dynamic import to avoid loading better-sqlite3 when DB doesn't exist
    const { SqliteConnection } = await import('@principles/core/runtime-v2');
    const conn = new SqliteConnection({ workspaceDir, readonly: true });
    const db = conn.getDb();

    // Join approvals with pi_artifacts to find decided principle IDs
    const rows = db.prepare(
      "SELECT DISTINCT a.source_principle_id " +
      "FROM approvals ap " +
      "JOIN pi_artifacts a ON a.artifact_id = ap.artifact_id " +
      "WHERE ap.status IN ('approved', 'rejected') " +
      "AND a.source_principle_id IS NOT NULL"
    ).all() as { source_principle_id: string }[];

    conn.close();
    return new Set(rows.map((r) => r.source_principle_id));
  } catch {
    // Graceful degradation: if DB query fails, return empty set.
    // The classifier will still work, just without the approval cross-check.
    return new Set();
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

      const decidedPrincipleIds = await getDecidedPrincipleIds(workspaceDir);
      const result = await model.listPrinciples(filter, decidedPrincipleIds);
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
