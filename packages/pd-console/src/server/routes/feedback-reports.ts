// feedback-reports.ts
// Server route for /api/feedback/reports/*
// Implements the Console-first feedback draft storage described in
// docs/superpowers/specs/2026-05-31-feedback-channel-design.md.
//
// The route is a local-only CRUD over <workspaceDir>/.pd/feedback/drafts/.
// It MUST NOT reach the network and MUST NOT auto-submit anything.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createFeedbackReport,
  type FeedbackReport,
} from '@principles/core/runtime-v2/feedback';
import {
  FeedbackReportConsoleModel,
  type FeedbackReportDraftSummary,
} from '../models/FeedbackReportConsoleModel.js';
import {
  sendSuccess,
  sendError,
  sendNotFound,
  sendMethodNotAllowed,
  sendBadRequest,
} from '../utils/response.js';

const models = new Map<string, FeedbackReportConsoleModel>();

function getModel(workspaceDir: string): FeedbackReportConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new FeedbackReportConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_BODY = 256 * 1024; // 256 KiB — drafts are bounded by core contract
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        resolve({ ok: false, error: 'request body exceeds 256 KiB limit' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({ ok: true, value: {} });
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch (err) {
        resolve({
          ok: false,
          error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Handle requests to `/api/feedback/reports*` for the given workspace.
 * Routes:
 *   POST   /api/feedback/reports        — create draft from input + diagnostics
 *   GET    /api/feedback/reports        — list draft summaries
 *   GET    /api/feedback/reports/:id    — fetch a single draft
 *   DELETE /api/feedback/reports/:id    — delete a draft
 */
export type FeedbackReportsContext = {
  workspaceDir: string;
  subPath: string;
  featureFlags?: Record<string, { enabled: boolean }>;
};

export async function handleFeedbackReportsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: FeedbackReportsContext,
): Promise<void> {
  const { workspaceDir, subPath } = ctx;
  const model = getModel(workspaceDir);
  const method = req.method ?? 'GET';

  // List / create
  if (subPath === '' || subPath === '/') {
    if (method === 'GET') {
      try {
        const result = await model.list();
        if (!result.ok) {
          sendError(res, 500, 'feedback_reports_list_failed', result.error);
          return;
        }
        sendSuccess<{ drafts: FeedbackReportDraftSummary[] }>(res, { drafts: result.drafts });
      } catch (err) {
        sendError(res, 500, 'feedback_reports_list_error', errorMessage(err));
      }
      return;
    }
    if (method === 'POST') {
      // Feature flag gate — feedback_channel must be enabled to create drafts
      if (
        ctx.featureFlags
        && Object.hasOwn(ctx.featureFlags, 'feedback_channel')
      ) {
        const feedbackChannel = ctx.featureFlags.feedback_channel;
        if (feedbackChannel && !feedbackChannel.enabled) {
          sendError(
            res,
            403,
            'feedback_channel_disabled',
            'feedback_channel feature flag is disabled. Enable feedback_channel in .pd/config.yaml to use feedback reports.',
          );
          return;
        }
      }

      const bodyResult = await readJsonBody(req);
      if (!bodyResult.ok) {
        sendBadRequest(res, bodyResult.error);
        return;
      }
      if (bodyResult.value === null || typeof bodyResult.value !== 'object' || Array.isArray(bodyResult.value)) {
        sendBadRequest(res, 'request body must be a JSON object with {input, diagnostics}');
        return;
      }
      const obj = bodyResult.value as Record<string, unknown>;
      const {input} = obj;
      const diagnostics = obj.diagnostics ?? {};
      const reportResult = createFeedbackReport(input, diagnostics);
      if (!reportResult.ok) {
        sendBadRequest(res, reportResult.errors.map((e) => `${e.field}: ${e.reason}`).join('; '));
        return;
      }
      const draftResult = await model.create(reportResult.report);
      if (!draftResult.ok || !draftResult.report) {
        sendError(res, 500, 'feedback_reports_create_failed', draftResult.error ?? 'unknown error');
        return;
      }
      const r: FeedbackReport = draftResult.report;
      sendSuccess<{ id: string; createdAt: string; report: FeedbackReport }>(res, {
        id: r.id,
        createdAt: r.createdAt,
        report: r,
      });
      return;
    }
    sendMethodNotAllowed(res);
    return;
  }

  // Single draft: /:id
  const id = subPath.replace(/^\//, '');
  if (id.length === 0) {
    sendNotFound(res, `Route /api/feedback/reports${subPath} not found`);
    return;
  }

  if (method === 'GET') {
    try {
      const result = await model.get(id);
      if (!result.ok) {
        if (result.errorCode === 'NOT_FOUND') {
          sendNotFound(res, result.error);
        } else {
          sendError(res, 400, 'feedback_reports_get_failed', result.error);
        }
        return;
      }
      sendSuccess<{ report: FeedbackReport }>(res, { report: result.report as FeedbackReport });
    } catch (err) {
      sendError(res, 500, 'feedback_reports_get_error', errorMessage(err));
    }
    return;
  }

  if (method === 'DELETE') {
    try {
      const result = await model.delete(id);
      if (!result.ok) {
        sendError(res, 500, 'feedback_reports_delete_failed', result.error);
        return;
      }
      sendSuccess<{ deleted: boolean }>(res, { deleted: true });
    } catch (err) {
      sendError(res, 500, 'feedback_reports_delete_error', errorMessage(err));
    }
    return;
  }

  sendMethodNotAllowed(res);
}

export function disposeFeedbackReportModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
