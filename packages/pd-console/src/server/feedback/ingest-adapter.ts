// ingest-adapter.ts
// Server-side adapter that POSTs a redacted, saved feedback draft to the
// configured relay endpoint (spec §8.3). The relay is reachable domestically
// (same origin as the official site), so domestic novices never touch GitHub.
//
// - Token lives only in server config (never the browser).
// - 20s default timeout (relay calls Linear on the happy path).
// - Failure returns a structured reason + nextAction (rc-9).

import type { FeedbackReport } from '@principles/core/runtime-v2/feedback';

export interface IngestHealthResult {
  available: boolean;
  reason?: string;
  nextAction?: string;
}

export type IngestSubmitOutcome =
  | {
      ok: true;
      trackingId?: string;
      issueUrl?: string;
      duplicate: boolean;
      count?: number;
    }
  | {
      ok: false;
      /** HTTP status from the relay when reachable; 0 for network/timeout failure. */
      status: number;
      reason: string;
      nextAction: string;
    };

export const DEFAULT_INGEST_TIMEOUT_MS = 20_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

async function fetchWithTimeout(args: {
  fetchFn: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<Response> {
  const { fetchFn, url, init, timeoutMs } = args;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the relay `/health` endpoint (spec §9.1) for channels availability.
 * Any HTTP response (2xx/4xx/5xx) other than a network/timeout error counts as
 * "reachable" (fail-open — an auth'd health endpoint may legitimately 401; we
 * only need to confirm a server exists). Non-2xx → available:true so the submit
 * path can surface a precise relay reason instead of hiding the channel.
 */
export async function probeIngestHealth(
  ingestUrl: string,
  deps?: { fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<IngestHealthResult> {
  const fetchFn = deps?.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const healthUrl = `${ingestUrl.replace(/\/+$/, '')}/health`;
  if (typeof fetchFn !== 'function') {
    return {
      available: false,
      reason: '当前运行环境不支持 fetch',
      nextAction: '使用 Node 18+ 运行 console,或改用导出文件通道',
    };
  }
  try {
    await fetchWithTimeout({ fetchFn, url: healthUrl, init: { method: 'GET' }, timeoutMs });
    return { available: true };
  } catch (err) {
    const reason = err instanceof Error
      ? (err.name === 'AbortError' ? `探活超时(${timeoutMs}ms)` : err.message)
      : String(err);
    return {
      available: false,
      reason: `无法连接反馈服务:${reason}`,
      nextAction: '检查网络;或改用导出文件通道',
    };
  }
}

/**
 * Submit a report body to the relay (POST {ingestUrl}).
 * Success = any 2xx; the relay returns 202 with { trackingId, issueUrl, duplicate, count }.
 */
export async function submitToIngest(args: {
  url: string;
  token: string;
  report: FeedbackReport;
  fingerprint: string;
  area?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<IngestSubmitOutcome> {
  const { url, token } = args;
  const fetchFn = args.fetchFn ?? globalThis.fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;

  const payload = {
    report: args.report,
    fingerprint: args.fingerprint,
    area: typeof args.area === 'string' ? args.area : undefined,
  };

  let res: Response;
  try {
    res = await fetchWithTimeout({
      fetchFn,
      url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    });
  } catch (err) {
    const reason = err instanceof Error
      ? (err.name === 'AbortError' ? `提交超时(${timeoutMs}ms)` : err.message)
      : String(err);
    return {
      ok: false,
      status: 0,
      reason: `反馈服务不可达:${reason}`,
      nextAction: '检查网络后重试;或使用导出文件通道发送给维护者',
    };
  }

  if (res.status >= 200 && res.status < 300) {
    const outcome: { ok: true; duplicate: boolean; trackingId?: string; issueUrl?: string; count?: number } = {
      ok: true,
      duplicate: false,
    };
    try {
      const body: unknown = await res.json();
      if (body !== null && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        if (typeof b.trackingId === 'string') outcome.trackingId = b.trackingId;
        if (typeof b.issueUrl === 'string') outcome.issueUrl = b.issueUrl;
        if (typeof b.duplicate === 'boolean') outcome.duplicate = b.duplicate;
        if (typeof b.count === 'number') outcome.count = b.count;
      }
    } catch {
      // 2xx with non-JSON body: still consider submission accepted; no receipt fields.
    }
    return outcome;
  }

  return {
    ok: false,
    status: res.status,
    reason: `反馈服务返回 ${res.status}`,
    nextAction: res.status === 429
      ? '请求过于频繁,请稍后重试'
      : res.status === 413
        ? '内容过长,请精简后重试'
        : `反馈服务异常,请稍后重试;或导出文件发送给维护者`,
  };
}