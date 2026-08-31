/**
 * PRI-629 — /api/v1/governance/owner-decisions 路由。
 *
 *   GET  /api/v1/governance/owner-decisions            — 统一 Owner Inbox 投影
 *   POST /api/v1/governance/owner-decisions/:taskId/resolve — Owner 裁决
 *
 * 安全模型（SPEC §28/§29）:
 *   - 全局 console token 认证由 server/index.ts 统一强制;
 *   - 身份从 server-side auth context 推导（configured_owner 优先，其次
 *     console operator），body 里的身份字段一律不信任;
 *   - effectiveDecision / eligibility 全部服务端重读 durable facts 判定;
 *   - stale 防护: reviewKey + expected* 事实快照逐字段比对（409）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRuntimeStateHandle,
  applyOwnerResolution,
} from '@principles/core/runtime-v2';
import type { OwnerResolutionOutcome } from '@principles/core/runtime-v2';
import { OwnerDecisionConsoleModel } from '../models/OwnerDecisionConsoleModel.js';
import { sendSuccess, sendError, sendMethodNotAllowed, sendBadRequest } from '../utils/response.js';
import { readBody } from '../utils/request.js';

const models = new Map<string, OwnerDecisionConsoleModel>();

function getModel(workspaceDir: string): OwnerDecisionConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new OwnerDecisionConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

export interface OwnerDecisionRouteContext {
  workspaceDir: string;
  /** server-side auth context 推导的身份（SPEC §29 — 不信任 body） */
  ownerIdentity: { ownerId: string; credentialId?: string };
}

const RESOLVE_ACTIONS = new Set(['accept_current', 'revise_once', 'reject_current']);

interface ResolveRequestBody {
  action: 'accept_current' | 'revise_once' | 'reject_current';
  reviewKey: string;
  expectedRevisionEpoch: number;
  expectedSourceRunId: string;
  expectedSourceArtifactId: string;
  expectedSourceArtifactHash: string;
  expectedEvidenceDigest: string;
  acknowledgement?: {
    kind: 'partial_evidence';
    acknowledged: true;
    note?: string;
  };
  ownerInstruction?: string | null;
}

/** rc-1/rc-2/rc-3: body 按未知值逐字段校验，非法即 400 fail-loud。 */
function parseResolveBody(raw: unknown): { ok: true; body: ResolveRequestBody } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.action !== 'string' || !RESOLVE_ACTIONS.has(b.action)) {
    return { ok: false, error: `action must be one of accept_current/revise_once/reject_current, got ${String(b.action)}` };
  }
  for (const field of ['reviewKey', 'expectedSourceRunId', 'expectedSourceArtifactId', 'expectedSourceArtifactHash', 'expectedEvidenceDigest'] as const) {
    const v = b[field];
    if (typeof v !== 'string' || v.trim() === '') {
      return { ok: false, error: `${field} must be a non-empty string.` };
    }
  }
  if (typeof b.expectedRevisionEpoch !== 'number' || !Number.isInteger(b.expectedRevisionEpoch) || b.expectedRevisionEpoch < 0) {
    return { ok: false, error: 'expectedRevisionEpoch must be a non-negative integer.' };
  }
  if (b.ownerInstruction !== undefined && b.ownerInstruction !== null
    && (typeof b.ownerInstruction !== 'string' || b.ownerInstruction.length > 600)) {
    return { ok: false, error: 'ownerInstruction must be a string of at most 600 characters (or null).' };
  }
  let acknowledgement: ResolveRequestBody['acknowledgement'];
  if (b.acknowledgement !== undefined) {
    if (typeof b.acknowledgement !== 'object' || b.acknowledgement === null
      || Array.isArray(b.acknowledgement)) {
      return { ok: false, error: 'acknowledgement must be an object.' };
    }
    const rawAcknowledgement = b.acknowledgement as Record<string, unknown>;
    if (rawAcknowledgement.kind !== 'partial_evidence' || rawAcknowledgement.acknowledged !== true) {
      return { ok: false, error: 'acknowledgement must explicitly acknowledge partial_evidence.' };
    }
    if (rawAcknowledgement.note !== undefined
      && (typeof rawAcknowledgement.note !== 'string' || rawAcknowledgement.note.length > 600)) {
      return { ok: false, error: 'acknowledgement.note must be at most 600 characters.' };
    }
    acknowledgement = {
      kind: 'partial_evidence',
      acknowledged: true,
      ...(typeof rawAcknowledgement.note === 'string' ? { note: rawAcknowledgement.note } : {}),
    };
  }
  const {reviewKey} = b;
  const {expectedSourceRunId} = b;
  const {expectedSourceArtifactId} = b;
  const {expectedSourceArtifactHash} = b;
  const {expectedEvidenceDigest} = b;
  if (typeof reviewKey !== 'string' || typeof expectedSourceRunId !== 'string'
    || typeof expectedSourceArtifactId !== 'string' || typeof expectedSourceArtifactHash !== 'string'
    || typeof expectedEvidenceDigest !== 'string') {
    return { ok: false, error: 'unreachable: string fields validated above' };
  }
  return {
    ok: true as const,
    body: {
      action: b.action as ResolveRequestBody['action'],
      reviewKey,
    expectedRevisionEpoch: b.expectedRevisionEpoch,
    expectedSourceRunId,
    expectedSourceArtifactId,
    expectedSourceArtifactHash,
    expectedEvidenceDigest,
      ...(acknowledgement !== undefined ? { acknowledgement } : {}),
      ...(typeof b.ownerInstruction === 'string' ? { ownerInstruction: b.ownerInstruction } : {}),
    },
  };
}

/** OwnerResolutionOutcome → HTTP 响应映射（cli-6: 结构化 reason + nextAction）。 */
function sendOutcome(res: ServerResponse, outcome: OwnerResolutionOutcome): void {
  switch (outcome.status) {
    case 'resolved':
      sendSuccess(res, {
        status: 'resolved',
        resolutionId: outcome.resolutionId,
        reviewKey: outcome.reviewKey,
        action: outcome.action,
        applied: outcome.applied,
        ...(outcome.effectiveDecision !== undefined ? { effectiveDecision: outcome.effectiveDecision } : {}),
        ...(outcome.targetTaskId !== undefined ? { targetTaskId: outcome.targetTaskId } : {}),
        runnerWillApply: outcome.runnerWillApply,
        nextAction: outcome.applied
          ? 'Resolution applied. Refresh the governance focus.'
          : 'Resolution recorded durably; the pipeline runner will apply it without re-invoking the LLM. Refresh the governance focus.',
      });
      return;
    case 'not_found':
      sendError(res, 404, 'task_not_found', 'Owner decision task not found.');
      return;
    case 'metadata_invalid':
      sendError(res, 409, 'metadata_invalid', 'Task metadata failed PI hydration; refusing to resolve.', {
        nextAction: 'Inspect the task metadata: pd runtime internalization integrity --json',
      });
      return;
    case 'not_decision_capable':
      sendError(res, 409, 'not_decision_capable', 'This task is not currently decision-capable.', {
        nextAction: 'Refresh the governance focus — the decision facts may have changed.',
        blockers: outcome.blockers,
      });
      return;
    case 'stale_owner_decision':
      sendError(res, 409, 'stale_owner_decision', 'The durable decision facts changed since this item was rendered. The decision was NOT applied.', {
        nextAction: 'Refresh the governance focus and decide again on the current version.',
      });
      return;
    case 'evidence_acknowledgement_required':
      sendError(res, 409, 'evidence_acknowledgement_required', 'Accepting partial evidence requires explicit acknowledgement.', {
        nextAction: 'Review the missing evidence, acknowledge it explicitly, then submit again.',
      });
      return;
    case 'already_resolved':
      sendError(res, 409, 'already_resolved', `This decision was already resolved with action '${outcome.existingAction}'.`, {
        nextAction: 'Refresh the governance focus.',
        existingAction: outcome.existingAction,
      });
      return;
    case 'revise_target_unresolved':
      sendError(res, 409, 'revise_target_unresolved', 'The revision target task could not be resolved from the lineage.', {
        nextAction: 'Inspect the task lineage; this is a recovery-class failure.',
      });
      return;
    case 'revise_reopen_failed':
      sendError(res, 409, 'revise_reopen_failed', `Reopening the revision target failed: ${outcome.reason}`, {
        nextAction: 'Retry after the target task is no longer in flight, or inspect the task states.',
        reason: outcome.reason,
      });
      return;
    case 'cas_conflict':
      sendError(res, 409, 'cas_conflict', 'Concurrent write detected while recording the resolution.', {
        nextAction: 'Retry the request — the operation is idempotent.',
      });
      return;
    default: {
      // exhaustive guard
      const exhaustive: never = outcome;
      sendError(res, 500, 'owner_resolution_error', `Unhandled outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function handleOwnerDecisionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OwnerDecisionRouteContext & { subPath: string },
): Promise<void> {
  const { workspaceDir, subPath, ownerIdentity } = ctx;
  const method = req.method ?? 'GET';

  // GET /api/v1/governance/owner-decisions — list
  if (subPath === '' || subPath === '/') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    try {
      const result = await getModel(workspaceDir).listOwnerDecisionItems();
      sendSuccess(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'owner_decisions_list_error', message, {
        nextAction: 'Inspect the workspace state (.pd/state.db) and retry.',
      });
    }
    return;
  }

  // POST /api/v1/governance/owner-decisions/:taskId/resolve
  const resolveMatch = /^\/([^/]+)\/resolve$/.exec(subPath);
  if (resolveMatch) {
    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- match group is always present
    const taskId = decodeURIComponent(resolveMatch[1]!);
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      sendBadRequest(res, 'Request body must be valid JSON.');
      return;
    }
    const parsed = parseResolveBody(body);
    if (!parsed.ok) {
      sendBadRequest(res, parsed.error);
      return;
    }

    // 应用走 core 单一服务（writable RuntimeStateManager handle）
    const handle = await createRuntimeStateHandle({ workspaceDir });
    try {
      const outcome = await applyOwnerResolution(
        { stateManager: handle.stateManager },
        { taskId, request: parsed.body, identity: ownerIdentity },
      );
      sendOutcome(res, outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'owner_resolution_error', message, {
        nextAction: 'Inspect the workspace state (.pd/state.db) and retry.',
      });
    } finally {
      await handle.close();
    }
    return;
  }

  sendError(res, 404, 'not_found', `Route /api/v1/governance/owner-decisions${subPath} not found`);
}
