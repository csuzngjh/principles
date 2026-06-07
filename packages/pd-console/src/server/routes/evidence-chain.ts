/**
 * Evidence Chain API — exposes behavior evidence chain records for the Pain page.
 *
 * GET /api/v1/evidence-chain
 *   Returns evidence chain records from pain_events, tasks, candidates, and ledger.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EvidenceChainConsoleModel } from '../models/EvidenceChainConsoleModel.js';
import { sendSuccess, sendError } from '../utils/response.js';

const models = new Map<string, EvidenceChainConsoleModel>();

function getModel(workspaceDir: string): EvidenceChainConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new EvidenceChainConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export async function handleEvidenceChainRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET is allowed for this route');
    return;
  }

  const model = getModel(workspaceDir);
  try {
    const result = await model.getEvidenceChain();
    sendSuccess(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'evidence_chain_error', message);
  }
}

export function disposeEvidenceChainModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
