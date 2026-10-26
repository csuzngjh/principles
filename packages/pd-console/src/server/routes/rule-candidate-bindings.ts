import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuleCandidateBindingRequest } from '@principles/core/runtime-v2';
import { RuleCandidateBindingConsoleModel } from '../models/RuleCandidateBindingConsoleModel.js';
import { readBody } from '../utils/request.js';
import { sendSuccess, sendError, sendBadRequest, sendMethodNotAllowed } from '../utils/response.js';

export interface RuleCandidateBindingRouteContext {
  workspaceDir: string;
  subPath: string;
  ownerIdentity: { ownerId: string; credentialId: string } | null;
}
function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function digest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }
function bindingBody(raw: unknown): RuleCandidateBindingRequest | null {
  const common = ['action', 'expectedRevision', 'reason', 'requestId', 'resumeOnce'];
  if (!closed(raw, [...common, 'principleId', 'expectedCandidateDigest', 'expectedPrincipleDigest'])
    || !revision(raw.expectedRevision) || !text(raw.reason, 2000) || !text(raw.requestId, 200)) return null;
  if (raw.action === 'bind' && raw.resumeOnce === true && text(raw.principleId, 128)
    && digest(raw.expectedCandidateDigest) && digest(raw.expectedPrincipleDigest)) {
    return { action: 'bind', principleId: raw.principleId, expectedRevision: raw.expectedRevision,
      expectedCandidateDigest: raw.expectedCandidateDigest, expectedPrincipleDigest: raw.expectedPrincipleDigest,
      reason: raw.reason, requestId: raw.requestId, resumeOnce: true };
  }
  if (raw.action === 'revoke' && raw.resumeOnce === false && closed(raw, common)) {
    return { action: 'revoke', expectedRevision: raw.expectedRevision, reason: raw.reason, requestId: raw.requestId, resumeOnce: false };
  }
  return null;
}
function failure(res: ServerResponse, result: { reason: string; nextAction: string }): void {
  const status = result.reason.includes('unavailable') || result.reason.includes('corrupt') ? 503
    : result.reason === 'candidate_missing' ? 404 : 409;
  // The UI surfaces `message` first (api.ts request()); carrying the reason in
  // it keeps the specific cause — stale revision, digest mismatch, ineligible
  // target — visible to the Owner instead of a generic refusal.
  sendError(res, status, result.reason, `当前材料无法完成此操作（${result.reason}）。`, { reason: result.reason, nextAction: result.nextAction });
}

export async function handleRuleCandidateBindingsRoute(req: IncomingMessage, res: ServerResponse, ctx: RuleCandidateBindingRouteContext): Promise<void> {
  // Auth precedes model construction and body parsing: a refused caller cannot create state.
  if (!ctx.ownerIdentity) {
    sendError(res, 403, 'owner_authentication_required', '请先完成控制台认证并配置 Owner 身份。', { nextAction: '在设置中确认 Owner 身份后重试。' });
    return;
  }
  const model = new RuleCandidateBindingConsoleModel(ctx.workspaceDir);
  const match = /^\/([^/]+)(?:\/(review|revise-once))?$/.exec(ctx.subPath);
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if ((ctx.subPath === '' || ctx.subPath === '/') && req.method === 'GET') {
      sendSuccess(res, await model.list()); return;
    }
    if (!match?.[1]) { sendError(res, 404, 'not_found', '未找到该关联入口。'); return; }
    const candidateId = decodeURIComponent(match[1]);
    if (match[2] === 'review') {
      if (req.method !== 'GET') { sendMethodNotAllowed(res); return; }
      const search = url.searchParams.get('search') ?? '';
      if (search.length > 200) { sendBadRequest(res, '搜索内容最多 200 字。'); return; }
      const result = await model.review(candidateId, search);
      if (result.ok) sendSuccess(res, result.review); else failure(res, result);
      return;
    }
    if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
    let raw: unknown;
    try { raw = JSON.parse(await readBody(req)); } catch { sendBadRequest(res, '请求必须是有效的 JSON。'); return; }
    if (match[2] === 'revise-once') {
      if (!closed(raw, ['expectedBindingRevision', 'expectedScribeTaskId', 'expectedTaskRevisionEpoch', 'requestId'])
        || !revision(raw.expectedBindingRevision) || raw.expectedBindingRevision < 1
        || !revision(raw.expectedTaskRevisionEpoch) || !text(raw.expectedScribeTaskId, 512) || !text(raw.requestId, 200)) {
        sendBadRequest(res, '请提交当前关联、修订任务及版本；不接受身份或批准字段。'); return;
      }
      const result = await model.revise(candidateId, { expectedBindingRevision: raw.expectedBindingRevision, expectedScribeTaskId: raw.expectedScribeTaskId,
        expectedTaskRevisionEpoch: raw.expectedTaskRevisionEpoch, requestId: raw.requestId });
      if (result.status === 'refused') failure(res, result); else sendSuccess(res, result);
      return;
    }
    const request = bindingBody(raw);
    if (!request) { sendBadRequest(res, '关联与撤回必须使用各自完整字段；不接受身份、时间或批准字段。'); return; }
    const result = await model.mutate(candidateId, request, ctx.ownerIdentity.ownerId);
    if (result.ok) sendSuccess(res, result); else failure(res, result);
  } catch {
    sendError(res, 503, 'binding_source_unavailable', '关联材料暂不可读。', { nextAction: '恢复当前工作区的数据来源后重新加载；不要假定操作已完成。' });
  }
}
