import { describe, it, expect } from 'vitest';
import { CodeReviewPainAdapter } from '../code-review/code-review-pain-adapter.js';
import type { ReviewEvent, ReviewComment, ChangedFile } from '../code-review/review-event-types.js';

describe('CodeReviewPainAdapter', () => {
  const adapter = new CodeReviewPainAdapter();

  const baseFile: ChangedFile = {
    path: 'src/index.ts',
    linesAdded: 10,
    linesDeleted: 5,
    changeMagnitude: 15,
  };

  const baseEvent: ReviewEvent = {
    prId: 'pr-1',
    repositoryId: 'repo-1',
    authorId: 'author-1',
    reviewerIds: ['reviewer-1'],
    filesChanged: [baseFile],
    totalLinesAdded: 10,
    totalLinesDeleted: 5,
    comments: [],
    unresolvedThreadCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    reviewAgeDays: 1,
    hasTests: true,
    hasSecurityReview: true,
    isBreakingChange: false,
    labels: [],
    sessionId: 'sess-123',
  };

  // ---------------------------------------------------------------------------
  // Null-return paths
  // ---------------------------------------------------------------------------

  it('returns null for missing sessionId', () => {
    const event = { ...baseEvent, sessionId: '' };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null when sessionId is not a string', () => {
    const event = { ...baseEvent, sessionId: 42 as unknown as string };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null when no files changed and no comments', () => {
    const event: ReviewEvent = { ...baseEvent, filesChanged: [], comments: [] };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null when filesChanged is undefined and no comments', () => {
    const { filesChanged: _filesChanged, ...eventWithoutFiles } = baseEvent;
    const event = { ...eventWithoutFiles, filesChanged: undefined, comments: [] } as unknown as ReviewEvent;
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for negative reviewAgeDays', () => {
    const event: ReviewEvent = { ...baseEvent, reviewAgeDays: -1 };
    expect(adapter.capture(event)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Valid event with process violation
  // ---------------------------------------------------------------------------

  it('produces high score for process violation (no tests, >2 files, breaking change)', () => {
    const event: ReviewEvent = {
      ...baseEvent,
      filesChanged: [
        { path: 'src/a.ts', linesAdded: 50, linesDeleted: 10, changeMagnitude: 60 },
        { path: 'src/b.ts', linesAdded: 30, linesDeleted: 5, changeMagnitude: 35 },
        { path: 'src/c.ts', linesAdded: 20, linesDeleted: 5, changeMagnitude: 25 },
      ],
      totalLinesAdded: 100,
      totalLinesDeleted: 20,
      hasTests: false,
      isBreakingChange: true,
      labels: [],
      hasSecurityReview: false,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    // No tests + >2 files = +35, breaking change without label = +40 → process >= 40
    expect(signal.source).toBe('process_violation');
    expect(signal.score).toBeGreaterThan(0);
    // Severity should be at least medium for process violations
    expect(['medium', 'high', 'critical']).toContain(signal.severity);
  });

  // ---------------------------------------------------------------------------
  // Valid event with negative sentiment
  // ---------------------------------------------------------------------------

  it('produces negative_sentiment trigger when comments are negative', () => {
    const negativeComment: ReviewComment = {
      id: 'c2',
      authorId: 'reviewer-1',
      body: 'This code is terrible and should be rewritten',
      sentimentScore: -80,
      createdAt: '2026-01-01T00:00:00Z',
      // unresolved: no resolvedAt
    };
    const event: ReviewEvent = {
      ...baseEvent,
      comments: [negativeComment],
      unresolvedThreadCount: 1,
      hasTests: true,
      isBreakingChange: false,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    // With negative sentiment comments, source should be negative_sentiment
    // provided process violation score < 40
    expect(signal.source).toBe('negative_sentiment');
  });

  // ---------------------------------------------------------------------------
  // Valid event with diff complexity
  // ---------------------------------------------------------------------------

  it('produces diff_complexity trigger for many files with no process violations or negative sentiment', () => {
    const manyFiles: ChangedFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file${i}.ts`,
      linesAdded: 100,
      linesDeleted: 50,
      changeMagnitude: 150,
    }));
    // Use positive-sentiment comments so sentiment score stays below 40 threshold
    const positiveComment: ReviewComment = {
      id: 'c-pos',
      authorId: 'reviewer-1',
      body: 'Looks great!',
      sentimentScore: 80,
      createdAt: '2026-01-01T00:00:00Z',
      resolvedAt: '2026-01-02T00:00:00Z',
    };
    const event: ReviewEvent = {
      ...baseEvent,
      filesChanged: manyFiles,
      totalLinesAdded: 1000,
      totalLinesDeleted: 500,
      hasTests: true,
      isBreakingChange: false,
      hasSecurityReview: true,
      comments: [positiveComment],
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.source).toBe('diff_complexity');
  });

  // ---------------------------------------------------------------------------
  // Score clamping
  // ---------------------------------------------------------------------------

  it('clamps score to 0-100 range', () => {
    // Extreme process violations could theoretically push score > 100
    const event: ReviewEvent = {
      ...baseEvent,
      filesChanged: [
        { path: 'security/auth.ts', linesAdded: 300, linesDeleted: 200, changeMagnitude: 500 },
        { path: 'security/crypto.ts', linesAdded: 300, linesDeleted: 200, changeMagnitude: 500 },
        { path: 'src/main.ts', linesAdded: 300, linesDeleted: 200, changeMagnitude: 500 },
      ],
      totalLinesAdded: 900,
      totalLinesDeleted: 600,
      hasTests: false,
      isBreakingChange: true,
      labels: [],
      hasSecurityReview: false,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.score).toBeGreaterThanOrEqual(0);
    expect(signal.score).toBeLessThanOrEqual(100);
  });

  // ---------------------------------------------------------------------------
  // triggerTextPreview truncation
  // ---------------------------------------------------------------------------

  it('truncates triggerTextPreview to 200 chars', () => {
    const longBody = 'x'.repeat(300);
    const negativeComment: ReviewComment = {
      id: 'c3',
      authorId: 'reviewer-1',
      body: longBody,
      sentimentScore: -90,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const event: ReviewEvent = {
      ...baseEvent,
      comments: [negativeComment],
      hasTests: true,
      isBreakingChange: false,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.triggerTextPreview.length).toBeLessThanOrEqual(200);
  });

  // ---------------------------------------------------------------------------
  // PainSignal structure
  // ---------------------------------------------------------------------------

  it('returns PainSignal with correct structure', () => {
    const signal = adapter.capture(baseEvent);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(typeof signal.source).toBe('string');
    expect(typeof signal.score).toBe('number');
    expect(signal.timestamp).toBeTruthy();
    expect(typeof signal.reason).toBe('string');
    expect(signal.sessionId).toBe('sess-123');
    expect(signal.agentId).toBe('code-review-evaluator');
    expect(signal.domain).toBe('code-review');
    expect(typeof signal.severity).toBe('string');
    expect(typeof signal.context).toBe('object');
  });

  // ---------------------------------------------------------------------------
  // deriveProcessViolationScore scenarios
  // ---------------------------------------------------------------------------

  it('adds 35 when no tests and >2 files', () => {
    // With no tests + 3 files: +35, no other violations → process = 35 (< 40 threshold)
    // So primary trigger should NOT be process_violation
    const event: ReviewEvent = {
      ...baseEvent,
      filesChanged: [
        { path: 'src/a.ts', linesAdded: 5, linesDeleted: 5, changeMagnitude: 10 },
        { path: 'src/b.ts', linesAdded: 5, linesDeleted: 5, changeMagnitude: 10 },
        { path: 'src/c.ts', linesAdded: 5, linesDeleted: 5, changeMagnitude: 10 },
      ],
      hasTests: false,
      isBreakingChange: false,
      hasSecurityReview: true,
      totalLinesAdded: 15,
      totalLinesDeleted: 15,
      labels: [],
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    // process score is 35, which is < 40, so not process_violation
    expect(signal.context.processViolationScore).toBe(35);
    expect(signal.source).not.toBe('process_violation');
  });

  it('adds 40 for breaking change without label', () => {
    const event: ReviewEvent = {
      ...baseEvent,
      hasTests: true,
      isBreakingChange: true,
      labels: [],
      hasSecurityReview: true,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.context.processViolationScore).toBe(40);
    expect(signal.source).toBe('process_violation');
  });

  it('adds 50 for security changes without security review', () => {
    const event: ReviewEvent = {
      ...baseEvent,
      filesChanged: [{ path: 'security/auth.ts', linesAdded: 10, linesDeleted: 5, changeMagnitude: 15 }],
      hasTests: true,
      isBreakingChange: false,
      hasSecurityReview: false,
      labels: [],
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.context.processViolationScore).toBe(50);
    expect(signal.source).toBe('process_violation');
  });

  it('adds 20 for >500 lines changed without tests', () => {
    const event: ReviewEvent = {
      ...baseEvent,
      filesChanged: [
        { path: 'src/a.ts', linesAdded: 400, linesDeleted: 200, changeMagnitude: 600 },
      ],
      totalLinesAdded: 400,
      totalLinesDeleted: 200,
      hasTests: false,
      isBreakingChange: false,
      hasSecurityReview: true,
      labels: [],
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    // no tests + 1 file (not >2) = 0 for that rule, but >500 lines + no tests = +20
    expect(signal.context.processViolationScore).toBe(20);
  });

  // ---------------------------------------------------------------------------
  // deriveSentimentScore recency multiplier
  // ---------------------------------------------------------------------------

  it('applies recency multiplier when reviewAgeDays > 7', () => {
    const negativeComment: ReviewComment = {
      id: 'c4',
      authorId: 'reviewer-1',
      body: 'Bad code',
      sentimentScore: -50,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const recentEvent: ReviewEvent = {
      ...baseEvent,
      comments: [negativeComment],
      reviewAgeDays: 3,
      hasTests: true,
      isBreakingChange: false,
    };
    const oldEvent: ReviewEvent = {
      ...baseEvent,
      comments: [negativeComment],
      reviewAgeDays: 10,
      hasTests: true,
      isBreakingChange: false,
    };
    const recentSignal = adapter.capture(recentEvent);
    const oldSignal = adapter.capture(oldEvent);
    expect(recentSignal).not.toBeNull();
    if (!recentSignal) throw new Error('Expected non-null recentSignal');
    expect(oldSignal).not.toBeNull();
    if (!oldSignal) throw new Error('Expected non-null oldSignal');
    // Older reviews with unresolved negatives should produce higher sentiment pain
    expect(oldSignal.context.sentimentScore as number).toBeGreaterThan(
      recentSignal.context.sentimentScore as number,
    );
  });

  // ---------------------------------------------------------------------------
  // traceId fallback
  // ---------------------------------------------------------------------------

  it('uses "unknown" for traceId when not provided', () => {
    const event = { ...baseEvent, traceId: undefined };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.traceId).toBe('unknown');
  });

  it('uses provided traceId', () => {
    const event: ReviewEvent = { ...baseEvent, traceId: 'trace-abc' };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.traceId).toBe('trace-abc');
  });
});
