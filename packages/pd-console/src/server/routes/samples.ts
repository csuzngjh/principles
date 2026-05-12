import type { IncomingMessage, ServerResponse } from 'node:http';
import { SampleConsoleModel } from '../models/SampleConsoleModel.js';
import { sendSuccess, sendError, sendNotFound, sendMethodNotAllowed, sendBadRequest } from '../utils/response.js';

const models = new Map<string, SampleConsoleModel>();

function getModel(workspaceDir: string): SampleConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new SampleConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function parseQuery(url: string): Record<string, string> {
  const query: Record<string, string> = {};
  const searchIndex = url.indexOf('?');
  if (searchIndex === -1) return query;
  const search = url.slice(searchIndex + 1);
  for (const pair of search.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIndex));
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    query[key] = value;
  }
  return query;
}

const MAX_BODY_SIZE = 1024 * 64;

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleSamplesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  // GET /api/samples - list samples
  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    try {
      const query = parseQuery(req.url ?? '');
      const page = query.page ? Math.max(1, parseInt(query.page, 10) || 1) : undefined;
      const pageSize = query.pageSize ? Math.min(Math.max(1, parseInt(query.pageSize, 10) || 20), 100) : undefined;
      const result = await model.listSamples({
        status: query.status,
        page,
        pageSize,
      });
      sendSuccess(res, result);
    } catch (err: any) {
      sendError(res, 500, 'samples_error', err.message);
    }
    return;
  }

  // GET /api/samples/:id - get sample detail
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

  // POST /api/samples/:id/review - review a sample
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
