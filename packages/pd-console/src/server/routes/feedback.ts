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

export async function handleFeedbackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method !== 'GET') {
    sendNotFound(res, 'Method not allowed');
    return;
  }

  if (subPath === '/gfi') {
    try {
      const gfi = await model.getGfi([]);
      sendSuccess(res, gfi);
    } catch (err: any) {
      sendError(res, 500, 'gfi_error', err.message);
    }
    return;
  }

  if (subPath === '/empathy-events') {
    try {
      const limitParam = new URL(req.url!, `http://localhost`).searchParams.get('limit');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const events = await model.getEmpathyEvents(limit);
      sendSuccess(res, events);
    } catch (err: any) {
      sendError(res, 500, 'empathy_error', err.message);
    }
    return;
  }

  if (subPath === '/gate-blocks') {
    try {
      const limitParam = new URL(req.url!, `http://localhost`).searchParams.get('limit');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const blocks = await model.getGateBlocks(limit);
      sendSuccess(res, blocks);
    } catch (err: any) {
      sendError(res, 500, 'gate_blocks_error', err.message);
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
