/**
 * E2E validation: ReviewEvent → PainSignal → DefaultPrincipleInjector
 *
 * Per D-04: Must test the complete E2E pipeline:
 * ReviewEvent → PainSignalAdapter.capture() → PainSignal →
 * DefaultPrincipleInjector.getRelevantPrinciples() → formatForInjection()
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CodeReviewPainAdapter } from '../../../src/adapters/code-review/code-review-pain-adapter.js';
import { DefaultPrincipleInjector } from '../../../src/principle-injector.js';
import type { ReviewEvent, ReviewComment } from '../../../src/adapters/code-review/review-event-types.js';
import type { InjectablePrinciple, InjectionContext } from '../../../src/types.js';

describe('CodeReview E2E: Pain → Injection Pipeline', () => {
  let adapter: CodeReviewPainAdapter;
  let injector: DefaultPrincipleInjector;

  beforeEach(() => {
    adapter = new CodeReviewPainAdapter();
    injector = new DefaultPrincipleInjector();
  });

  function createReviewEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
    return {
      prId: 'pr-e2e-1',
      repositoryId: 'repo-1',
      authorId: 'author-1',
      reviewerIds: ['reviewer-1'],
      filesChanged: [{ path: 'src/auth/jwt.ts', linesAdded: 80, linesDeleted: 40, changeMagnitude: 120 }],
      totalLinesAdded: 80,
      totalLinesDeleted: 40,
      comments: [
        { id: 'c1', authorId: 'reviewer-1', body: 'Why is this using MD5 for passwords? This is a security vulnerability.', sentimentScore: -85, createdAt: '2026-04-17T11:00:00.000Z' },
        { id: 'c2', authorId: 'reviewer-1', body: 'Please add proper CSRF protection.', sentimentScore: -70, createdAt: '2026-04-17T11:30:00.000Z' },
      ],
      unresolvedThreadCount: 2,
      createdAt: '2026-04-17T10:00:00.000Z',
      reviewAgeDays: 5,
      hasTests: false,
      hasSecurityReview: false,
      isBreakingChange: true,
      labels: ['security'],
      sessionId: 'sess-e2e-1',
      traceId: 'trace-e2e-1',
      ...overrides,
    };
  }

  function createPrinciple(overrides: Partial<InjectablePrinciple> = {}): InjectablePrinciple {
    return {
      id: 'P1-test',
      text: 'Test principle: always validate security-sensitive changes.',
      priority: 'P1',
      createdAt: '2026-04-17T00:00:00.000Z',
      ...overrides,
    };
  }

  it('E2E: ReviewEvent → PainSignal → getRelevantPrinciples() works end-to-end', () => {
    // Step 1: ReviewEvent → PainSignal
    const event = createReviewEvent();
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.domain).toBe('code-review');
    expect(signal!.score).toBeGreaterThan(0);

    // Step 2: Create principles with the signal's context
    const principles: InjectablePrinciple[] = [
      createPrinciple({ id: 'P0-security', text: 'P0: Security changes always require security review.', priority: 'P0', createdAt: '2026-04-17T01:00:00.000Z' }),
      createPrinciple({ id: 'P1-tests', text: 'P1: All PRs must include tests.', priority: 'P1', createdAt: '2026-04-17T02:00:00.000Z' }),
      createPrinciple({ id: 'P2-style', text: 'P2: Follow team code style guidelines.', priority: 'P2', createdAt: '2026-04-17T03:00:00.000Z' }),
    ];

    // Step 3: Inject with domain='code-review'
    const ctx: InjectionContext = {
      domain: 'code-review',
      sessionId: signal!.sessionId,
      budgetChars: 500,
    };

    const selected = injector.getRelevantPrinciples(principles, ctx);

    // Step 4: Verify selection
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].priority).toBe('P0'); // P0 forced inclusion
    const formatted = injector.formatForInjection(selected[0]);
    expect(formatted).toMatch(/^- \[.+\] .+/);
  });

  it('DefaultPrincipleInjector handles domain=code-review without modification', () => {
    const principles: InjectablePrinciple[] = [
      createPrinciple({ id: 'P0-coding', text: 'P0: Validate input.', priority: 'P0', createdAt: '2026-04-17T01:00:00.000Z' }),
      createPrinciple({ id: 'P1-review', text: 'P1: Request review for large diffs.', priority: 'P1', createdAt: '2026-04-17T02:00:00.000Z' }),
    ];

    // Inject with domain='code-review' — should NOT filter by domain
    const ctx: InjectionContext = { domain: 'code-review', sessionId: 'sess-1', budgetChars: 300 };
    const result = injector.getRelevantPrinciples(principles, ctx);

    // Both principles should be available (P0 forced, P1 fits in budget)
    expect(result.length).toBe(2);
    expect(result.map(p => p.id)).toContain('P0-coding');
    expect(result.map(p => p.id)).toContain('P1-review');
  });

  it('formatForInjection returns "- [ID] text" format', () => {
    const principles = [
      createPrinciple({ id: 'P0-1', text: 'P0: Always validate input before processing.', priority: 'P0', createdAt: '2026-04-17T01:00:00.000Z' }),
    ];
    const ctx: InjectionContext = { domain: 'code-review', sessionId: 'sess-1', budgetChars: 500 };
    const result = injector.getRelevantPrinciples(principles, ctx);
    const formatted = injector.formatForInjection(result[0]);
    expect(formatted).toBe('- [P0-1] P0: Always validate input before processing.');
  });

  it('P0 forced inclusion works even with tight budget', () => {
    const principles = [
      createPrinciple({ id: 'P0-1', text: 'P0: This is a very long principle text that exceeds tight budget.', priority: 'P0', createdAt: '2026-04-17T01:00:00.000Z' }),
      createPrinciple({ id: 'P1-1', text: 'P1: Should not fit in tight budget.', priority: 'P1', createdAt: '2026-04-17T02:00:00.000Z' }),
    ];
    const ctx: InjectionContext = { domain: 'code-review', sessionId: 'sess-1', budgetChars: 10 };
    const result = injector.getRelevantPrinciples(principles, ctx);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].priority).toBe('P0'); // P0 still included
  });

  it('Full pipeline with 3 domains (coding, writing, code-review) principles', () => {
    // Simulate multi-domain principle store
    const allPrinciples: InjectablePrinciple[] = [
      { id: 'P0-coding-1', text: 'P0: Validate input before processing.', priority: 'P0', createdAt: '2026-04-17T00:00:00.000Z' },
      { id: 'P0-writing-1', text: 'P0: Maintain narrative coherence.', priority: 'P0', createdAt: '2026-04-17T00:30:00.000Z' },
      { id: 'P0-review-1', text: 'P0: Security changes require review.', priority: 'P0', createdAt: '2026-04-17T01:00:00.000Z' },
      { id: 'P1-coding-1', text: 'P1: Check file exists before writing.', priority: 'P1', createdAt: '2026-04-17T02:00:00.000Z' },
      { id: 'P1-review-1', text: 'P1: Large diffs need explicit approval.', priority: 'P1', createdAt: '2026-04-17T03:00:00.000Z' },
    ];

    const ctx: InjectionContext = {
      domain: 'code-review',  // Domain is informational only
      sessionId: 'sess-multi-domain',
      budgetChars: 300,
    };

    const result = injector.getRelevantPrinciples(allPrinciples, ctx);

    // P0 principles are always included regardless of domain
    expect(result.filter(p => p.priority === 'P0').length).toBe(3);
    // P1/P2 selected within budget
    const totalChars = result.reduce((sum, p) => sum + injector.formatForInjection(p).length, 0);
    expect(totalChars).toBeLessThanOrEqual(ctx.budgetChars);
  });

  it('PainSignal context is preserved through injection pipeline', () => {
    const event = createReviewEvent();
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();

    // The signal's context should contain review-specific data
    expect((signal!.context as Record<string, unknown>).primaryTrigger).toBeDefined();
    expect((signal!.context as Record<string, unknown>).authorId).toBe('author-1');
    expect((signal!.context as Record<string, unknown>).reviewerIds).toContain('reviewer-1');
    expect((signal!.context as Record<string, unknown>).affectedFileCount).toBe(1);
    expect((signal!.context as Record<string, unknown>).hasTests).toBe(false);
    expect((signal!.context as Record<string, unknown>).isBreakingChange).toBe(true);
  });
});