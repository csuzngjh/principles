// submit-service.ts
// Orchestrates a feedback submission: load the saved (already-redacted) draft
// by id, compute its fingerprint, hand it to the chosen adapter, then write
// the receipt back when the adapter succeeds (spec §8.2).
//
// Trust boundaries:
// - The request body never carries report content — only { channel } (route-level).
//   Everything sent onwards comes from the re-loaded disk draft.
// - Idempotency: an already-submitted draft returns alreadySubmitted:true and
//   is never resubmitted.
// - Failure never downgrades the draft's status: any adapter error leaves it
//   'draft' with a structured reason + nextAction (rc-9).
// - Write-back failure still returns success + writeBackFailed:true rather than
//   dropping the receipt (spec §12 — "宁重复提示不丢回执").

import {
  computeFeedbackFingerprint,
  type FeedbackReport,
  type FeedbackSubmittedVia,
} from '@principles/core/runtime-v2/feedback';
import type * as childProcessNS from 'node:child_process';
import type * as fsNS from 'node:fs';
import type * as osNS from 'node:os';
import type * as pathNS from 'node:path';
import type { FeedbackChannelConfig } from '../config/pd-config-store.js';
import type { FeedbackReportConsoleModel } from '../models/FeedbackReportConsoleModel.js';
import { submitToIngest } from './ingest-adapter.js';
import { submitToGithub } from './github-adapter.js';

type ExecFileFn = typeof childProcessNS.execFile;

export type SubmitChannel = 'ingest' | 'github';

export type SubmitReportResult =
  | {
      ok: true;
      alreadySubmitted: boolean;
      status: 'submitted';
      submittedVia?: FeedbackSubmittedVia;
      trackingId?: string;
      externalUrl?: string;
      writeBackFailed?: boolean;
      nextAction?: string;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      message: string;
      nextAction: string;
    };

export type SubmitDeps = {
  fetchFn?: typeof fetch;
  execFile?: ExecFileFn;
  fs?: typeof fsNS;
  os?: typeof osNS;
  path?: typeof pathNS;
};

/**
 * Submit a saved draft by id through the given channel. `maintainerEmail`
 * (route-level) is accepted separately for parity/future use.
 */
export async function submitReport(opts: {
  model: FeedbackReportConsoleModel;
  reportId: string;
  channel: SubmitChannel;
  config: FeedbackChannelConfig;
  deps?: SubmitDeps;
}): Promise<SubmitReportResult> {
  const { model, reportId, channel, config, deps } = opts;

  // 1. Load the saved draft (already redacted at creation time).
  const loaded = await model.get(reportId);
  const { ok, report, errorCode, error } = loaded;
  if (!ok || !report) {
    if (errorCode === 'NOT_FOUND') {
      return {
        ok: false,
        statusCode: 404,
        error: 'feedback_report_not_found',
        message: `No saved feedback draft with id ${reportId}`,
        nextAction: '从草稿列表选择一个已保存的反馈再提交',
      };
    }
    return {
      ok: false,
      statusCode: 400,
      error: 'feedback_report_load_failed',
      message: `Failed to load draft: ${error ?? 'unknown'}`,
      nextAction: '检查草稿文件是否可读后重试',
    };
  }

  // 2. Idempotency — never resubmit an already-submitted draft.
  if (report.status === 'submitted') {
    return {
      ok: true,
      alreadySubmitted: true,
      status: 'submitted',
      submittedVia: report.submittedVia,
      trackingId: report.trackingId,
      externalUrl: report.externalUrl,
    };
  }

  // 3. Channel configuration gate (single-channel disable = remove its config key).
  if (channel === 'ingest' && config.ingestUrl.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      error: 'ingest_channel_not_configured',
      message: 'ingest 通道未配置(feedback.ingest_url 为空)',
      nextAction: '在 .pd/config.yaml 配置 feedback.ingest_url,或选择其他通道',
    };
  }
  if (channel === 'github' && config.githubRepo.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      error: 'github_channel_not_configured',
      message: 'gh 通道未配置(feedback.github_repo 为空)',
      nextAction: '在 .pd/config.yaml 配置 feedback.github_repo,或选择其他通道',
    };
  }

  // 4. Deterministic fingerprint for relay-side dedup/clustering.
  const fingerprint = computeFeedbackFingerprint({
    type: report.type,
    title: report.title,
    area: report.area,
  });
  const { area } = report;

  const submittedAt = new Date().toISOString();

  if (channel === 'ingest') {
    const outcome = await submitToIngest({
      url: config.ingestUrl,
      token: config.ingestToken,
      report,
      fingerprint,
      area,
      fetchFn: deps?.fetchFn,
    });
    if (!outcome.ok) {
      // 0 = network/timeout (downstream). Failed → keep draft untouched.
      return {
        ok: false,
        statusCode: outcome.status === 0 ? 502 : outcome.status,
        error: 'ingest_submit_failed',
        message: outcome.reason,
        nextAction: outcome.nextAction,
      };
    }
    // 5a. Write receipt back; a write-back failure must not drop the success.
    const patch: Partial<FeedbackReport> = {
      status: 'submitted',
      submittedAt,
      submittedVia: 'ingest',
    };
    if (outcome.trackingId) patch.trackingId = outcome.trackingId;
    if (outcome.issueUrl) patch.externalUrl = outcome.issueUrl;
    const wb = await model.update(reportId, patch);
    if (!wb.ok || !wb.report) {
      return {
        ok: true,
        alreadySubmitted: false,
        status: 'submitted',
        submittedVia: 'ingest',
        trackingId: outcome.trackingId,
        externalUrl: outcome.issueUrl,
        writeBackFailed: true,
        nextAction: '提交已完成但状态写回失败,请手动记录回执编号(可在此页面查看)',
      };
    }
    return {
      ok: true,
      alreadySubmitted: false,
      status: 'submitted',
      submittedVia: 'ingest',
      trackingId: outcome.trackingId,
      externalUrl: outcome.issueUrl,
    };
  }

  // github
  const outcome = await submitToGithub({
    repo: config.githubRepo,
    proxy: config.githubProxy,
    report,
    execFile: deps?.execFile,
    fs: deps?.fs,
    os: deps?.os,
    path: deps?.path,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      statusCode: 502,
      error: 'github_submit_failed',
      message: outcome.reason,
      nextAction: outcome.nextAction,
    };
  }
  const wb = await model.update(reportId, {
    status: 'submitted',
    submittedAt,
    submittedVia: 'github',
    externalUrl: outcome.issueUrl,
  });
  if (!wb.ok || !wb.report) {
    return {
      ok: true,
      alreadySubmitted: false,
      status: 'submitted',
      submittedVia: 'github',
      externalUrl: outcome.issueUrl,
      writeBackFailed: true,
      nextAction: '提交已完成但状态写回失败,请手动记录 issue 链接',
    };
  }
  return {
    ok: true,
    alreadySubmitted: false,
    status: 'submitted',
    submittedVia: 'github',
    externalUrl: outcome.issueUrl,
  };
}