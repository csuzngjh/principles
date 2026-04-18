/**
 * Code review event types for principles-core.
 *
 * Per D-01: Code review is an extreme non-coding domain.
 * Pain signals come from human judgment, not tool failures.
 */

/**
 * Types of pain triggers in code review.
 */
export type ReviewPainTriggerType =
  | 'diff_complexity'      // Large/hard diffs
  | 'negative_sentiment'  // Hostile or dismissive comments
  | 'process_violation';  // Policy breaches (no tests, security issues)

/**
 * Represents a single review comment or comment thread.
 */
export interface ReviewComment {
  id: string;
  authorId: string;
  body: string;
  sentimentScore: number;    // -100 (negative) to +100 (positive)
  createdAt: string;         // ISO 8601
  resolvedAt?: string;        // ISO 8601, undefined if unresolved
  filePath?: string;         // File under review (if line comment)
}

/**
 * File changed in a PR/review.
 */
export interface ChangedFile {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  changeMagnitude: number;   // linesAdded + linesDeleted
}

/**
 * Structured code review event.
 */
export interface ReviewEvent {
  prId: string;
  repositoryId: string;
  authorId: string;
  reviewerIds: string[];
  filesChanged: ChangedFile[];
  totalLinesAdded: number;
  totalLinesDeleted: number;
  comments: ReviewComment[];
  unresolvedThreadCount: number;
  createdAt: string;
  reviewAgeDays: number;
  hasTests: boolean;
  hasSecurityReview: boolean;
  isBreakingChange: boolean;
  labels: string[];
  sessionId: string;
  traceId?: string;
}
