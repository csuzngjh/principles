/**
 * Evidence Chain API — exposes behavior evidence chain records for the Pain page.
 *
 * GET /api/evidence-chain
 *   Returns evidence chain records from pain_events, tasks, candidates, and ledger.
 *
 * GET /api/evidence-chain/assistant-turn?id=<turnId>&session=<sessionId>
 *   P1-2: returns the referenced assistant turn verbatim so the Owner can
 *   compare the correction text with the original output.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EvidenceChainConsoleModel } from '../models/EvidenceChainConsoleModel.js';
import { sendSuccess, sendError, errorMessage } from '../utils/response.js';

const models = new Map<string, EvidenceChainConsoleModel>();

function getModel(workspaceDir: string): EvidenceChainConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new EvidenceChainConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function isAssistantTurnPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? '';
  return pathname === '/assistant-turn' || pathname === '/api/evidence-chain/assistant-turn';
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

  if (isAssistantTurnPath(req.url ?? '')) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rawId = url.searchParams.get('id') ?? '';
    const session = url.searchParams.get('session') ?? undefined;
    const turnId = Number(rawId);

    try {
      const result = await model.getAssistantTurn(turnId, session || undefined);
      if (!result.ok) {
        sendError(res, 404, 'assistant_turn_unavailable', result.reason, { nextAction: result.nextAction });
        return;
      }
      sendSuccess(res, result.turn);
    } catch (err: unknown) {
      sendError(res, 500, 'assistant_turn_error', errorMessage(err));
    }
    return;
  }

  try {
    const result = await model.getEvidenceChain();
    sendSuccess(res, result);
  } catch (err: unknown) {
    const message = errorMessage(err);
    sendError(res, 500, 'evidence_chain_error', message);
  }
}

export function disposeEvidenceChainModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
