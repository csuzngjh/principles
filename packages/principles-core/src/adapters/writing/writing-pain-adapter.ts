import type { PainSignalAdapter } from '../../pain-signal-adapter.js';
import type { PainSignal } from '../../pain-signal.js';
import { deriveSeverity } from '../../pain-signal.js';
import type { TextAnalysisResult, WritingIssueType } from './writing-types.js';

/**
 * Writing domain PainSignal adapter.
 *
 * Translates upstream text quality analysis results into PainSignals.
 * Per D-02: pure translation only. No LLM calls, no quality evaluation.
 *
 * @example
 * const adapter = new WritingPainAdapter();
 * const analysis = { issueType: 'style_inconsistency', severityScore: 65, description: '...', excerpt: '...', sessionId: 'sess-1' };
 * const signal = adapter.capture(analysis);
 */
export class WritingPainAdapter implements PainSignalAdapter<TextAnalysisResult> {
  capture(rawEvent: TextAnalysisResult): PainSignal | null {
    // Malformed: missing required fields
    if (!rawEvent.issueType || rawEvent.severityScore === undefined) {
      return null;
    }

    // Malformed: severityScore out of range
    if (
      typeof rawEvent.severityScore !== 'number' ||
      rawEvent.severityScore < 0 ||
      rawEvent.severityScore > 100
    ) {
      return null;
    }

    // Malformed: missing sessionId
    if (!rawEvent.sessionId || typeof rawEvent.sessionId !== 'string') {
      return null;
    }

    // Derive score from upstream severityScore
    const score = Math.round(rawEvent.severityScore);

    return {
      source: rawEvent.issueType,
      score,
      timestamp: new Date().toISOString(),
      reason: this.buildReason(rawEvent.issueType, rawEvent.description),
      sessionId: rawEvent.sessionId,
      agentId: 'writing-evaluator',
      traceId: rawEvent.traceId ?? 'unknown',
      triggerTextPreview: rawEvent.excerpt.slice(0, 200),
      domain: 'writing',
      severity: deriveSeverity(score),
      context: {
        issueType: rawEvent.issueType,
        excerptLength: rawEvent.excerpt.length,
      },
    };
  }

  /**
   * Build human-readable reason string.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private buildReason(issueType: WritingIssueType, description: string): string {
    const labels: Record<WritingIssueType, string> = {
      text_coherence_violation: 'Text coherence violation',
      style_inconsistency: 'Style inconsistency',
      narrative_arc_break: 'Narrative arc break',
      tone_mismatch: 'Tone mismatch',
    };
    return `${labels[issueType]}: ${description}`;
  }
}
