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
    } catch (err: any) {
      sendError(res, 500, 'samples_error', err.message);
    }
    return;
  }

  const detailMatch = subPath.match(/^\/([^/]+)$/);
  if (req.method === 'GET' && detailMatch) {
    const sampleId = decodeURIComponent(detailMatch[1]);
    try {
      const detail = await model.getSampleDetail(sampleId);
      if (!detail) {
        sendNotFound(res, `Sample ${sampleId} not found`);
        return;
      }
      sendSuccess(res, detail);
    } catch (err: any) {
      sendError(res, 500, 'sample_detail_error', err.message);
    }
    return;
  }

  const reviewMatch = subPath.match(/^\/([^/]+)\/review$/);
  if (req.method === 'POST' && reviewMatch) {
    const sampleId = decodeURIComponent(reviewMatch[1]);
    try {
      const body = await readBody(req);
      let parsed: { decision?: string; note?: string };
      try {
        parsed = JSON.parse(body);
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
        decision: parsed.decision as 'approved' | 'rejected',
        note: parsed.note,
      });
      sendSuccess(res, result);
    } catch (err: any) {
      if (err.message === 'Request body too large') {
        sendError(res, 413, 'payload_too_large', err.message);
      } else if (err.message.includes('not found')) {
        sendNotFound(res, err.message);
      } else if (err.message.includes('not pending')) {
        sendError(res, 409, 'conflict', err.message);
      } else {
        sendError(res, 500, 'review_error', err.message);
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
