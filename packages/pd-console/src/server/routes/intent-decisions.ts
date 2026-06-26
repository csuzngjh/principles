/**
 * IntentDecisions route — HTTP surface for IntentDecisionRecord (PRI-470, SPEC §21.7).
 *
 * Endpoints (all gated by the `intent_engineering` feature flag):
 * - POST   /api/v1/intent-decisions            → create (201) or idempotent replay (200)
 * - GET    /api/v1/intent-decisions?painId=…   → list by painId
 * - GET    /api/v1/intent-decisions?taskId=…   → list by taskId
 * - GET    /api/v1/intent-decisions/summary    → tallied summary (MUST precede /:id)
 * - GET    /api/v1/intent-decisions/:id        → single record
 *
 * Runtime Contract rules applied:
 * - Rule 1: parsed JSON body treated as `unknown` (ERR-001)
 * - Rule 2: enum fields validated via core type guards, never `as` (ERR-001/ERR-005)
 * - Rule 3: required fields fail loud → 400 with reason (ERR-009/ERR-010)
 * - Rule 5: `Object.hasOwn()` for untrusted object keys (ERR-013)
 * - Rule 9: every degraded path carries reason + nextAction (ERR-002)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isIntentTensionSource,
  isEvidenceStrength,
  isIntentRelatedField,
  isSuggestedOwnerAction,
} from '@principles/core/runtime-v2';
import type {
  IntentDecisionInput,
  IntentRelatedField,
} from '@principles/core/runtime-v2';
import { IntentDecisionModel, type IntentDecisionRecordResultModel } from '../models/IntentDecisionModel.js';
import { sendJson, sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';
import { parseQuery, readBody } from '../utils/request.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';

// Per-workspace model cache (same pattern as approvals.ts). IntentDecisionModel
// holds workspaceDir, so each workspace needs its own instance.
const models = new Map<string, IntentDecisionModel>();

function getModel(workspaceDir: string): IntentDecisionModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new IntentDecisionModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function parseJsonBody(body: string, res: ServerResponse): Record<string, unknown> | null {
  const raw = tryParseJson(body);
  if (raw === undefined) {
    sendBadRequest(res, 'Invalid JSON body');
    return null;
  }
  if (!isRecord(raw)) {
    sendBadRequest(res, 'Request body must be a JSON object');
    return null;
  }
  return raw;
}

/**
 * Feature flag gate: `intent_engineering` MUST be enabled for any
 * intent-decisions operation. Fail-closed with a structured reason (ERR-002).
 * Returns true when the caller may proceed.
 */
function checkFlag(workspaceDir: string, res: ServerResponse): boolean {
  const configResult = loadPdConfig(workspaceDir);
  const flagsResult = computeFlagsFromLoadResult(configResult);
  const flagEnabled = flagsResult.flags.intent_engineering?.enabled === true;
  if (!flagEnabled) {
    sendError(
      res,
      403,
      'Feature intent_engineering is disabled',
      'Feature intent_engineering is disabled',
      {
        reason: 'flag_disabled',
        nextAction: 'Enable intent_engineering flag to use this endpoint',
      },
    );
    return false;
  }
  return true;
}

/**
 * Validate an untrusted JSON object into a fully-typed IntentDecisionInput.
 * Returns null (after sending a 400) on any validation failure.
 *
 * Required fields are destructured first (satisfies prefer-destructuring) then
 * narrowed by type guards on the LOCAL binding — this keeps TypeScript's control
 * flow narrowing reliable across subsequent function calls (Rule 2: no `as`).
 * Optional fields use Object.hasOwn to distinguish present-vs-absent (Rule 5).
 */
function validateInput(parsed: Record<string, unknown>, res: ServerResponse): IntentDecisionInput | null {
  const { id, source, evidenceStrength, ownerAction, relatedIntentFields, evidenceRefs } = parsed;

  // id — required non-empty string
  if (typeof id !== 'string' || id === '') {
    sendBadRequest(res, 'id is required and must be a non-empty string');
    return null;
  }
  // source — required IntentTensionSource (Rule 2: type guard, no `as`)
  if (!isIntentTensionSource(source)) {
    sendBadRequest(res, 'source is required and must be a valid IntentTensionSource');
    return null;
  }
  // evidenceStrength — required EvidenceStrength
  if (!isEvidenceStrength(evidenceStrength)) {
    sendBadRequest(res, 'evidenceStrength is required and must be a valid EvidenceStrength');
    return null;
  }
  // ownerAction — required SuggestedOwnerAction
  if (!isSuggestedOwnerAction(ownerAction)) {
    sendBadRequest(res, 'ownerAction is required and must be a valid SuggestedOwnerAction');
    return null;
  }
  // relatedIntentFields — required IntentRelatedField[] (Rule 4: element-wise)
  if (!Array.isArray(relatedIntentFields)) {
    sendBadRequest(res, 'relatedIntentFields is required and must be an array');
    return null;
  }
  const typedFields: IntentRelatedField[] = [];
  for (const field of relatedIntentFields) {
    if (!isIntentRelatedField(field)) {
      sendBadRequest(res, 'relatedIntentFields contains an invalid IntentRelatedField: ' + String(field));
      return null;
    }
    typedFields.push(field);
  }
  // evidenceRefs — required string[] (Rule 4: element-wise)
  if (!Array.isArray(evidenceRefs)) {
    sendBadRequest(res, 'evidenceRefs is required and must be an array');
    return null;
  }
  const typedRefs: string[] = [];
  for (const ref of evidenceRefs) {
    if (typeof ref !== 'string') {
      sendBadRequest(res, 'evidenceRefs must contain only strings');
      return null;
    }
    typedRefs.push(ref);
  }

  // Optional string fields — validated only when present (Rule 5: Object.hasOwn)
  const optionalStringFields = ['painId', 'taskId', 'runId', 'intentDocHash', 'note'] as const;
  const optional: Record<string, string | undefined> = {};
  for (const key of optionalStringFields) {
    if (Object.hasOwn(parsed, key)) {
      const value = parsed[key];
      if (typeof value !== 'string') {
        sendBadRequest(res, key + ' must be a string when present');
        return null;
      }
      optional[key] = value;
    }
  }

  return {
    id,
    source,
    evidenceStrength,
    ownerAction,
    relatedIntentFields: typedFields,
    evidenceRefs: typedRefs,
    painId: optional.painId,
    taskId: optional.taskId,
    runId: optional.runId,
    intentDocHash: optional.intentDocHash,
    note: optional.note,
  };
}

/**
 * Map a model-level failure (IntentDecisionRecordResultModel ok:false) to an
 * HTTP error with reason + nextAction (Rule 9).
 */
function sendModelFailure(res: ServerResponse, result: Extract<IntentDecisionRecordResultModel, { ok: false }>): void {
  if (result.reason === 'state_db_not_found') {
    sendError(res, 409, 'workspace_not_initialized', result.reason, {
      reason: result.reason,
      nextAction: result.nextAction,
    });
  } else {
    sendError(res, 500, 'intent_decision_store_error', result.reason, {
      reason: result.reason,
      nextAction: result.nextAction,
    });
  }
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleIntentDecisionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  // Feature flag gate applies to every method on this route.
  if (!checkFlag(workspaceDir, res)) return;

  const model = getModel(workspaceDir);

  // POST /api/v1/intent-decisions — create / idempotent replay
  if (req.method === 'POST' && (subPath === '' || subPath === '/')) {
    try {
      const body = await readBody(req);
      const parsed = parseJsonBody(body, res);
      if (!parsed) return;
      const input = validateInput(parsed, res);
      if (!input) return;
      const result = await model.record(input);
      if (!result.ok) {
        sendModelFailure(res, result);
        return;
      }
      if (result.created) {
        // Fresh create → 201 (sendJson with explicit status; sendSuccess is 200-only).
        sendJson(res, 201, { success: true, data: result.record });
      } else {
        // Idempotent replay → 200 with the pre-existing record.
        sendSuccess(res, result.record);
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (message === 'Request body too large') {
        sendError(res, 413, 'payload_too_large', message);
      } else {
        sendError(res, 500, 'intent_decision_create_error', message);
      }
    }
    return;
  }

  // GET /api/v1/intent-decisions — list by painId OR taskId (exactly one required)
  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    try {
      const query = parseQuery(req.url ?? '');
      const hasPainId = Object.hasOwn(query, 'painId');
      const hasTaskId = Object.hasOwn(query, 'taskId');
      if (!hasPainId && !hasTaskId) {
        sendBadRequest(res, 'Either painId or taskId query parameter is required');
        return;
      }
      if (hasPainId && hasTaskId) {
        sendBadRequest(res, 'Provide either painId or taskId, not both');
        return;
      }
      if (hasPainId) {
        const { painId } = query;
        if (!painId) {
          sendBadRequest(res, 'painId must not be empty');
          return;
        }
        const items = await model.listByPainId(painId);
        sendSuccess(res, items);
      } else {
        const { taskId } = query;
        if (!taskId) {
          sendBadRequest(res, 'taskId must not be empty');
          return;
        }
        const items = await model.listByTaskId(taskId);
        sendSuccess(res, items);
      }
    } catch (err: unknown) {
      sendError(res, 500, 'intent_decision_list_error', getErrorMessage(err));
    }
    return;
  }

  // GET /api/v1/intent-decisions/summary — MUST be matched before /:id
  if (req.method === 'GET' && subPath === '/summary') {
    try {
      const summary = await model.getSummary();
      sendSuccess(res, summary);
    } catch (err: unknown) {
      sendError(res, 500, 'intent_decision_summary_error', getErrorMessage(err));
    }
    return;
  }

  // GET /api/v1/intent-decisions/:id — single record
  const detailMatch = /^[/]([^/]+)$/.exec(subPath);
  if (req.method === 'GET' && detailMatch) {
    const [, rawId] = detailMatch;
    if (!rawId) {
      sendError(res, 400, 'invalid_id', 'Intent decision id is missing');
      return;
    }
    let recordId: string;
    try {
      recordId = decodeURIComponent(rawId);
    } catch {
      sendError(res, 400, 'invalid_id', 'Intent decision id contains invalid URI encoding');
      return;
    }
    try {
      const record = await model.getById(recordId);
      if (!record) {
        sendNotFound(res, 'Intent decision ' + recordId + ' not found');
        return;
      }
      sendSuccess(res, record);
    } catch (err: unknown) {
      sendError(res, 500, 'intent_decision_detail_error', getErrorMessage(err));
    }
    return;
  }

  sendNotFound(res, 'Route /api/v1/intent-decisions' + subPath + ' not found');
}

/**
 * Dispose hook for graceful shutdown — clears the per-workspace model cache.
 */
export function disposeIntentDecisionModels(): void {
  models.clear();
}
