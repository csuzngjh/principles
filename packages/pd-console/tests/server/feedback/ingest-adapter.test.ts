import { describe, it, expect, vi } from 'vitest';
import type { FeedbackReport } from '@principles/core/runtime-v2/feedback';
import {
  probeIngestHealth,
  submitToIngest,
  DEFAULT_INGEST_TIMEOUT_MS,
} from '../../../src/server/feedback/ingest-adapter.js';

function makeFetchResponse(status: number, body?: unknown): Response {
  return {
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function makeReport(): FeedbackReport {
  return {
    id: 'fb-test-1',
    createdAt: '2026-08-17T00:00:00.000Z',
    type: 'bug',
    title: 'Peers never finish',
    userText: { description: 'Peers never finish' },
    diagnosticSummary: { versions: {}, platform: {}, featureFlags: {}, canary: { status: 'unavailable' }, recentEvents: [] },
    privacy: { redactionNotes: [] },
    outputs: { markdown: '# Peers never finish', emailText: '', githubIssueUrl: '', mailtoUrl: '' },
  };
}

describe('probeIngestHealth', () => {
  it('returns available when the relay /health responds', async () => {
    const fetchFn = vi.fn(async () => makeFetchResponse(200, { ok: true }));
    const r = await probeIngestHealth('https://example.com/api/feedback', { fetchFn });
    expect(r.available).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('https://example.com/api/feedback/health', { method: 'GET', signal: expect.anything() });
  });

  it('is fail-open for non-2xx health responses (server reachable)', async () => {
    const fetchFn = vi.fn(async () => makeFetchResponse(401, { ok: false }));
    const r = await probeIngestHealth('https://example.com/api/feedback', { fetchFn, timeoutMs: 100 });
    expect(r.available).toBe(true);
  });

  it('reports unavailable with reason + nextAction on network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ENOTFOUND example.com');
    });
    const r = await probeIngestHealth('https://example.com/api/feedback', { fetchFn });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('无法连接反馈服务');
    expect(r.nextAction).toBeTruthy();
  });

  it('reports unavailable on timeout (AbortError)', async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const r = await probeIngestHealth('https://example.com/api/feedback', { fetchFn, timeoutMs: 1200 });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('超时');
  });
});

describe('submitToIngest', () => {
  const config = {
    url: 'https://example.com/api/feedback',
    token: 'tok',
    report: makeReport(),
    fingerprint: 'abcdef',
    area: 'failed_tasks',
  };

  it('POSTs with bearer auth and maps a 202 success receipt', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      // Verify auth header + body shape at the fetch boundary.
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
      const parsed = JSON.parse(String(init.body)) as { report: unknown; fingerprint: string; area: string };
      expect(parsed.fingerprint).toBe('abcdef');
      expect(parsed.area).toBe('failed_tasks');
      expect(parsed.report).toBeTruthy();
      return makeFetchResponse(202, { trackingId: 'fb-1234', issueUrl: 'https://linear.app/issue/1', duplicate: false });
    });
    const r = await submitToIngest({ ...config, fetchFn });
    expect(r).toEqual({
      ok: true,
      duplicate: false,
      trackingId: 'fb-1234',
      issueUrl: 'https://linear.app/issue/1',
      count: undefined,
    });
  });

  it('maps a duplicate response with count', async () => {
    const fetchFn = vi.fn(async () =>
      makeFetchResponse(202, { trackingId: 'fb-1234', issueUrl: 'u', duplicate: true, count: 3 }),
    );
    const r = await submitToIngest({ ...config, fetchFn });
    expect(r).toMatchObject({ ok: true, duplicate: true, count: 3 });
  });

  it('rejects 401 with structured reason + nextAction', async () => {
    const fetchFn = vi.fn(async () => makeFetchResponse(401, { error: 'unauthorized' }));
    const r = await submitToIngest({ ...config, fetchFn });
    expect(r).toMatchObject({ ok: false, status: 401 });
    if (!r.ok) expect(r.nextAction).toBeTruthy();
  });

  it('rejects 429 with a retry hint', async () => {
    const fetchFn = vi.fn(async () => makeFetchResponse(429));
    const r = await submitToIngest({ ...config, fetchFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.nextAction).toContain('请稍后重试');
  });

  it('reports 0 for network/timeout failures and does not throw', async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new Error('ECONNRESET'), { name: 'AbortError' });
    });
    const r = await submitToIngest({ ...config, fetchFn, timeoutMs: DEFAULT_INGEST_TIMEOUT_MS });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(0);
      expect(r.reason).toContain('反馈服务不可达');
    }
  });

  it('defaults to a 20s timeout', () => {
    expect(DEFAULT_INGEST_TIMEOUT_MS).toBe(20_000);
  });
});