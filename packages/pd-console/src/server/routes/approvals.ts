import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApprovalStatus, InternalizationChannel } from '@principles/core/runtime-v2';
import { ApprovalsConsoleModel } from '../models/ApprovalsConsoleModel.js';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';
import { parseQuery, readBody } from '../utils/request.js';

const models = new Map<string, ApprovalsConsoleModel>();

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

/* eslint-disable @typescript-eslint/max-params */
export async function handleApprovalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const model = getModel(workspaceDir);

  // GET /api/v1/approvals - list all approvals
  if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
    try {
      const query = parseQuery(req.url ?? '');
      const pageRaw = parseInt(query.page ?? '1', 10);
      const pageSizeRaw = parseInt(query.pageSize ?? '0', 10);
      const page = Number.isNaN(pageRaw) ? 1 : Math.max(1, pageRaw);
      const pageSize = Number.isNaN(pageSizeRaw) ? 0 : Math.min(Math.max(0, pageSizeRaw), 100);
      const result = await model.listApprovals({
        status: query.status as unknown as ApprovalStatus | undefined,
        channel: query.channel as unknown as InternalizationChannel | undefined,
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
      let parsed: { note?: string } = {};
      try {
        parsed = JSON.parse(body) as { note?: string };
      } catch {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      if (parsed.note !== undefined && typeof parsed.note !== 'string') {
        sendBadRequest(res, 'note must be a string');
        return;
      }
      const result = await model.approve(approvalId, 'operator', parsed.note);
      if (!result.ok) {
        if (result.error === 'not_found') {
          sendNotFound(res, 'Approval ' + approvalId + ' not found');
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
      let parsed: { reason?: string } = {};
      try {
        parsed = JSON.parse(body) as { reason?: string };
      } catch {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      if (!parsed.reason || typeof parsed.reason !== 'string') {
        sendBadRequest(res, 'reason is required and must be a string');
        return;
      }
      const result = await model.reject(approvalId, 'operator', parsed.reason);
      if (!result.ok) {
        if (result.error === 'not_found') {
          sendNotFound(res, 'Approval ' + approvalId + ' not found');
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
