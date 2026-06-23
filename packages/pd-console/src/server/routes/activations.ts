import type { IncomingMessage, ServerResponse } from 'node:http';
import { ActivationsConsoleModel } from '../models/ActivationsConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

const models = new Map<string, ActivationsConsoleModel>();

function getModel(workspaceDir: string): ActivationsConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new ActivationsConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

// ── Request body validation (ERR-001/005/009/013) ───────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDisableRequest(body: unknown): { ok: true; confirmed: boolean } | { ok: false; reason: string } {
  if (!isRecord(body)) {
    return { ok: false, reason: 'Request body must be a JSON object' };
  }
  if (!Object.hasOwn(body, 'confirmed')) {
    return { ok: false, reason: 'Missing required field: confirmed' };
  }
  if (typeof body.confirmed !== 'boolean') {
    return { ok: false, reason: 'Field "confirmed" must be a boolean' };
  }
  if (!body.confirmed) {
    return { ok: false, reason: 'Disable operation requires confirmed=true' };
  }
  return { ok: true, confirmed: true };
}

// ── Route handler ────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/max-params */
export async function handleActivationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  // GET /api/v1/activations
  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    const model = getModel(workspaceDir);
    try {
      const result = await model.getActivations();
      sendSuccess(res, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'activations_error', message);
    }
    return;
  }

  // POST /api/v1/activations/:id/disable
  const disableExec = /^\/([^/]+)\/disable$/.exec(subPath);
  if (req.method === 'POST' && disableExec) {
    const [, rawId] = disableExec;
    if (!rawId) {
      sendError(res, 400, 'invalid_id', 'Activation ID is missing');
      return;
    }
    let activationId: string;
    try {
      activationId = decodeURIComponent(rawId);
    } catch {
      sendError(res, 400, 'invalid_id', 'Activation ID contains invalid URI encoding');
      return;
    }
    const model = getModel(workspaceDir);

    // Read and validate request body
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalSize += buf.length;
        if (totalSize > MAX_BODY_SIZE) {
          sendError(res, 413, 'payload_too_large', 'Request body exceeds maximum allowed size');
          return;
        }
        chunks.push(buf);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      body = JSON.parse(rawBody);
    } catch {
      if (res.writableEnded) return;
      sendError(res, 400, 'invalid_body', 'Request body must be valid JSON');
      return;
    }

    const validation = validateDisableRequest(body);
    if (!validation.ok) {
      sendError(res, 400, 'validation_error', validation.reason);
      return;
    }

    try {
      const result = await model.deactivateActivation(activationId);
      if (result.ok) {
        sendSuccess(res, { activationId, status: 'inactive' });
      } else {
        sendError(res, 409, 'deactivate_failed', result.reason, { nextAction: result.nextAction });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'deactivate_error', message, { nextAction: 'Check server logs. The activation state has not been changed.' });
    }
    return;
  }

  sendNotFound(res, `Route /api/v1/activations${subPath} not found`);
}

export function disposeActivationsModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
