/**
 * CodeReviewPainAdapter Conformance Test Suite
 *
 * Validates CodeReviewPainAdapter satisfies PainSignalAdapter<ReviewEvent> contract.
 * Uses the describePainAdapterConformance factory from the conformance suite.
 */
import { describePainAdapterConformance } from '../../conformance/pain-adapter-conformance.js';
import { CodeReviewPainAdapter } from '../../../src/adapters/code-review/code-review-pain-adapter.js';
import type { ReviewEvent } from '../../../src/adapters/code-review/review-event-types.js';

describePainAdapterConformance<ReviewEvent>(
  'CodeReviewPainAdapter',
  () => new CodeReviewPainAdapter(),
  {
    // Valid failure event: high-pain security scenario
    validFailureEvent: {
      prId: 'pr-101',
      repositoryId: 'repo-1',
      authorId: 'author-1',
      reviewerIds: ['reviewer-1'],
      filesChanged: [
        { path: 'src/auth/jwt.ts', linesAdded: 80, linesDeleted: 40, changeMagnitude: 120 },
        { path: 'src/auth/session.ts', linesAdded: 60, linesDeleted: 20, changeMagnitude: 80 },
      ],
      totalLinesAdded: 140,
      totalLinesDeleted: 60,
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
      sessionId: 'sess-review-1',
      traceId: 'trace-review-1',
    } as ReviewEvent,
    // Non-failure: empty filesChanged + empty comments → returns null (malformed per adapter logic)
    // Per RESEARCH.md: review events don't have a natural "non-failure" equivalent.
    // We use an empty event that the adapter treats as "nothing to review" → returns null.
    nonFailureEvent: {
      prId: 'pr-baseline',
      repositoryId: 'repo-1',
      authorId: 'author-1',
      reviewerIds: ['reviewer-1'],
      filesChanged: [],
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      comments: [],
      unresolvedThreadCount: 0,
      createdAt: '2026-04-17T10:00:00.000Z',
      reviewAgeDays: 0,
      hasTests: true,
      hasSecurityReview: true,
      isBreakingChange: false,
      labels: [],
      sessionId: 'sess-baseline',
      traceId: 'trace-baseline',
    } as ReviewEvent,
    // Malformed: missing sessionId
    malformedEvent: { prId: 'pr-1', repositoryId: 'repo-1' } as any,
    domain: 'code-review',
  },
);