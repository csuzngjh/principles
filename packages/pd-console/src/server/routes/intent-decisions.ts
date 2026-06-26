/**
 * IntentDecisions route — HTTP surface for IntentDecisionRecord (PRI-470, SPEC §21.7).
 *
 * Endpoints (all gated by the `intent_engineering` feature flag):
 * - POST   /api/v1/intent-decisions                       → create (201) or idempotent replay (200)
 * - GET    /api/v1/intent-decisions?painId=…              → list by painId
 * - GET    /api/v1/intent-decisions?taskId=…              → list by taskId
 * - GET    /api/v1/intent-decisions/summary               → tallied summary (MUST precede /:id)
 * - GET    /api/v1/intent-decisions/:id                   → single record
 * - POST   /api/v1/intent-decisions/:id/follow-up         → dispatch governed follow-up (PRI-471)
 *
 * PRI-471 follow-up types (SPEC §22.1.4):
 * - link_candidate         — record which existing principle candidate the Owner
 *                            chose to link. Does NOT create a candidate.
 * - guide_rulehost         — returns the CLI guidance for promoting to RuleHost.
 *                            Does NOT create a rule or approval directly.
 * - generate_patch_proposal — generates a read-only Intent Patch Proposal and
 *                            records its id on the decision. Does NOT modify
 *                            `.principles/INTENT.md`.
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
  generateIntentPatchProposal,
} from '@principles/core/runtime-v2';
import type {
  IntentDecisionInput,
  IntentRelatedField,
  FollowUpPatch,
} from '@principles/core/runtime-v2';
import { IntentDecisionModel, type IntentDecisionRecordResultModel, type FollowUpDispatchResultModel } from '../models/IntentDecisionModel.js';
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

// ── PRI-471 follow-up input validation ────────────────────────────────────────

type FollowUpType = 'link_candidate' | 'guide_rulehost' | 'generate_patch_proposal';

interface FollowUpInput {
  type: FollowUpType;
  candidateId: string; // only meaningful when type === 'link_candidate'
}

const FOLLOW_UP_TYPES: ReadonlySet<FollowUpType> = new Set([
  'link_candidate',
  'guide_rulehost',
  'generate_patch_proposal',
]);

/**
 * Validate the body of POST /api/v1/intent-decisions/:id/follow-up.
 *
 * Body shape: `{ type: 'link_candidate' | 'guide_rulehost' | 'generate_patch_proposal', candidateId?: string }`
 *
 * - `type` is required and must be one of the three allowed values (Rule 2).
 * - `candidateId` is REQUIRED when `type === 'link_candidate'` (Rule 3: fail loud).
 * - `candidateId` is IGNORED for other types (not an error — the frontend may
 *   send it as part of a generic payload).
 */
function validateFollowUpInput(parsed: Record<string, unknown>, res: ServerResponse): FollowUpInput | null {
  if (!Object.hasOwn(parsed, 'type')) {
    sendBadRequest(res, 'type is required');
    return null;
  }
  const { type } = parsed;
  if (typeof type !== 'string' || !FOLLOW_UP_TYPES.has(type as FollowUpType)) {
    sendBadRequest(res, 'type must be one of: link_candidate, guide_rulehost, generate_patch_proposal');
    return null;
  }
  const typedType = type as FollowUpType;

  // candidateId: required for link_candidate, optional otherwise.
  if (typedType === 'link_candidate') {
    if (!Object.hasOwn(parsed, 'candidateId')) {
      sendBadRequest(res, 'candidateId is required when type is link_candidate');
      return null;
    }
    const { candidateId } = parsed;
    if (typeof candidateId !== 'string') {
      sendBadRequest(res, 'candidateId must be a string when type is link_candidate');
      return null;
    }
    // Normalize at the trust boundary (EP-01): trim, then reject
    // whitespace-only ids so they cannot pollute the audit trail.
    const trimmed = candidateId.trim();
    if (trimmed === '') {
      sendBadRequest(res, 'candidateId must be a non-empty string when type is link_candidate');
      return null;
    }
    return { type: typedType, candidateId: trimmed };
  }

  // For other types, candidateId is optional and ignored if present.
  // We do not validate its type here — it is simply not read.
  return { type: typedType, candidateId: '' };
}

/**
 * Map a follow-up model-level failure to an HTTP error with reason + nextAction (Rule 9).
 */
function sendFollowUpModelFailure(res: ServerResponse, result: Extract<FollowUpDispatchResultModel, { ok: false }>): void {
  if (result.reason === 'decision_not_found') {
    sendNotFound(res, result.nextAction);
  } else if (result.reason === 'state_db_not_found') {
    sendError(res, 409, 'workspace_not_initialized', result.reason, {
      reason: result.reason,
      nextAction: result.nextAction,
    });
  } else {
    sendError(res, 500, 'intent_decision_follow_up_store_error', result.reason, {
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
      // Response envelope matches IntentDecisionResultData: { record, created }.
      // The `created` flag lets the frontend distinguish a fresh write from a
      // replay (200 vs 201 HTTP status also conveys this).
      const responseData = { record: result.record, created: result.created };
      if (result.created) {
        // Fresh create → 201 (sendJson with explicit status; sendSuccess is 200-only).
        sendJson(res, 201, { success: true, data: responseData });
      } else {
        // Idempotent replay → 200 with the pre-existing record.
        sendSuccess(res, responseData);
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

  // POST /api/v1/intent-decisions/:id/follow-up — PRI-471 governed follow-up
  // (SPEC §22.1.4). MUST be matched before the catch-all 404 below.
  const followUpMatch = /^[/]([^/]+)[/]follow-up$/.exec(subPath);
  if (req.method === 'POST' && followUpMatch) {
    try {
      const [, rawId] = followUpMatch;
      if (!rawId) {
        sendError(res, 400, 'invalid_id', 'Intent decision id is missing');
        return;
      }
      let decisionId: string;
      try {
        decisionId = decodeURIComponent(rawId);
      } catch {
        sendError(res, 400, 'invalid_id', 'Intent decision id contains invalid URI encoding');
        return;
      }
      const body = await readBody(req);
      const parsed = parseJsonBody(body, res);
      if (!parsed) return;
      const followUpInput = validateFollowUpInput(parsed, res);
      if (!followUpInput) return;

      // ── guide_rulehost: pure guidance, no DB write ──────────────────────
      // SPEC §22.1.4: promote_to_rulehost goes through the existing RuleHost
      // candidate/approval path. PD does NOT create a rule or approval here —
      // the Owner runs the CLI command, which enqueues a code_tool_hook
      // approval that the Owner can review in the Governance Queue.
      if (followUpInput.type === 'guide_rulehost') {
        // Verify the decision exists so we don't return guidance for a
        // non-existent record (fail loud, ERR-009).
        const existing = await model.getById(decisionId);
        if (!existing) {
          sendNotFound(res, 'Intent decision ' + decisionId + ' not found');
          return;
        }
        sendSuccess(res, {
          type: 'guide_rulehost',
          cliCommand: 'pd runtime rulehost',
          note: 'Run this command in your workspace terminal. PD will create a RuleHost approval that you can review in the Governance Queue. After approval, the resulting rule candidate id can be linked back to this decision.',
          decisionId,
        });
        return;
      }

      // ── generate_patch_proposal: pure function + DB write ───────────────
      // SPEC §10 + §22.1.4: revise_intent creates a read-only patch proposal
      // that the Owner can review and manually apply. PD does NOT auto-apply
      // the patch to .principles/INTENT.md.
      if (followUpInput.type === 'generate_patch_proposal') {
        const existing = await model.getById(decisionId);
        if (!existing) {
          sendNotFound(res, 'Intent decision ' + decisionId + ' not found');
          return;
        }
        const proposal = generateIntentPatchProposal(existing);
        const patch: FollowUpPatch = { patchProposalId: proposal.id };
        const result = await model.updateFollowUp(decisionId, patch);
        if (!result.ok) {
          sendFollowUpModelFailure(res, result);
          return;
        }
        sendSuccess(res, {
          type: 'generate_patch_proposal',
          decisionId,
          record: result.record,
          patchProposal: { id: proposal.id, markdown: proposal.markdown },
        });
        return;
      }

      // ── link_candidate: record which candidate the Owner chose ─────────
      // SPEC §22.1.4: confirm_drift can link to an existing principle
      // candidate. PD does NOT create a candidate here — candidates are
      // created by the diagnostician committer during normal pain →
      // diagnosis flow. The Owner links an existing candidate so the audit
      // trail records which candidate the Owner chose to sediment this
      // decision into.
      if (followUpInput.type === 'link_candidate') {
        const { candidateId } = followUpInput;
        const patch: FollowUpPatch = { resultingCandidateId: candidateId };
        const result = await model.updateFollowUp(decisionId, patch);
        if (!result.ok) {
          sendFollowUpModelFailure(res, result);
          return;
        }
        sendSuccess(res, {
          type: 'link_candidate',
          decisionId,
          record: result.record,
          linkedCandidateId: candidateId,
        });
        return;
      }

      // Unreachable: validateFollowUpInput already narrowed the union.
      // Defensive guard for future enum additions.
      sendBadRequest(res, 'Unknown follow-up type: ' + String(followUpInput.type));
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (message === 'Request body too large') {
        sendError(res, 413, 'payload_too_large', message);
      } else {
        sendError(res, 500, 'intent_decision_follow_up_error', message);
      }
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
