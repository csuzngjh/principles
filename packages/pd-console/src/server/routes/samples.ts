import type { IncomingMessage, ServerResponse } from 'node:http';
import { SampleConsoleModel } from '../models/SampleConsoleModel.js';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';
import { parseQuery, readBody, safeParseInt } from '../utils/request.js';

const models = new Map<string, SampleConsoleModel>();

function getModel(workspaceDir: string): SampleConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new SampleConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleSamplesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    try {
      const query = parseQuery(req.url ?? '');
      const result = await model.listSamples({
        status: query.status,
        page: safeParseInt(query.page, 1, 1, 10000),
        pageSize: safeParseInt(query.pageSize, 20, 1, 100),
      });
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'samples_error', getErrorMessage(err));
    }
    return;
  }

  const detailMatch = /^\/([^/]+)$/.exec(subPath);
  if (req.method === 'GET' && detailMatch) {
    const sampleId = decodeURIComponent(detailMatch[1]);
    try {
      const detail = await model.getSampleDetail(sampleId);
      if (!detail) {
        sendNotFound(res, `Sample ${sampleId} not found`);
        return;
      }
      sendSuccess(res, detail);
    } catch (err: unknown) {
      sendError(res, 500, 'sample_detail_error', getErrorMessage(err));
    }
    return;
  }

  const reviewMatch = /^\/([^/]+)\/review$/.exec(subPath);
  if (req.method === 'POST' && reviewMatch) {
    const sampleId = decodeURIComponent(reviewMatch[1]);
    try {
      const body = await readBody(req);
      let parsed: { decision?: string; note?: string } | undefined = undefined;
      try {
        parsed = JSON.parse(body) as { decision?: string; note?: string };
      } catch {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }

      if (!parsed.decision || (parsed.decision !== 'approved' && parsed.decision !== 'rejected')) {
        sendBadRequest(res, 'decision must be "approved" or "rejected"');
        return;
      }

      if (parsed.note !== undefined && typeof parsed.note !== 'string') {
        sendBadRequest(res, 'note must be a string');
        return;
      }

      const result = await model.reviewSample(sampleId, {
        decision: parsed.decision,
        note: parsed.note,
      });
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (message === 'Request body too large') {
        sendError(res, 413, 'payload_too_large', message);
      } else if (message.includes('not found')) {
        sendNotFound(res, message);
      } else if (message.includes('not pending')) {
        sendError(res, 409, 'conflict', message);
      } else {
        sendError(res, 500, 'review_error', message);
      }
    }
    return;
  }

  sendNotFound(res, `Route /api/samples${subPath} not found`);
}

export function disposeSampleModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
