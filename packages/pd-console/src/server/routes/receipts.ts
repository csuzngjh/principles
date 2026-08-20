/**
 * Receipts API routes — PRI-533.
 *   GET /api/v1/receipts/counts                    → per-principle receipt counts
 *   GET /api/v1/receipts/principles/:principleId   → per-principle receipt history
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ReceiptsConsoleModel } from '../models/ReceiptsConsoleModel.js';
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

  sendNotFound(res, `Route /api/v1/receipts${subPath} not found`);
}

export function disposeReceiptsModels(): void {
  // Models hold no persistent resources (request-scoped readonly connections
  // are closed in finally blocks) — clearing the per-workspace map suffices.
  models.clear();
}
