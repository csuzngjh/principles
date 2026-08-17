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
  PendingAgentDraftStore,
  type FeedbackReport,
} from '@principles/core/runtime-v2/feedback';
import { SqliteConnection } from '@principles/core/runtime-v2';
import {
  FeedbackReportConsoleModel,
  type FeedbackReportDraftSummary,
} from '../models/FeedbackReportConsoleModel.js';
import type { FeedbackChannelConfig } from '../config/pd-config-store.js';
import { probeChannels } from '../feedback/channels.js';
import { submitReport, type SubmitDeps } from '../feedback/submit-service.js';
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

// Task 13: Per-workspace PendingAgentDraftStore cache.
// PendingAgentDraftStore holds a SqliteConnection; sharing one per workspace
// keeps the connection alive across requests. The connection is writable
// (readonly: false) because markConsumed updates the pending_agent_drafts
// table. disposeFeedbackReportModels() closes every connection on shutdown.
interface DraftStoreEntry {
  store: PendingAgentDraftStore;
  connection: SqliteConnection;
}

const draftStores = new Map<string, DraftStoreEntry>();

function getDraftStore(workspaceDir: string): PendingAgentDraftStore {
  let entry = draftStores.get(workspaceDir);
  if (!entry) {
    const connection = new SqliteConnection({ workspaceDir, readonly: false });
    const store = new PendingAgentDraftStore(connection);
    entry = { store, connection };
    draftStores.set(workspaceDir, entry);
  }
  return entry.store;
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
 *   POST   /api/feedback/reports/:id/submit — submit a saved draft via a channel
 */
export type FeedbackReportsContext = {
  workspaceDir: string;
  subPath: string;
  featureFlags?: Record<string, { enabled: boolean }>;
  maintainerEmail?: string;
  channelConfig?: FeedbackChannelConfig;
  submitDeps?: SubmitDeps;
};

// Matches /:id/submit where :id is a safe report id.
const SUBMIT_SUBPATH = /^\/[A-Za-z0-9._-]+\/submit$/;
// Matches /:id/mark-sent (manual "marked as sent" for mailto/export channels).
const MARK_SENT_SUBPATH = /^\/[A-Za-z0-9._-]+\/mark-sent$/;

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
      const draftStore = getDraftStore(ctx.workspaceDir);
      const reportResult = createFeedbackReport(input, diagnostics, ctx.maintainerEmail, draftStore);
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

  // Submit: POST /api/feedback/reports/:id/submit (feature-flag gated).
  if (SUBMIT_SUBPATH.test(subPath)) {
    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    // Feature flag gate — feedback_channel off ⇒ submit endpoint 403 (spec §12).
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
          'feedback_channel feature flag is disabled. Enable feedback_channel in .pd/config.yaml to submit feedback.',
          { nextAction: '在 .pd/config.yaml 将 features.feedback_channel.enabled 改为 true' },
        );
        return;
      }
    }

    // The report id is everything before the trailing "/submit".
    const reportId = subPath.slice(1, subPath.length - '/submit'.length);

    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
      sendBadRequest(res, bodyResult.error);
      return;
    }
    if (bodyResult.value === null || typeof bodyResult.value !== 'object' || Array.isArray(bodyResult.value)) {
      sendBadRequest(res, 'request body must be a JSON object with { channel }');
      return;
    }
    const obj = bodyResult.value as Record<string, unknown>;
    const channelRaw = Object.hasOwn(obj, 'channel') ? obj.channel : undefined;
    if (channelRaw !== 'ingest' && channelRaw !== 'github') {
      sendBadRequest(res, 'channel must be one of: "ingest", "github"');
      return;
    }

    const channel = channelRaw;
    try {
      const result = await submitReport({
        model,
        reportId,
        channel,
        config: ctx.channelConfig ?? { ingestUrl: '', ingestToken: '', githubRepo: '', githubProxy: '' },
        deps: ctx.submitDeps,
      });
      if (!result.ok) {
        sendError(res, result.statusCode, result.error, result.message, { nextAction: result.nextAction });
        return;
      }
      sendSuccess(res, result);
    } catch (err) {
      // rc-9: never silence — structured error + nextAction.
      sendError(res, 500, 'feedback_reports_submit_error', errorMessage(err), {
        nextAction: '稍后重试;或改用导出文件通道发送给维护者',
      });
    }
    return;
  }

  // Manual "mark as sent" for mailto/export channels (spec §11.4): user
  // declares the draft delivered; the console cannot confirm server-side, so
  // this is an honest client-declared status write-back — never a fake ack.
  if (MARK_SENT_SUBPATH.test(subPath)) {
    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
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
          'feedback_channel feature flag is disabled. Enable feedback_channel in .pd/config.yaml to mark feedback as sent.',
          { nextAction: '在 .pd/config.yaml 将 features.feedback_channel.enabled 改为 true' },
        );
        return;
      }
    }

    const reportId = subPath.slice(1, subPath.length - '/mark-sent'.length);
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
      sendBadRequest(res, bodyResult.error);
      return;
    }
    const viaRaw =
      bodyResult.value !== null &&
      typeof bodyResult.value === 'object' &&
      !Array.isArray(bodyResult.value)
        ? (bodyResult.value as Record<string, unknown>).via
        : undefined;
    if (viaRaw !== 'email' && viaRaw !== 'file') {
      sendBadRequest(res, 'via must be one of: "email", "file"');
      return;
    }

    try {
      const loaded = await model.get(reportId);
      if (!loaded.ok || !loaded.report) {
        sendError(res, loaded.errorCode === 'NOT_FOUND' ? 404 : 400, 'mark_sent_report_not_found', loaded.error ?? 'draft not found', {
          nextAction: '从草稿列表选择一个已保存的反馈再标记',
        });
        return;
      }
      // Honesty: do not re-stamp an already-submitted draft (alreadySubmitted).
      if (loaded.report.status === 'submitted') {
        sendSuccess(res, {
          ok: true,
          alreadySubmitted: true,
          status: 'submitted',
          submittedVia: loaded.report.submittedVia,
          trackingId: loaded.report.trackingId,
          externalUrl: loaded.report.externalUrl,
        });
        return;
      }
      const submittedAt = new Date().toISOString();
      const wb = await model.update(reportId, { status: 'submitted', submittedAt, submittedVia: viaRaw });
      if (!wb.ok || !wb.report) {
        sendError(res, 500, 'mark_sent_write_back_failed', wb.error ?? 'write-back failed', {
          nextAction: '标记失败,请稍后重试',
        });
        return;
      }
      sendSuccess(res, { ok: true, alreadySubmitted: false, status: 'submitted', submittedVia: viaRaw, submittedAt });
    } catch (err) {
      sendError(res, 500, 'mark_sent_error', errorMessage(err), { nextAction: '标记失败,请稍后重试' });
    }
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
      if (!result.report) {
        sendError(res, 500, 'feedback_reports_get_empty', 'Report lookup succeeded but no report was returned');
        return;
      }
      sendSuccess<{ report: FeedbackReport }>(res, { report: result.report });
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

/**
 * Channels context for the submit-ladder probe endpoint.
 */
export type FeedbackChannelsContext = {
  workspaceDir: string;
  channelConfig?: FeedbackChannelConfig;
  featureFlags?: Record<string, { enabled: boolean }>;
  maintainerEmail?: string;
  channelDeps?: Parameters<typeof probeChannels>[1];
};

/**
 * GET /api/feedback/submit/channels — build the channel ladder availability
 * (spec §8.1). When the feedback_channel flag is off, the whole submit area is
 * hidden from the UI; the endpoint still probes but the client drops it.
 */
export async function handleFeedbackChannelsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: FeedbackChannelsContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    const config = ctx.channelConfig ?? { ingestUrl: '', ingestToken: '', githubRepo: '', githubProxy: '' };
    const result = await probeChannels(config, ctx.channelDeps ?? {}, ctx.maintainerEmail ?? '');
    // Never leak the ingest token into a client-facing payload (probeChannels already omits it).
    sendSuccess<{ channels: unknown[] }>(res, { channels: result.channels });
  } catch (err) {
    // rc-9: structured failure with nextAction; the client hides submit area.
    sendError(res, 500, 'feedback_channels_probe_error', errorMessage(err), {
      nextAction: '稍后重试;或直接使用导出文件通道',
    });
  }
}

export function disposeFeedbackReportModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
  // Task 13: also close and clear the draft store cache
  for (const entry of draftStores.values()) {
    try {
      entry.connection.close();
    } catch {
      // best-effort close on shutdown
    }
  }
  draftStores.clear();
}
