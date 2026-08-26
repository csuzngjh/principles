import type { IncomingMessage, ServerResponse } from 'node:http';
import { ActivationsConsoleModel } from '../models/ActivationsConsoleModel.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';
import type { OwnerPromotionActor } from '@principles/core/runtime-v2';

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

export interface ActivationsRouteAuthority {
  ownerActor: OwnerPromotionActor | null;
  breakGlassActor: OwnerPromotionActor;
}

function mutationBody(body: unknown): { idempotencyKey: string; reasonCode: string; note?: string; confirmed?: boolean; artifactId?: string; artifactDigest?: string; controlVersion?: number; expectedVersion?: number } {
  if (!isRecord(body)) throw new Error('Request body must be a JSON object');
  for (const field of ['idempotencyKey', 'reasonCode'] as const) {
    if (!Object.hasOwn(body, field) || typeof body[field] !== 'string' || body[field].trim().length === 0) throw new Error(`Missing or invalid required field: ${field}`);
  }
  const { idempotencyKey, reasonCode } = body;
  if (typeof idempotencyKey !== 'string' || typeof reasonCode !== 'string') throw new Error('Required mutation fields are invalid');
  const result: ReturnType<typeof mutationBody> = { idempotencyKey, reasonCode };
  if (Object.hasOwn(body, 'note')) { if (typeof body.note !== 'string') throw new Error('Field "note" must be a string'); result.note = body.note; }
  if (Object.hasOwn(body, 'confirmed')) { if (typeof body.confirmed !== 'boolean') throw new Error('Field "confirmed" must be boolean'); result.confirmed = body.confirmed; }
  for (const field of ['artifactId', 'artifactDigest'] as const) { if (Object.hasOwn(body, field)) { if (typeof body[field] !== 'string') throw new Error(`Field "${field}" must be a string`); result[field] = body[field]; } }
  for (const field of ['controlVersion', 'expectedVersion'] as const) { if (Object.hasOwn(body, field)) { if (typeof body[field] !== 'number' || !Number.isInteger(body[field])) throw new Error(`Field "${field}" must be an integer`); result[field] = body[field]; } }
  return result;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let totalSize = 0;
  for await (const chunk of req) { const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk; totalSize += buf.length; if (totalSize > MAX_BODY_SIZE) throw new Error('payload_too_large'); chunks.push(buf); }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
}

// ── Route handler ────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/max-params */
export async function handleActivationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
  authority?: ActivationsRouteAuthority,
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

  const mutationMatch = /^\/([^/]+)\/(continue-observing|promote|reject-after-shadow|emergency-deactivate|recover-to-shadow)$/.exec(subPath);
  const pauseMatch = subPath === '/emergency-pause';
  const releaseMatch = /^\/emergency-pause\/([^/]+)\/release$/.exec(subPath);
  if (req.method === 'POST' && (mutationMatch || pauseMatch || releaseMatch)) {
    let body: ReturnType<typeof mutationBody>;
    try { body = mutationBody(await readJson(req)); }
    catch (err: unknown) { const message = err instanceof Error ? err.message : String(err); sendError(res, message === 'payload_too_large' ? 413 : 400, 'validation_error', message, { nextAction: 'Refresh the review and submit a valid bounded request.' }); return; }
    const [, , matchedOperation] = mutationMatch ?? [];
    const operation = matchedOperation ?? (pauseMatch ? 'emergency-pause' : 'release');
    const governance = operation === 'continue-observing' || operation === 'promote' || operation === 'reject-after-shadow' || operation === 'recover-to-shadow' || operation === 'release';
    const actor = governance ? authority?.ownerActor : (authority?.ownerActor ?? authority?.breakGlassActor);
    if (!actor) { sendError(res, 403, 'owner_authentication_required', 'This governance decision requires the configured Owner identity.', { nextAction: 'Configure PD_OWNER_ID and PD_OWNER_CREDENTIAL_ID, then authenticate with the Console token.' }); return; }
    const input = { actor, idempotencyKey: body.idempotencyKey, reasonCode: body.reasonCode, ...(body.note === undefined ? {} : { note: body.note }) };
    const model = getModel(workspaceDir);
    try {
      if (pauseMatch) { sendSuccess(res, await model.pauseAllRuleCode(input)); return; }
      if (releaseMatch) { const [, rawPauseId] = releaseMatch; if (!rawPauseId || body.expectedVersion === undefined) throw new Error('Pause ID and expectedVersion are required'); sendSuccess(res, await model.releaseRuleCodePause(decodeURIComponent(rawPauseId), body.expectedVersion, input)); return; }
      const [, rawId] = mutationMatch ?? []; if (!rawId) throw new Error('Activation ID is required'); const activationId = decodeURIComponent(rawId);
      if (operation === 'continue-observing') sendSuccess(res, await model.continueObserving(activationId, input));
      else if (operation === 'reject-after-shadow' || operation === 'emergency-deactivate') sendSuccess(res, await model.deactivateRuleCode(activationId, operation === 'reject-after-shadow' ? 'reject_after_shadow' : 'emergency_deactivate', input));
      else if (operation === 'recover-to-shadow') { if (body.controlVersion === undefined) throw new Error('Recovery requires controlVersion'); sendSuccess(res, await model.recoverRuleCodeToShadow(activationId, body.controlVersion, input)); }
      else {
        if (!body.artifactId || !body.artifactDigest || body.controlVersion === undefined || body.confirmed !== true) throw new Error('Promotion requires artifactId, artifactDigest, controlVersion, and confirmed=true');
        const result = await model.promoteRuleCode(activationId, { artifactId: body.artifactId, artifactDigest: body.artifactDigest, controlVersion: body.controlVersion, confirmed: body.confirmed }, input);
        if (!result.ok) { sendError(res, 409, result.reasonCode, result.summary, { failedChecks: result.failedChecks, nextAction: result.nextAction }); return; }
        sendSuccess(res, result);
      }
    } catch (err: unknown) { const message = err instanceof Error ? err.message : String(err); sendError(res, message.includes('expected version') || message.includes('requires exactly one') ? 409 : 500, 'owner_decision_failed', message, { nextAction: 'Refresh the Owner review; no partial decision was applied.' }); }
    return;
  }

  const ownerReviewMatch = /^\/([^/]+)\/owner-review$/.exec(subPath);
  if (req.method === 'GET' && ownerReviewMatch) {
    const [, rawId] = ownerReviewMatch;
    if (!rawId) { sendError(res, 400, 'invalid_id', 'Activation ID is missing'); return; }
    let activationId: string;
    try { activationId = decodeURIComponent(rawId); }
    catch { sendError(res, 400, 'invalid_id', 'Activation ID contains invalid URI encoding'); return; }
    try {
      sendSuccess(res, await getModel(workspaceDir).getOwnerReview(activationId, authority?.ownerActor !== null && authority?.ownerActor !== undefined, authority?.ownerActor ?? undefined));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('requires exactly one') || message.includes('not found')) sendNotFound(res, message);
      else sendError(res, 500, 'owner_review_error', message, { nextAction: 'Keep the rule in shadow and inspect workspace integrity.' });
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
