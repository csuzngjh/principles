/**
 * PD v2 Phase 1 — /api/v1/evidence/outcomes 路由（ADR-0027 §2.3, SPEC §13.4）。
 *
 *   POST /api/v1/evidence/outcomes — Owner 结果反馈入账
 *
 * 最小获授权事实入口：Owner 可以对一个已存在的 Behavior Episode 提交
 * 明确的结果观察/反馈。安全模型（复用 owner-decisions 的模式）：
 *   - 全局 console token 认证由 server/index.ts 统一强制；
 *   - Owner 身份从 server-side auth context 推导，body 中的身份字段一律
 *     不信任 —— actorId 由服务端写入，请求方无法自称；
 *   - 封闭字段集：任何 runtime 证明字段（runtime_verified / proof /
 *     activation 决策等）都不存在于此 contract，LLM/Agent 无法伪装成
 *     Runtime 或 Owner 来源；
 *   - 写入走共享 host-runtime ingress（SPEC §13.7 单一入口），owner 来源
 *     批次 sourceKind=owner_console_input。
 *
 * 该入口只记录事实：它不是原则 authority，不触发任何治理动作
 * （不调用 ActivationDispatcher / intake / 生命周期服务）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mintObservationKey } from '@principles/core/runtime-v2';
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import { sendSuccess, sendError, sendMethodNotAllowed, sendBadRequest } from '../utils/response.js';
import { readBody } from '../utils/request.js';

const ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(['episodeKey', 'observationSummary', 'feedbackText']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface OutcomeRequestBody {
  episodeKey: string;
  observationSummary: string;
  feedbackText?: string;
}

/** rc-1/rc-2/rc-3: closed field set, bounded strings, fail-loud 400s. */
function parseOutcomeBody(raw: unknown): { ok: true; body: OutcomeRequestBody } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_BODY_KEYS.has(key)) {
      return { ok: false, error: `Unknown field "${key}" — the Owner outcome contract accepts only episodeKey, observationSummary and feedbackText.` };
    }
  }
  if (typeof raw.episodeKey !== 'string' || raw.episodeKey.trim() === '' || raw.episodeKey.length > 256) {
    return { ok: false, error: 'episodeKey must be a non-empty string of at most 256 characters.' };
  }
  if (typeof raw.observationSummary !== 'string' || raw.observationSummary.trim() === '' || raw.observationSummary.length > 400) {
    return { ok: false, error: 'observationSummary must be a non-empty string of at most 400 characters.' };
  }
  if (raw.feedbackText !== undefined
    && (typeof raw.feedbackText !== 'string' || raw.feedbackText.length > 400)) {
    return { ok: false, error: 'feedbackText must be a string of at most 400 characters (or omitted).' };
  }
  return {
    ok: true,
    body: {
      episodeKey: raw.episodeKey.trim(),
      observationSummary: raw.observationSummary.trim(),
      ...(typeof raw.feedbackText === 'string' && raw.feedbackText.length > 0 ? { feedbackText: raw.feedbackText } : {}),
    },
  };
}

export interface EvidenceOutcomeRouteContext {
  workspaceDir: string;
  /** Only present after both Console authentication and Owner identity verification. */
  ownerIdentity: { ownerId: string; credentialId: string } | null;
}

export async function handleEvidenceOutcomesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: EvidenceOutcomeRouteContext,
): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  // 身份门槛与 owner-decisions 一致：没有已验证 Owner 身份就拒绝写。
  if (!ctx.ownerIdentity) {
    sendError(
      res, 403, 'owner_authentication_required',
      'Recording an Owner outcome requires a verified Owner identity (console token auth enabled and owner identity resolved).',
    );
    return;
  }
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(await readBody(req));
  } catch {
    sendBadRequest(res, 'Request body must be valid JSON.');
    return;
  }
  const parsed = parseOutcomeBody(rawBody);
  if (!parsed.ok) {
    sendBadRequest(res, parsed.error);
    return;
  }
  const ingress = getInterventionEvidenceIngress();
  const { ownerId } = ctx.ownerIdentity;
  // Episode-key-scoped counter: the Owner console can submit a corrected
  // observation for the same episode — corrections append (idempotent per
  // identical content), history is preserved (ADR-0027 §2.2).
  const observationKey = mintObservationKey(['owner', 'outcome', parsed.body.episodeKey]);
  const result = ingress.appendObservationBatch({
    workspaceDir: ctx.workspaceDir,
    batch: {
      evidenceScopeId: ingress.evidenceScopeIdFor(ctx.workspaceDir),
      sourceKind: 'owner_console_input',
      adapterVersion: 'pd-console@2',
      recordedAt: new Date().toISOString(),
      observations: [
        {
          observationKey,
          sourceLocator: 'console:evidence-outcomes',
          kind: 'outcome',
          nativeRefs: { hostKind: 'openclaw' },
          episodeKey: parsed.body.episodeKey,
          payload: {
            outcomeSource: 'owner_feedback',
            observationSummary: parsed.body.observationSummary,
            ...(parsed.body.feedbackText !== undefined ? { feedbackText: parsed.body.feedbackText } : {}),
            actorId: ownerId,
          },
        },
      ],
    },
  });
  if (!result.ok) {
    sendError(
      res, 503, 'evidence_outcome_write_failed',
      result.reason ?? 'evidence write failed',
      { nextAction: result.nextAction ?? 'Retry; the console is a derived write path and no governance state changed.' },
    );
    return;
  }
  sendSuccess(res, {
    status: 'recorded',
    observationKey,
    insertedCount: result.insertedCount ?? 0,
    duplicateCount: result.duplicateCount ?? 0,
    // The proof statement of this record: the Owner supplied this feedback —
    // it is NOT an independently measured environment result.
    provenance: 'owner_report',
  });
}
