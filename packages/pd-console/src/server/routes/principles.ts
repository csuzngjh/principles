import type { IncomingMessage, ServerResponse } from 'node:http';
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
      const filter = (filterRaw !== null && VALID_FILTERS.has(filterRaw) ? filterRaw : 'all') as PrincipleFilter;

      const result = await model.listPrinciples(filter);
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
