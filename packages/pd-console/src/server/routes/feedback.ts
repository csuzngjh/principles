import type { IncomingMessage, ServerResponse } from 'node:http';
import { FeedbackConsoleModel } from '../models/FeedbackConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const models = new Map<string, FeedbackConsoleModel>();

function getModel(workspaceDir: string): FeedbackConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new FeedbackConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleFeedbackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Method not allowed');
    return;
  }

  if (subPath === '/gfi') {
    try {
      const gfi = await model.getGfi();
      sendSuccess(res, gfi);
    } catch (err: unknown) {
      sendError(res, 500, 'gfi_error', getErrorMessage(err));
    }
    return;
  }

  if (subPath === '/empathy-events') {
    try {
      const limitParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit');
      const parsedLimit = limitParam ? parseInt(limitParam, 10) : 100;
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 100 : Math.min(parsedLimit, 500);
      const events = await model.getEmpathyEvents(limit);
      sendSuccess(res, events);
    } catch (err: unknown) {
      sendError(res, 500, 'empathy_error', getErrorMessage(err));
    }
    return;
  }

  if (subPath === '/gate-blocks') {
    try {
      const limitParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit');
      const parsedLimit = limitParam ? parseInt(limitParam, 10) : 100;
      const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 100 : Math.min(parsedLimit, 500);
      const blocks = await model.getGateBlocks(limit);
      sendSuccess(res, blocks);
    } catch (err: unknown) {
      sendError(res, 500, 'gate_blocks_error', getErrorMessage(err));
    }
    return;
  }

  sendNotFound(res, `Route /api/feedback${subPath} not found`);
}

export function disposeFeedbackModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
