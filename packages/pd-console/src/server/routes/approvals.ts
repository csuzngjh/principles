import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApprovalStatus, InternalizationChannel } from '@principles/core/runtime-v2';
import { MVP_CHANNELS } from '@principles/core/runtime-v2';
import { ApprovalsConsoleModel, type ApproveWithActivationResult } from '../models/ApprovalsConsoleModel.js';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';
import { parseQuery, readBody } from '../utils/request.js';

const models = new Map<string, ApprovalsConsoleModel>();

const MVP_PROVEN_CHANNELS: ReadonlySet<string> = new Set<string>(MVP_CHANNELS);

const MVP_CHANNEL_LIST = MVP_CHANNELS.join(', ');

function getModel(workspaceDir: string): ApprovalsConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new ApprovalsConsoleModel(workspaceDir);
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

/* eslint-disable @typescript-eslint/max-params */
export async function handleApprovalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  // GET /api/v1/approvals - list all approvals (MVP proven channels only)
  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    try {
      const query = parseQuery(req.url ?? '');
      const pageRaw = parseInt(query.page ?? '1', 10);
      const pageSizeRaw = parseInt(query.pageSize ?? '0', 10);
      const page = Number.isNaN(pageRaw) ? 1 : Math.max(1, pageRaw);
      const pageSize = Number.isNaN(pageSizeRaw) ? 0 : Math.min(Math.max(0, pageSizeRaw), 100);
      const ALLOWED_STATUSES = new Set<string>(['pending', 'approved', 'rejected', 'cancelled']);
      const { status } = query;
      if (status !== undefined && !ALLOWED_STATUSES.has(status)) {
        sendBadRequest(res, 'Invalid status value');
        return;
      }
      const { channel } = query;
      if (channel !== undefined && !MVP_PROVEN_CHANNELS.has(channel)) {
        sendBadRequest(res, `Unsupported channel: ${channel}. MVP proven channels are: ${MVP_CHANNEL_LIST}`);
        return;
      }
      const result = await model.listApprovals({
        status: status as ApprovalStatus | undefined,
        channel: channel as InternalizationChannel | undefined,
        page,
        pageSize: pageSize > 0 ? pageSize : undefined,
      });
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'approvals_error', getErrorMessage(err));
    }
    return;
  }

  // GET /api/v1/approvals/:id - detail
  const detailMatch = /^[/]([^/]+)$/.exec(subPath);
  if (req.method === 'GET' && detailMatch) {
    const approvalId = decodeURIComponent(detailMatch[1]);
    try {
      const detail = await model.getApprovalDetail(approvalId);
      if (!detail) {
        sendNotFound(res, 'Approval ' + approvalId + ' not found');
        return;
      }
      sendSuccess(res, detail);
    } catch (err: unknown) {
      sendError(res, 500, 'approval_detail_error', getErrorMessage(err));
    }
    return;
  }

  // POST /api/v1/approvals/:id/approve
  const approveMatch = /^[/]([^/]+)[/]approve$/.exec(subPath);
  if (req.method === 'POST' && approveMatch) {
    const approvalId = decodeURIComponent(approveMatch[1]);
    try {
      const body = await readBody(req);
      const parsed = parseJsonBody(body, res);
      if (!parsed) return;
      if (Object.hasOwn(parsed, 'note') && typeof parsed.note !== 'string') {
        sendBadRequest(res, 'note must be a string');
        return;
      }

      const note = typeof parsed.note === 'string' ? parsed.note : undefined;
      const result: ApproveWithActivationResult = await model.approve(approvalId, 'operator', note);
      if (!result.ok) {
        if (result.error === 'not_found') {
          sendNotFound(res, 'Approval ' + approvalId + ' not found');
        } else if (result.error === 'unsupported_channel') {
          sendError(res, 403, 'unsupported_channel', `Cannot approve unsupported channel. Only MVP proven channels (${MVP_CHANNEL_LIST}) can be approved.`);
        } else {
          sendError(res, 409, 'conflict', 'Approval already decided: ' + (result.status ?? 'unknown'));
        }
        return;
      }
      sendSuccess(res, { record: result.record, activation: result.activation });
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (message === 'Request body too large') {
        sendError(res, 413, 'payload_too_large', message);
      } else {
        sendError(res, 500, 'approve_error', message);
      }
    }
    return;
  }

  // POST /api/v1/approvals/:id/reject
  const rejectMatch = /^[/]([^/]+)[/]reject$/.exec(subPath);
  if (req.method === 'POST' && rejectMatch) {
    const approvalId = decodeURIComponent(rejectMatch[1]);
    try {
      const body = await readBody(req);
      const parsed = parseJsonBody(body, res);
      if (!parsed) return;
      if (!Object.hasOwn(parsed, 'reason') || typeof parsed.reason !== 'string') {
        sendBadRequest(res, 'reason is required and must be a string');
        return;
      }
      if (parsed.reason === '') {
        sendBadRequest(res, 'reason must not be empty');
        return;
      }

      const result = await model.reject(approvalId, 'operator', parsed.reason);
      if (!result.ok) {
        if (result.error === 'not_found') {
          sendNotFound(res, 'Approval ' + approvalId + ' not found');
        } else if (result.error === 'unsupported_channel') {
          sendError(res, 403, 'unsupported_channel', `Cannot reject unsupported channel. Only MVP proven channels (${MVP_CHANNEL_LIST}) can be operated on.`);
        } else {
          sendError(res, 409, 'conflict', 'Approval already decided: ' + (result.status ?? 'unknown'));
        }
        return;
      }
      sendSuccess(res, result.record);
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (message === 'Request body too large') {
        sendError(res, 413, 'payload_too_large', message);
      } else {
        sendError(res, 500, 'reject_error', message);
      }
    }
    return;
  }

  sendNotFound(res, 'Route /api/v1/approvals' + subPath + ' not found');
}

export function disposeApprovalsModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
