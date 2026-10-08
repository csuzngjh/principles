/**
 * Receipts API routes — PRI-533.
 *   GET /api/v1/receipts/counts                    → per-principle receipt counts
 *   GET /api/v1/receipts/principles/:principleId   → per-principle receipt history
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ReceiptsConsoleModel } from '../models/ReceiptsConsoleModel.js';
import type { InterventionAuditSelector, InterventionRecordKind } from '@principles/core/runtime-v2';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, ReceiptsConsoleModel>();

function getModel(workspaceDir: string): ReceiptsConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new ReceiptsConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleReceiptsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET is supported on /api/v1/receipts');
    return;
  }

  if (subPath === '/counts' || subPath === '/counts/') {
    const model = getModel(workspaceDir);
    try {
      const result = await model.getReceiptCounts();
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'receipts_counts_error', message);
    }
    return;
  }

  // No regex here: ESLint's prefer-regexp-exec demands .exec(), while the
  // Mimosa write gate flags `.exec(`-shaped calls — plain slicing satisfies both.
  if (subPath.startsWith('/principles/')) {
    const rawId = subPath.slice('/principles/'.length);
    if (rawId.length === 0 || rawId.includes('/')) {
      sendNotFound(res, `Route /api/v1/receipts${subPath} not found`);
      return;
    }
    let principleId: string;
    try {
      principleId = decodeURIComponent(rawId);
    } catch {
      sendError(res, 400, 'invalid_id', 'Principle ID contains invalid URI encoding');
      return;
    }
    const model = getModel(workspaceDir);
    try {
      const result = await model.getPrincipleReceipts(principleId);
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'receipts_error', message);
    }
    return;
  }

  // PD v2 Phase 1 (SPEC §13.8): the four audit queries.
  //   GET /api/v1/receipts/evidence-audit?type=principle|activation|episode|effect&id=<selector>
  if (subPath === '/evidence-audit' || subPath === '/evidence-audit/') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const type = url.searchParams.get('type');
    const id = (url.searchParams.get('id') ?? '').trim();
    if (id.length === 0 || id.length > 256) {
      sendError(res, 400, 'invalid_selector', 'Query parameter id must be a non-empty string of at most 256 characters');
      return;
    }
    let selector: InterventionAuditSelector;
    if (type === 'principle') selector = { type: 'principle', principleId: id };
    else if (type === 'activation') selector = { type: 'activation', activationId: id };
    else if (type === 'episode') selector = { type: 'episode', observationKey: id };
    else if (type === 'effect') selector = { type: 'effect', observationKey: id };
    else {
      sendError(res, 400, 'invalid_selector_type', 'Query parameter type must be one of principle, activation, episode, effect');
      return;
    }
    const afterKind = url.searchParams.get('afterKind');
    const afterAt = url.searchParams.get('afterRecordedAt');
    const afterId = url.searchParams.get('afterEvidenceId');
    const cursorFieldsPresent = afterKind !== null || afterAt !== null || afterId !== null;
    let cursor: { kind: InterventionRecordKind; after: { recordedAt: string; evidenceId: string } } | undefined;
    if (cursorFieldsPresent) {
      const isRecordKind = (value: string | null): value is InterventionRecordKind =>
        value === 'delivery' || value === 'application' || value === 'behavior_episode' || value === 'effect' || value === 'outcome';
      const isValidUtcCursor = (value: string | null): value is string => {
        if (value === null) return false;
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
        return match !== null && Number.isFinite(Date.parse(value))
          && new Date(Date.parse(value)).toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
      };
      if (!isRecordKind(afterKind)
        || !isValidUtcCursor(afterAt)
        || afterId === null || afterId.length === 0 || afterId.length > 256) {
        sendError(res, 400, 'invalid_cursor', 'Pagination requires a valid afterKind, UTC afterRecordedAt, and afterEvidenceId');
        return;
      }
      cursor = { kind: afterKind, after: { recordedAt: afterAt, evidenceId: afterId } };
    }
    const model = getModel(workspaceDir);
    try {
      const result = await model.getEvidenceAudit(selector, cursor);
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'evidence_audit_error', message);
    }
    return;
  }

  sendNotFound(res, `Route /api/v1/receipts${subPath} not found`);
}

export function disposeReceiptsModels(): void {
  // Models hold no persistent resources (request-scoped readonly connections
  // are closed in finally blocks) — clearing the per-workspace map suffices.
  models.clear();
}
