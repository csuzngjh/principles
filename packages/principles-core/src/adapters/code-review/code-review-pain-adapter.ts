import type { PainSignalAdapter } from '../../pain-signal-adapter.js';
import type { PainSignal } from '../../pain-signal.js';
import { deriveSeverity } from '../../pain-signal.js';
import type { ReviewEvent, ReviewComment, ChangedFile, ReviewPainTriggerType } from './review-event-types.js';

const NEGATIVE_KEYWORDS = [
  'wrong', 'broken', 'bad', 'terrible', 'awful',
  'frustrat', 'annoy', 'dismiss', 'reject',
  'this is a problem', 'lgtm but', 'almost',
];

const SECURITY_LABELS = ['security', 'CVE', 'vulnerability', 'auth', 'crypto'];

export class CodeReviewPainAdapter implements PainSignalAdapter<ReviewEvent> {
  capture(rawEvent: ReviewEvent): PainSignal | null {
    // Malformed: missing sessionId
    if (!rawEvent.sessionId || typeof rawEvent.sessionId !== 'string') {
      return null;
    }
    // Malformed: nothing to review
    if (
      (!rawEvent.filesChanged || rawEvent.filesChanged.length === 0) &&
      (!rawEvent.comments || rawEvent.comments.length === 0)
    ) {
      return null;
    }
    // Malformed: negative review age
    if (typeof rawEvent.reviewAgeDays === 'number' && rawEvent.reviewAgeDays < 0) {
      return null;
    }

    const complexityScore = this.deriveComplexityScore(rawEvent);
    const sentimentScore = this.deriveSentimentScore(rawEvent);
    const processViolationScore = this.deriveProcessViolationScore(rawEvent);

    const score = Math.round(
      0.25 * complexityScore +
      0.35 * sentimentScore +
      0.40 * processViolationScore
    );

    const primaryTrigger = this.derivePrimaryTrigger(
      complexityScore,
      sentimentScore,
      processViolationScore
    );

    const topNegativeComment = this.findTopNegativeComment(rawEvent.comments);
    const triggerTextPreview = topNegativeComment
      ?? `Process violation: ${primaryTrigger}`;

    const avgSentiment = rawEvent.comments.length > 0
      ? rawEvent.comments.reduce((sum, c) => sum + c.sentimentScore, 0) / rawEvent.comments.length
      : 0;

    return {
      source: primaryTrigger,
      score: Math.max(0, Math.min(100, score)),
      timestamp: new Date().toISOString(),
      reason: this.buildReason(primaryTrigger, rawEvent),
      sessionId: rawEvent.sessionId,
      agentId: 'code-review-evaluator',
      traceId: rawEvent.traceId ?? 'unknown',
      triggerTextPreview: triggerTextPreview.slice(0, 200),
      domain: 'code-review',
      severity: deriveSeverity(score),
      context: {
        primaryTrigger,
        diffComplexityScore: complexityScore,
        sentimentScore,
        processViolationScore,
        authorId: rawEvent.authorId,
        reviewerIds: rawEvent.reviewerIds ?? [],
        affectedFileCount: rawEvent.filesChanged?.length ?? 0,
        affectedFiles: (rawEvent.filesChanged ?? []).slice(0, 10).map(f => f.path),
        totalCommentCount: rawEvent.comments?.length ?? 0,
        unresolvedThreadCount: rawEvent.unresolvedThreadCount ?? 0,
        avgSentiment: Math.round(avgSentiment),
        hasTests: rawEvent.hasTests ?? false,
        isBreakingChange: rawEvent.isBreakingChange ?? false,
        reviewAgeDays: rawEvent.reviewAgeDays ?? 0,
      },
    };
  }

  private deriveComplexityScore(event: ReviewEvent): number {
    const fileCount = event.filesChanged?.length ?? 0;
    const totalChanges = (event.totalLinesAdded ?? 0) + (event.totalLinesDeleted ?? 0);
    const avgMagnitude = fileCount > 0
      ? (event.filesChanged ?? []).reduce((sum, f) => sum + (f.changeMagnitude ?? 0), 0) / fileCount
      : 0;
    const complexity = fileCount * avgMagnitude;
    if (complexity < 500)  return Math.round(complexity / 500 * 40);
    if (complexity < 2000) return Math.round(40 + (complexity - 500) / 1500 * 25);
    if (complexity < 5000) return Math.round(65 + (complexity - 2000) / 3000 * 20);
    return Math.min(100, 85 + (complexity - 5000) / 5000 * 15);
  }

  private deriveSentimentScore(event: ReviewEvent): number {
    const negativeComments = (event.comments ?? []).filter(c => {
      const body = c.body?.toLowerCase() ?? '';
      return NEGATIVE_KEYWORDS.some(k => body.includes(k));
    });
    const unresolvedNegative = negativeComments.filter(c => !c.resolvedAt);
    const recencyDays = event.reviewAgeDays ?? 0;
    const recencyMultiplier = recencyDays > 7 ? 1.5 : 1.0;
    const negativeCount = unresolvedNegative.length * recencyMultiplier;
    const avgSentiment = (event.comments ?? []).length > 0
      ? (event.comments ?? []).reduce((sum, c) => sum + (c.sentimentScore ?? 0), 0) / (event.comments ?? []).length
      : 0;
    const sentimentPain = Math.round((100 - avgSentiment) / 2);
    const commentPain = Math.min(50, negativeCount * 15);
    return Math.min(100, sentimentPain + commentPain);
  }

  private deriveProcessViolationScore(event: ReviewEvent): number {
    let score = 0;
    const fileCount = event.filesChanged?.length ?? 0;
    const totalLines = (event.totalLinesAdded ?? 0) + (event.totalLinesDeleted ?? 0);
    const hasTests = event.hasTests ?? false;
    if (!hasTests && fileCount > 2) score += 35;
    if (event.isBreakingChange && !(event.labels ?? []).some(l => l.includes('breaking'))) score += 40;
    const hasSecurityChanges = (event.filesChanged ?? []).some(f =>
      SECURITY_LABELS.some(s => (f.path ?? '').toLowerCase().includes(s))
    );
    if (hasSecurityChanges && !(event.hasSecurityReview ?? false)) score += 50;
    if (totalLines > 500 && !hasTests) score += 20;
    return Math.min(100, score);
  }

  private derivePrimaryTrigger(complexity: number, sentiment: number, process: number): ReviewPainTriggerType {
    if (process >= 40) return 'process_violation';
    if (sentiment >= 40) return 'negative_sentiment';
    return 'diff_complexity';
  }

  private findTopNegativeComment(comments: ReviewComment[]): string | null {
    if (!comments || comments.length === 0) return null;
    const negative = comments.filter(c => (c.sentimentScore ?? 0) < 0);
    if (negative.length === 0) return null;
    negative.sort((a, b) => (a.sentimentScore ?? 0) - (b.sentimentScore ?? 0));
    return negative[0]?.body ?? null;
  }

  private buildReason(trigger: ReviewPainTriggerType, event: ReviewEvent): string {
    const reasons: Record<ReviewPainTriggerType, string> = {
      diff_complexity: `Diff complexity pain in ${event.filesChanged?.length ?? 0} files, ${(event.totalLinesAdded ?? 0) + (event.totalLinesDeleted ?? 0)} lines changed`,
      negative_sentiment: `Negative review sentiment: ${event.unresolvedThreadCount ?? 0} unresolved threads`,
      process_violation: `Process violation: no tests=${!event.hasTests}, breaking=${event.isBreakingChange}, security_review=${event.hasSecurityReview}`,
    };
    return reasons[trigger];
  }
}
