// create-report.test.ts
// ERR-001/005/013: no `as` casts on untrusted input. Runtime validation via typeof + Object.hasOwn + isRecord.
// ERR-002: failure paths return {ok: false, errors} where each error has reason + nextAction.
// ERR-003: redact uses segment-exact key matching (covered in redact-sensitive.test.ts).
// ERR-014/016/017: bounded previews and BigInt-safe safeStringifyPreview.

import { describe, it, expect } from 'vitest';
import {
  normalizeFeedbackDraftInput,
  isFeedbackType,
  isUserSeverity,
  isFeedbackSource,
  isRecord,
  isString,
  isBoolean,
  type FeedbackDraftInput,
  type ValidationError,
} from '../../feedback/feedback-types.js';
import { createFeedbackReport } from '../../feedback/create-report.js';
import type { FeedbackReport } from '../../feedback/feedback-types.js';

describe('runtime validators', () => {
  it('isFeedbackType accepts only spec-allowed values', () => {
    expect(isFeedbackType('bug')).toBe(true);
    expect(isFeedbackType('confusing')).toBe(true);
    expect(isFeedbackType('privacy_concern')).toBe(true);
    expect(isFeedbackType('feature_request')).toBe(true);
    expect(isFeedbackType('other')).toBe(true);
    expect(isFeedbackType('not-a-type')).toBe(false);
    expect(isFeedbackType(42)).toBe(false);
    expect(isFeedbackType(null)).toBe(false);
  });

  it('isUserSeverity accepts only low/medium/high', () => {
    expect(isUserSeverity('low')).toBe(true);
    expect(isUserSeverity('medium')).toBe(true);
    expect(isUserSeverity('high')).toBe(true);
    expect(isUserSeverity('critical')).toBe(false);
  });

  it('isFeedbackSource accepts only console/cli/agent', () => {
    expect(isFeedbackSource('console')).toBe(true);
    expect(isFeedbackSource('cli')).toBe(true);
    expect(isFeedbackSource('agent')).toBe(true);
    expect(isFeedbackSource('web')).toBe(false);
  });

  it('isRecord rejects null, arrays, primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(42)).toBe(false);
  });

  it('isString / isBoolean type guards', () => {
    expect(isString('a')).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean('true')).toBe(false);
  });
});

describe('normalizeFeedbackDraftInput', () => {
  it('accepts minimum required fields', () => {
    const input: FeedbackDraftInput = {
      type: 'bug',
      title: 'Broken page',
      description: 'Cannot load',
    };
    const result = normalizeFeedbackDraftInput(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('bug');
    expect(result.value.title).toBe('Broken page');
    expect(result.value.userText.description).toBe('Cannot load');
  });

  it('accepts full spec input with all optional fields', () => {
    const input = {
      type: 'privacy_concern',
      title: 'Token in URL',
      description: 'My token shows up in URL',
      stepsToReproduce: '1. Open\n2. Reload',
      expectedBehavior: 'No token in URL',
      actualBehavior: 'Token visible',
      userSeverity: 'high',
      context: {
        source: 'console',
        page: '/overview',
        painId: 'p-001',
        principleId: 'pr-002',
        approvalId: 'ap-003',
        activationId: 'act-004',
        updateAttemptId: 'up-005',
      },
      agentDraft: {
        summary: 'agent observed token',
        observedFailure: 'url token',
        commandSummary: 'npm run dev',
      },
    };
    const result = normalizeFeedbackDraftInput(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.userText.stepsToReproduce).toBe('1. Open\n2. Reload');
    expect(result.value.context?.source).toBe('console');
    expect(result.value.context?.page).toBe('/overview');
    expect(result.value.agentDraft?.summary).toBe('agent observed token');
  });

  it('rejects missing type', () => {
    const result = normalizeFeedbackDraftInput({ title: 'x', description: 'y' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fieldNames = result.errors.map((e: ValidationError) => e.field);
    expect(fieldNames).toContain('type');
    expect(result.errors.every((e: ValidationError) => e.reason && e.nextAction)).toBe(true);
  });

  it('rejects missing title', () => {
    const result = normalizeFeedbackDraftInput({ type: 'bug', description: 'y' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e: ValidationError) => e.field === 'title')).toBe(true);
  });

  it('rejects missing description', () => {
    const result = normalizeFeedbackDraftInput({ type: 'bug', title: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e: ValidationError) => e.field === 'description')).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = normalizeFeedbackDraftInput({ type: 'not-real', title: 'x', description: 'y' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e: ValidationError) => e.field === 'type')).toBe(true);
  });

  it('rejects invalid userSeverity', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y', userSeverity: 'critical',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e: ValidationError) => e.field === 'userSeverity')).toBe(true);
  });

  it('rejects invalid context.source', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y',
      context: { source: 'web' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e: ValidationError) => e.field === 'context.source')).toBe(true);
  });

  it('accepts context without source (Task 6: source is optional)', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y',
      context: { painId: 'pain-abc', page: 'pain_detail' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.context?.source).toBeUndefined();
    expect(result.value.context?.painId).toBe('pain-abc');
    expect(result.value.context?.page).toBe('pain_detail');
  });

  it('accepts context with taskId (Task 6)', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y',
      context: { source: 'console', taskId: 'task-xyz', painId: 'pain-abc' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.context?.taskId).toBe('task-xyz');
    expect(result.value.context?.painId).toBe('pain-abc');
  });

  it('accepts context with only taskId (all fields optional)', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y',
      context: { taskId: 'task-001' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.context?.taskId).toBe('task-001');
    expect(result.value.context?.source).toBeUndefined();
  });

  it('accepts empty context object (all fields optional)', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y',
      context: {},
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-string context.taskId', () => {
    const result = normalizeFeedbackDraftInput({
      type: 'bug', title: 'x', description: 'y',
      context: { taskId: 42 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e: ValidationError) => e.field === 'context.taskId')).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = normalizeFeedbackDraftInput('not an object');
    expect(result.ok).toBe(false);
  });
});

describe('createFeedbackReport', () => {
  function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'bug',
      title: 'Pain page broken',
      description: 'Clicking pain link throws TypeError',
      stepsToReproduce: '1. Open\n2. Click',
      expectedBehavior: 'Page opens',
      actualBehavior: 'Error',
      userSeverity: 'high',
      context: {
        source: 'console',
        page: '/overview',
        painId: 'p-001',
      },
      ...overrides,
    };
  }

  function validDiagnostics(): Record<string, unknown> {
    return {
      versions: { '@principles/core': '1.0.0' },
      platform: { os: 'darwin', node: '20.0.0' },
      featureFlags: { 'mvp-core': true },
      canary: { status: 'available', summary: 'healthy' },
      recentEvents: [
        { type: 'pain_signal', at: '2026-06-01T00:00:00.000Z', summary: 'pain' },
      ],
    };
  }

  it('returns ok:false with structured errors on invalid input — no `as` cast path', () => {
    const result = createFeedbackReport(null, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e: ValidationError) => typeof e.reason === 'string' && typeof e.nextAction === 'string')).toBe(true);
  });

  it('returns ok:true with full FeedbackReport on valid input', () => {
    const result = createFeedbackReport(validInput(), validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report: FeedbackReport = result.report;
    expect(report.id).toMatch(/^fb-/);
    expect(report.type).toBe('bug');
    expect(report.title).toBe('Pain page broken');
    expect(report.userText.description).toBe('Clicking pain link throws TypeError');
    expect(report.userText.userSeverity).toBe('high');
    expect(report.outputs.markdown).toContain('Pain page broken');
    expect(report.outputs.emailText).toContain('Pain page broken');
    expect(report.outputs.githubIssueUrl).toContain('https://github.com/');
  });

  it('builds contextRefs from context fields', () => {
    const result = createFeedbackReport(validInput(), validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.report.contextRefs.map((c: { kind: string }) => c.kind);
    expect(kinds).toContain('page');
    expect(kinds).toContain('painId');
  });

  it('builds privacy section with includedSections, excludedByDefault, redactionNotes', () => {
    const result = createFeedbackReport(validInput(), validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.privacy.includedSections.length).toBeGreaterThan(0);
    expect(result.report.privacy.excludedByDefault.length).toBeGreaterThan(0);
  });

  it('redacts absolute paths in description (passed through pipeline)', () => {
    const input = validInput({
      description: 'Error at C:\\Users\\alice\\secret\\path.ts in this code',
    });
    const result = createFeedbackReport(input, validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const desc = result.report.userText.description;
    expect(desc).toContain('<redacted-path>');
    expect(desc).not.toContain('C:\\Users\\alice\\secret');
  });

  it('redacts token-like values in description', () => {
    const input = validInput({
      description: 'Token sk-abcdefghijklmnopqrstuvwxyz0123456789 was leaked',
    });
    const result = createFeedbackReport(input, validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.userText.description).toContain('[REDACTED]');
  });

  it('records canary unavailable as not-fatal (unavailableReason captured)', () => {
    const diagnostics = {
      ...validDiagnostics(),
      canary: { status: 'unavailable', unavailableReason: 'no network' },
    };
    const result = createFeedbackReport(validInput(), diagnostics);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.diagnosticSummary.canary.status).toBe('unavailable');
    expect(result.report.diagnosticSummary.canary.unavailableReason).toBe('no network');
  });

  it('records version collection failure as not-fatal', () => {
    const diagnostics: Record<string, unknown> = {
      ...validDiagnostics(),
      versions: { error: 'npm not found', unavailableReason: 'no package manager detected' },
    };
    const result = createFeedbackReport(validInput(), diagnostics);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The diagnosticSummary.versions is still present (we record what we have)
    expect(result.report.diagnosticSummary.versions).toBeDefined();
  });

  it('generates outputs.markdown, outputs.emailText, outputs.githubIssueUrl (all non-empty)', () => {
    const result = createFeedbackReport(validInput(), validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.outputs.markdown.length).toBeGreaterThan(0);
    expect(result.report.outputs.emailText.length).toBeGreaterThan(0);
    expect(result.report.outputs.githubIssueUrl.length).toBeGreaterThan(0);
  });

  it('githubIssueUrl has redacted title (paths → redacted-path)', () => {
    const input = validInput({
      title: 'Error at C:\\Users\\alice\\secret\\path.ts',
    });
    const result = createFeedbackReport(input, validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The raw path should NOT appear in the URL
    expect(result.report.outputs.githubIssueUrl).not.toContain('C%3A%5CUsers%5Calice%5Csecret');
  });

  it('non-object diagnostics → result is still ok (not-fatal; uses empty defaults)', () => {
    const result = createFeedbackReport(validInput(), 'not-an-object');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Diagnostic summary still produced
    expect(result.report.diagnosticSummary).toBeDefined();
  });

  it('agentDraft is preserved when provided', () => {
    const input = validInput({
      agentDraft: {
        summary: 'agent saw this',
        observedFailure: 'TypeError',
        commandSummary: 'npm test',
      },
    });
    const result = createFeedbackReport(input, validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The agentDraft summary should appear in the report (e.g. in markdown)
    expect(result.report.outputs.markdown).toContain('agent saw this');
  });

  it('redacts absolute paths in agentDraft.summary', () => {
    const input = validInput({
      agentDraft: {
        summary: 'Error at C:\\Users\\alice\\secret\\path.ts in this code',
        observedFailure: 'Crash at C:\\Users\\bob\\secret\\file.ts',
        commandSummary: 'ran from D:\\Projects\\internal\\tool.ts',
      },
    });
    const result = createFeedbackReport(input, validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ad = result.report.agentDraft;
    expect(ad).toBeDefined();
    if (!ad) return;
    // summary should have redacted paths
    expect(ad.summary).toContain('<redacted-path>');
    expect(ad.summary).not.toContain('C:\\Users\\alice\\secret');
    // observedFailure should also be redacted
    if (ad.observedFailure) {
      expect(ad.observedFailure).not.toContain('C:\\Users\\bob\\secret');
    }
    // commandSummary should also be redacted
    if (ad.commandSummary) {
      expect(ad.commandSummary).not.toContain('D:\\Projects\\internal');
    }
  });

  it('redacts token and env values in agentDraft fields', () => {
    const input = validInput({
      agentDraft: {
        summary: 'Token sk-abcdefghijklmnopqrstuvwxyz0123456789 was exposed',
        observedFailure: 'OPENAI_API_KEY=sk-abc123def456 found in output',
        commandSummary: 'export AWS_SECRET_KEY=abc123xyz789 and ran npm test',
      },
    });
    const result = createFeedbackReport(input, validDiagnostics());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ad = result.report.agentDraft;
    expect(ad).toBeDefined();
    if (!ad) return;
    // summary: token-like value should be redacted
    expect(ad.summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(ad.summary).toContain('[REDACTED]');
    // observedFailure: env-like value should be redacted
    if (ad.observedFailure) {
      expect(ad.observedFailure).not.toContain('sk-abc123def456');
    }
    // commandSummary: env-like value should be redacted
    if (ad.commandSummary) {
      expect(ad.commandSummary).not.toContain('AWS_SECRET_KEY=abc123xyz789');
    }
  });

  it('handles BigInt in diagnostics without throwing (ERR-017)', () => {
    const diagnostics: Record<string, unknown> = {
      ...validDiagnostics(),
      versions: { count: BigInt(9999999999999) as unknown as string },
    };
    let thrown: unknown = null;
    try {
      const result = createFeedbackReport(validInput(), diagnostics);
      expect(result.ok).toBe(true);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });

  it('records string redaction notes in privacy.redactionNotes when diagnostics contain token-like values', () => {
    const diagnostics = {
      ...validDiagnostics(),
      versions: { buildLog: 'Key sk-ant-1234567890abcdef1234567890 injected here' },
    };
    const result = createFeedbackReport(validInput(), diagnostics);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The string redaction in redactInner should push a note when a token is found
    // inside a string value of the diagnostic summary
    expect(result.report.privacy.redactionNotes.some((n: string) => n.includes('redacted'))).toBe(true);
  });

  it('records string redaction notes when diagnostics contain absolute paths', () => {
    const diagnostics = {
      ...validDiagnostics(),
      versions: { cwd: 'C:\\Users\\alice\\secret-project\\src' },
    };
    const result = createFeedbackReport(validInput(), diagnostics);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.privacy.redactionNotes.some((n: string) => n.includes('redacted'))).toBe(true);
  });
});
