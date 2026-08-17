import { describe, it, expect } from 'vitest';
import {
  parseDraftRecord,
  parseDraftSummary,
  parseEnvelopeReport,
  getErrorMessage,
  buildFeedbackDiagnostics,
  buildFeedbackContextFromSearchParams,
} from '../../src/ui/pages/ReportProblemValidators.js';
import type { SettledResult } from '../../src/ui/pages/ReportProblemValidators.js';

// ---------------------------------------------------------------------------
// Validators used by the ReportProblemPage React component.
// The vitest config in this package uses the `node` environment, so we test
// the pure validators directly without rendering React.
// ---------------------------------------------------------------------------

const VALID_DRAFT = {
  id: 'draft-001',
  createdAt: '2026-06-01T12:00:00.000Z',
  type: 'bug',
  title: 'Test bug',
  userText: {
    description: 'Detailed description here',
    stepsToReproduce: '1. Do X\n2. See Y',
    expectedBehavior: 'Z',
    actualBehavior: 'W',
    userSeverity: 'high',
  },
  diagnosticSummary: {
    versions: { pd: '1.0.0' },
    platform: { os: 'win32' },
    featureFlags: {},
    canary: { status: 'available', summary: 'ok' },
    recentEvents: [{ type: 'click', at: '2026-06-01T11:59:00.000Z', summary: 'X' }],
  },
  privacy: {
    includedSections: ['versions'],
    excludedByDefault: ['rawPrompt'],
    redactionNotes: [],
  },
  outputs: {
    markdown: '# Markdown',
    emailText: 'Email text',
    githubIssueUrl: 'https://github.com/x/y/issues/new?body=...',
  },
};

describe('parseDraftRecord', () => {
  it('returns a DraftRecord for a well-formed payload', () => {
    const result = parseDraftRecord(VALID_DRAFT);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('draft-001');
    expect(result?.type).toBe('bug');
    expect(result?.userText.userSeverity).toBe('high');
  });

  it('rejects non-object input', () => {
    expect(parseDraftRecord(null)).toBeNull();
    expect(parseDraftRecord(undefined)).toBeNull();
    expect(parseDraftRecord('string')).toBeNull();
    expect(parseDraftRecord(42)).toBeNull();
    expect(parseDraftRecord([])).toBeNull();
  });

  it('rejects missing required top-level fields', () => {
    const { id: _id, ...noId } = VALID_DRAFT;
    expect(parseDraftRecord(noId)).toBeNull();

    const { type: _type, ...noType } = VALID_DRAFT;
    expect(parseDraftRecord(noType)).toBeNull();
  });

  it('rejects invalid type values', () => {
    expect(parseDraftRecord({ ...VALID_DRAFT, type: 'invalid' })).toBeNull();
  });

  it('rejects non-string id/title/createdAt', () => {
    expect(parseDraftRecord({ ...VALID_DRAFT, id: 123 })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, title: null })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, createdAt: [] })).toBeNull();
  });

  it('rejects when userText.description is missing or non-string', () => {
    const { userText: { description: _d, ...rest } } = VALID_DRAFT;
    expect(parseDraftRecord({ ...VALID_DRAFT, userText: rest })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, userText: { description: 42 } })).toBeNull();
  });

  it('rejects when outputs is missing any required string field', () => {
    const { outputs: { markdown: _m, ...rest } } = VALID_DRAFT;
    expect(parseDraftRecord({ ...VALID_DRAFT, outputs: rest })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, outputs: { ...VALID_DRAFT.outputs, emailText: 0 } })).toBeNull();
  });

  it('rejects when privacy arrays are missing or malformed', () => {
    expect(parseDraftRecord({ ...VALID_DRAFT, privacy: {} })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, privacy: { ...VALID_DRAFT.privacy, includedSections: 'not-array' } })).toBeNull();
  });

  it('rejects when userText.userSeverity has an invalid value', () => {
    const r = parseDraftRecord({
      ...VALID_DRAFT,
      userText: { ...VALID_DRAFT.userText, userSeverity: 'critical' },
    });
    expect(r).not.toBeNull();
    expect(r?.userText.userSeverity).toBeUndefined();
  });

  it('tolerates missing optional userText sub-fields', () => {
    const r = parseDraftRecord({
      ...VALID_DRAFT,
      userText: { description: 'just description' },
    });
    expect(r).not.toBeNull();
    expect(r?.userText.stepsToReproduce).toBeUndefined();
    expect(r?.userText.expectedBehavior).toBeUndefined();
    expect(r?.userText.actualBehavior).toBeUndefined();
    expect(r?.userText.userSeverity).toBeUndefined();
  });

  it('tolerates a missing diagnosticSummary (canary is recorded as unavailable)', () => {
    const { diagnosticSummary: _d, ...rest } = VALID_DRAFT;
    const r = parseDraftRecord(rest);
    expect(r).not.toBeNull();
    expect(r?.diagnosticSummary.canary.status).toBe('unavailable');
    expect(r?.diagnosticSummary.canary.unavailableReason).toBeTruthy();
  });

  it('accepts draft created from error boundary deep link (context.source is console)', () => {
    const errorBoundaryDraft = {
      ...VALID_DRAFT,
      context: { source: 'console', page: '/report-problem?source=error' },
    };
    const result = parseDraftRecord(errorBoundaryDraft);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('draft-001');
  });
});

describe('parseDraftSummary', () => {
  it('returns a summary for a well-formed value', () => {
    expect(parseDraftSummary({ id: 'a', createdAt: 'b', type: 'bug', title: 'c' })).toEqual({
      id: 'a',
      createdAt: 'b',
      type: 'bug',
      title: 'c',
    });
  });

  it('rejects any missing field', () => {
    expect(parseDraftSummary({ id: 'a', createdAt: 'b', type: 'bug' })).toBeNull();
    expect(parseDraftSummary({ id: 'a', createdAt: 'b', type: 'bug', title: 5 })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseDraftSummary(null)).toBeNull();
    expect(parseDraftSummary('x')).toBeNull();
    expect(parseDraftSummary([1, 2, 3])).toBeNull();
  });
});

describe('parseEnvelopeReport', () => {
  it('returns the report when envelope is well-formed', () => {
    const r = parseEnvelopeReport({ report: VALID_DRAFT });
    expect(r).not.toBeNull();
    expect(r?.id).toBe('draft-001');
  });

  it('returns null when envelope is not an object', () => {
    expect(parseEnvelopeReport(null)).toBeNull();
    expect(parseEnvelopeReport('x')).toBeNull();
  });

  it('returns null when report field is invalid', () => {
    expect(parseEnvelopeReport({ report: 'not-a-record' })).toBeNull();
  });
});

describe('getErrorMessage', () => {
  it('returns the error field on a failure-shaped result', () => {
    expect(getErrorMessage({ success: false, error: 'oops' }, 'fallback')).toBe('oops');
  });

  it('returns the fallback on a success-shaped result', () => {
    expect(getErrorMessage({ success: true, data: {} }, 'fallback')).toBe('fallback');
  });

  it('returns the fallback on null/undefined/non-objects', () => {
    expect(getErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(getErrorMessage('oops', 'fallback')).toBe('fallback');
  });

  it('returns the fallback when error is present but not a string', () => {
    expect(getErrorMessage({ success: false, error: 42 }, 'fallback')).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// buildFeedbackDiagnostics — assembles a diagnostics object from three
// concurrent API responses (Task 5). Each field's failure path records an
// `unavailableReason` per rc-9-no-silent-fallback.
// ---------------------------------------------------------------------------

type ApiResult =
  | { success: true; data: unknown }
  | { success: false; error: string; reason?: string; nextAction?: string };

function fulfilled(value: ApiResult): SettledResult<ApiResult> {
  return { status: 'fulfilled', value };
}

function rejected(reason: unknown): SettledResult<ApiResult> {
  return { status: 'rejected', reason };
}

describe('buildFeedbackDiagnostics', () => {
  it('returns a non-empty diagnostics object with all five fields', () => {
    const config = fulfilled({ success: true, data: { features: [], defaultRuntime: 'default' } });
    const lifecycle = fulfilled({ success: true, data: { recentEvents: [] } });
    const health = fulfilled({ success: true, data: { overall: 'healthy', generatedAt: '2026-07-04T00:00:00.000Z' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    // The diagnostics object must be non-empty — this is the core assertion
    // for Task 5: createFeedbackReport receives a real object, not undefined.
    expect(diag).toBeTruthy();
    expect(Object.keys(diag).length).toBe(5);
    expect(diag.versions).toBeTruthy();
    expect(diag.platform).toBeTruthy();
    expect(diag.featureFlags).toBeTruthy();
    expect(diag.canary).toBeTruthy();
    expect(Array.isArray(diag.recentEvents)).toBe(true);
  });

  it('maps /api/health overall=healthy to canary.status=available', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy', generatedAt: '2026-07-04T00:00:00.000Z' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.canary.status).toBe('available');
    expect(diag.canary.summary).toContain('overall=healthy');
  });

  it('maps /api/health overall=error to canary.status=unavailable', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'error', generatedAt: '2026-07-04T00:00:00.000Z' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.canary.status).toBe('unavailable');
    expect(diag.canary.unavailableReason).toContain('error');
  });

  it('records unavailableReason when /api/health fetch is rejected', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = rejected(new Error('network timeout'));

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.canary.status).toBe('unavailable');
    expect(diag.canary.unavailableReason).toContain('/api/health fetch failed');
    expect(diag.canary.unavailableReason).toContain('network timeout');
  });

  it('records unavailableReason when /api/health returns success=false', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: false, error: 'HTTP 500' });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.canary.status).toBe('unavailable');
    expect(diag.canary.unavailableReason).toContain('/api/health fetch failed: HTTP 500');
  });

  it('maps config summary features array to featureFlags', () => {
    const features = [
      { id: 'feedback_channel', category: 'core', enabled: true },
      { id: 'failed_tasks_observability', category: 'quiet', enabled: false },
    ];
    const config = fulfilled({ success: true, data: { features, defaultRuntime: 'pi-ai' } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.featureFlags.features).toEqual(features);
    expect(diag.featureFlags.defaultRuntime).toBe('pi-ai');
  });

  it('records unavailableReason when config summary fetch is rejected', () => {
    const config = rejected(new Error('connection refused'));
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    // P0-2: versions/platform now come from /api/health, not config.
    // Config failure only affects featureFlags.
    expect(diag.featureFlags.unavailableReason).toContain('/api/v1/config/summary fetch failed');
    expect(diag.featureFlags.unavailableReason).toContain('connection refused');
    // health succeeded but has no versions field → recorded as unavailable
    expect(diag.versions.unavailableReason).toContain('versions not in health response');
    expect(diag.platform.unavailableReason).toContain('platform not in health response');
  });

  it('records unavailableReason when config summary returns success=false', () => {
    const config = fulfilled({ success: false, error: 'HTTP 401' });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.featureFlags.unavailableReason).toContain('HTTP 401');
  });

  it('extracts recentEvents from lifecycle state response (last 5)', () => {
    const events = [
      { type: 'task_failed', at: '2026-07-04T00:00:01.000Z', summary: 'runner x failed' },
      { type: 'pain_recorded', at: '2026-07-04T00:00:02.000Z', summary: 'pain p1' },
      { type: 'principle_promoted', at: '2026-07-04T00:00:03.000Z', summary: 'pc1 promoted' },
      { type: 'task_succeeded', at: '2026-07-04T00:00:04.000Z', summary: 'runner y ok' },
      { type: 'approval_created', at: '2026-07-04T00:00:05.000Z', summary: 'approval a1' },
      { type: 'task_failed', at: '2026-07-04T00:00:06.000Z', summary: 'runner z failed' },
      { type: 'pain_recorded', at: '2026-07-04T00:00:07.000Z', summary: 'pain p2' },
    ];
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: true, data: { recentEvents: events } });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.recentEvents.length).toBe(5);
    // Last 5 of the input array (indices 2..6)
    expect(diag.recentEvents[0].summary).toBe('pc1 promoted');
    expect(diag.recentEvents[4].summary).toBe('pain p2');
  });

  it('filters out malformed recentEvents entries', () => {
    const events = [
      { type: 'valid', at: '2026-07-04T00:00:01.000Z', summary: 'ok' },
      { type: 42, at: '2026-07-04T00:00:02.000Z', summary: 'bad type' }, // invalid type
      { type: 'missing_at', summary: 'no at field' }, // missing at
      { type: 'missing_summary', at: '2026-07-04T00:00:03.000Z' }, // missing summary
      'not-an-object',
      null,
      { type: 'valid2', at: '2026-07-04T00:00:04.000Z', summary: 'ok2', severity: 'high' },
    ];
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: true, data: { recentEvents: events } });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.recentEvents.length).toBe(2);
    expect(diag.recentEvents[0].type).toBe('valid');
    expect(diag.recentEvents[1].type).toBe('valid2');
    expect(diag.recentEvents[1].severity).toBe('high');
  });

  it('returns empty recentEvents when lifecycle fetch is rejected (rc-9: not silently swallowed)', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = rejected(new Error('HTTP 404'));
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(Array.isArray(diag.recentEvents)).toBe(true);
    expect(diag.recentEvents.length).toBe(0);
    // The failure is NOT silently swallowed — other fields still record reasons
    expect(diag.canary.status).toBe('available');
  });

  it('returns empty recentEvents when lifecycle returns success=false', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    // P1-5: lifecycle failed → fallback to health checks, but health has no
    // checks array → recentEvents is still empty.
    expect(diag.recentEvents.length).toBe(0);
  });

  // ── P0-2: versions/platform extracted from /api/health ──────────────────

  it('extracts versions and platform from /api/health response (P0-2)', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({
      success: true,
      data: {
        overall: 'healthy',
        generatedAt: '2026-07-04T00:00:00.000Z',
        versions: { pd: '1.74.1', core: '0.9.0', node: 'v20.10.0' },
        platform: { os: 'linux', arch: 'x64', nodeVersion: 'v20.10.0' },
      },
    });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.versions).toEqual({ pd: '1.74.1', core: '0.9.0', node: 'v20.10.0' });
    expect(diag.platform).toEqual({ os: 'linux', arch: 'x64', nodeVersion: 'v20.10.0' });
  });

  it('records unavailableReason when /api/health has no versions field (P0-2)', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.versions.unavailableReason).toContain('versions not in health response');
    expect(diag.platform.unavailableReason).toContain('platform not in health response');
  });

  it('records health failure reason in versions/platform when /api/health fails (P0-2)', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = rejected(new Error('health timeout'));

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.versions.unavailableReason).toContain('/api/health fetch failed');
    expect(diag.versions.unavailableReason).toContain('health timeout');
    expect(diag.platform.unavailableReason).toContain('/api/health fetch failed');
  });

  // ── P1-5: recentEvents fallback to /api/health checks ───────────────────

  it('falls back to health checks for recentEvents when lifecycle fails (P1-5)', () => {
    const checks = [
      { id: 'sqlite', name: 'DB', status: 'healthy', message: 'ok', lastCheck: '2026-07-04T00:00:01.000Z' },
      { id: 'task_queue', name: 'Queue', status: 'warning', message: 'backlog', lastCheck: '2026-07-04T00:00:02.000Z' },
      { id: 'gfi_health', name: 'GFI', status: 'error', message: 'too high', lastCheck: '2026-07-04T00:00:03.000Z' },
    ];
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'degraded', checks } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    // P1-5: lifecycle endpoint doesn't exist → fall back to health checks
    expect(diag.recentEvents.length).toBe(3);
    expect(diag.recentEvents[0].type).toBe('sqlite');
    expect(diag.recentEvents[0].summary).toBe('ok');
    expect(diag.recentEvents[0].severity).toBeUndefined(); // healthy → no severity
    expect(diag.recentEvents[1].type).toBe('task_queue');
    expect(diag.recentEvents[1].severity).toBe('warn'); // warning → 'warn'
    expect(diag.recentEvents[2].type).toBe('gfi_health');
    expect(diag.recentEvents[2].severity).toBe('error'); // error → 'error'
  });

  it('prefers lifecycle recentEvents over health checks fallback (P1-5)', () => {
    const checks = [
      { id: 'sqlite', name: 'DB', status: 'healthy', message: 'ok', lastCheck: '2026-07-04T00:00:01.000Z' },
    ];
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({
      success: true,
      data: { recentEvents: [{ type: 'task_failed', at: '2026-07-04T00:00:05.000Z', summary: 'runner x failed' }] },
    });
    const health = fulfilled({ success: true, data: { overall: 'healthy', checks } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    // Lifecycle events take precedence over health checks fallback
    expect(diag.recentEvents.length).toBe(1);
    expect(diag.recentEvents[0].type).toBe('task_failed');
  });

  it('falls back to health checks when lifecycle is rejected (P1-5)', () => {
    const checks = [
      { id: 'sqlite', name: 'DB', status: 'healthy', message: 'ok', lastCheck: '2026-07-04T00:00:01.000Z' },
    ];
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = rejected(new Error('HTTP 404'));
    const health = fulfilled({ success: true, data: { overall: 'healthy', checks } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.recentEvents.length).toBe(1);
    expect(diag.recentEvents[0].type).toBe('sqlite');
  });

  it('handles all three APIs failing without throwing', () => {
    const config = rejected(new Error('config down'));
    const lifecycle = rejected(new Error('lifecycle down'));
    const health = rejected(new Error('health down'));

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    // Every field must record an unavailableReason — no silent fallback (rc-9)
    // P0-2: versions/platform now come from /api/health, so they carry the
    // health failure reason, not the config failure reason.
    expect(diag.versions.unavailableReason).toContain('health down');
    expect(diag.platform.unavailableReason).toContain('health down');
    expect(diag.featureFlags.unavailableReason).toContain('config down');
    expect(diag.canary.status).toBe('unavailable');
    expect(diag.canary.unavailableReason).toContain('health down');
    // P1-5: lifecycle failed AND health failed → no fallback events available
    expect(diag.recentEvents.length).toBe(0);
  });

  it('handles missing overall field in /api/health response', () => {
    const config = fulfilled({ success: true, data: { features: [] } });
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { checks: [] } }); // no overall field

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.canary.status).toBe('unavailable');
    expect(diag.canary.unavailableReason).toContain('overall field not present');
  });

  it('handles missing features field in config summary response', () => {
    const config = fulfilled({ success: true, data: { version: 1 } }); // no features
    const lifecycle = fulfilled({ success: false, error: 'HTTP 404' });
    const health = fulfilled({ success: true, data: { overall: 'healthy' } });

    const diag = buildFeedbackDiagnostics(config, lifecycle, health);

    expect(diag.featureFlags.unavailableReason).toContain('features field not present');
  });
});

// ---------------------------------------------------------------------------
// buildFeedbackContextFromSearchParams — Task 6: frontend context passthrough.
// Reads context identifiers (painId, principleId, approvalId, activationId,
// taskId, source, page) from URL query params so feedback reports can be
// associated with specific pain / principle / approval / task entities.
//
// The vitest config uses the `node` environment, so we test the pure function
// directly with `new URLSearchParams(...)` rather than rendering React.
// ---------------------------------------------------------------------------

describe('buildFeedbackContextFromSearchParams', () => {
  it('returns undefined when no relevant query params are present', () => {
    const sp = new URLSearchParams('');
    expect(buildFeedbackContextFromSearchParams(sp)).toBeUndefined();
  });

  it('returns undefined when only unrelated query params are present', () => {
    const sp = new URLSearchParams('?foo=bar&baz=qux');
    expect(buildFeedbackContextFromSearchParams(sp)).toBeUndefined();
  });

  it('returns context with painId only', () => {
    const sp = new URLSearchParams('?painId=pain-abc');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ painId: 'pain-abc' });
  });

  it('returns context with multiple fields', () => {
    const sp = new URLSearchParams('?painId=pain-abc&principleId=pc-001&page=pain_detail');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({
      painId: 'pain-abc',
      principleId: 'pc-001',
      page: 'pain_detail',
    });
  });

  it('includes taskId when present', () => {
    const sp = new URLSearchParams('?taskId=task-xyz&painId=pain-abc');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ taskId: 'task-xyz', painId: 'pain-abc' });
  });

  it('includes all supported fields', () => {
    const sp = new URLSearchParams(
      '?painId=p-1&principleId=pc-1&approvalId=ap-1&activationId=act-1&taskId=t-1&page=detail',
    );
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({
      painId: 'p-1',
      principleId: 'pc-1',
      approvalId: 'ap-1',
      activationId: 'act-1',
      taskId: 't-1',
      page: 'detail',
    });
  });

  it('includes source when it is a valid FeedbackSource (console)', () => {
    const sp = new URLSearchParams('?source=console&painId=p-1');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ source: 'console', painId: 'p-1' });
  });

  it('includes source when it is a valid FeedbackSource (cli)', () => {
    const sp = new URLSearchParams('?source=cli');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ source: 'cli' });
  });

  it('includes source when it is a valid FeedbackSource (agent)', () => {
    const sp = new URLSearchParams('?source=agent');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ source: 'agent' });
  });

  it('maps non-enum source to console and preserves original in sourceDetail (rc-9)', () => {
    // P1-3: source=pain_page is NOT a valid FeedbackSource enum. Previously it
    // was silently dropped (rc-9 violation). Now it is mapped to 'console'
    // (nearest valid enum) and the original value is preserved in sourceDetail.
    const sp = new URLSearchParams('?source=pain_page&page=pain_detail&painId=p-1');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({
      source: 'console',
      sourceDetail: 'pain_page',
      page: 'pain_detail',
      painId: 'p-1',
    });
  });

  it('maps source=error (from error boundary) to console + sourceDetail (rc-9)', () => {
    // P1-3: source=error is NOT silently dropped. Mapped to 'console' with
    // sourceDetail='error' so the maintainer knows it came from the error boundary.
    const sp = new URLSearchParams('?source=error&message=something');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ source: 'console', sourceDetail: 'error' });
  });

  it('maps source=failed_tasks_page to console + sourceDetail (rc-9)', () => {
    // P1-3: FailedTasksPage passes source=failed_tasks_page. Mapped to 'console'
    // with sourceDetail='failed_tasks_page' so the entry point is visible.
    const sp = new URLSearchParams('?source=failed_tasks_page&taskId=t-1');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({
      source: 'console',
      sourceDetail: 'failed_tasks_page',
      taskId: 't-1',
    });
  });

  it('maps source=principle_page (PrincipleDetailPage entry) to console + sourceDetail', () => {
    // Entity entry point from the principle detail page (slice 3, spec §7).
    const sp = new URLSearchParams('?source=principle_page&principleId=pc-9');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({
      source: 'console',
      sourceDetail: 'principle_page',
      principleId: 'pc-9',
    });
  });

  it('maps source=activation_page (ActivationPage entry) to console + sourceDetail', () => {
    // Entity entry point from an activation card (slice 3, spec §7). Carries
    // both activationId and the linked principleId for context pre-filling.
    const sp = new URLSearchParams('?source=activation_page&activationId=act-9&principleId=pc-9');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({
      source: 'console',
      sourceDetail: 'activation_page',
      activationId: 'act-9',
      principleId: 'pc-9',
    });
  });

  it('ignores empty string values', () => {
    const sp = new URLSearchParams('?painId=&principleId=pc-1');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    expect(ctx).toEqual({ principleId: 'pc-1' });
    expect(ctx).not.toHaveProperty('painId');
  });

  it('does not use `as` casts — returns Record<string, string> | undefined', () => {
    // This is a type-level guarantee enforced by the implementation; the test
    // verifies the runtime shape matches the declared return type.
    const sp = new URLSearchParams('?painId=p-1');
    const ctx = buildFeedbackContextFromSearchParams(sp);
    if (ctx !== undefined) {
      // Every value must be a string (rc-2-no-as-bypass: no `as` cast needed)
      for (const v of Object.values(ctx)) {
        expect(typeof v).toBe('string');
      }
    }
  });
});
