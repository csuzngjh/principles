import { describe, it, expect } from 'vitest';
import { WritingPainAdapter } from '../writing/writing-pain-adapter.js';
import { deriveSeverity } from '../../pain-signal.js';
import type { TextAnalysisResult } from '../writing/writing-types.js';

describe('WritingPainAdapter', () => {
  const adapter = new WritingPainAdapter();

  const baseEvent: TextAnalysisResult = {
    issueType: 'style_inconsistency',
    severityScore: 65,
    description: 'Mixed formal and informal tone',
    excerpt: 'The product is great. It rocks!',
    sessionId: 'sess-123',
  };

  // ---------------------------------------------------------------------------
  // Null-return paths
  // ---------------------------------------------------------------------------

  it('returns null for missing issueType', () => {
    const event = { ...baseEvent, issueType: undefined } as unknown as TextAnalysisResult;
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for missing severityScore', () => {
    const event = { ...baseEvent, severityScore: undefined } as unknown as TextAnalysisResult;
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for severityScore < 0', () => {
    const event = { ...baseEvent, severityScore: -1 };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for severityScore > 100', () => {
    const event = { ...baseEvent, severityScore: 101 };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for non-number severityScore', () => {
    const event = { ...baseEvent, severityScore: 'high' as unknown as number };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for missing sessionId', () => {
    const event = { ...baseEvent, sessionId: '' };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for sessionId that is not a string', () => {
    const event = { ...baseEvent, sessionId: 42 as unknown as string };
    expect(adapter.capture(event)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Valid events
  // ---------------------------------------------------------------------------

  it('returns correct PainSignal for a valid event', () => {
    const signal = adapter.capture(baseEvent);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.source).toBe('style_inconsistency');
    expect(signal.score).toBe(65);
    expect(signal.domain).toBe('writing');
    expect(signal.sessionId).toBe('sess-123');
    expect(signal.agentId).toBe('writing-evaluator');
    expect(signal.traceId).toBe('unknown');
    expect(signal.reason).toBe('Style inconsistency: Mixed formal and informal tone');
    expect(signal.severity).toBe(deriveSeverity(65));
    expect(signal.timestamp).toBeTruthy();
    expect(new Date(signal.timestamp).toISOString()).toBe(signal.timestamp);
  });

  it('rounds severityScore to integer', () => {
    const event = { ...baseEvent, severityScore: 72.7 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.score).toBe(73);
  });

  // ---------------------------------------------------------------------------
  // All issue types
  // ---------------------------------------------------------------------------

  it('handles text_coherence_violation issue type', () => {
    const event: TextAnalysisResult = {
      ...baseEvent,
      issueType: 'text_coherence_violation',
      description: 'Paragraphs lack logical flow',
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.source).toBe('text_coherence_violation');
    expect(signal.reason).toBe('Text coherence violation: Paragraphs lack logical flow');
  });

  it('handles style_inconsistency issue type', () => {
    const event: TextAnalysisResult = {
      ...baseEvent,
      issueType: 'style_inconsistency',
      description: 'Mixed styles detected',
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.source).toBe('style_inconsistency');
    expect(signal.reason).toBe('Style inconsistency: Mixed styles detected');
  });

  it('handles narrative_arc_break issue type', () => {
    const event: TextAnalysisResult = {
      ...baseEvent,
      issueType: 'narrative_arc_break',
      description: 'Story arc is broken',
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.source).toBe('narrative_arc_break');
    expect(signal.reason).toBe('Narrative arc break: Story arc is broken');
  });

  it('handles tone_mismatch issue type', () => {
    const event: TextAnalysisResult = {
      ...baseEvent,
      issueType: 'tone_mismatch',
      description: 'Tone shifts unexpectedly',
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.source).toBe('tone_mismatch');
    expect(signal.reason).toBe('Tone mismatch: Tone shifts unexpectedly');
  });

  // ---------------------------------------------------------------------------
  // triggerTextPreview truncation
  // ---------------------------------------------------------------------------

  it('truncates triggerTextPreview to 200 chars', () => {
    const longExcerpt = 'x'.repeat(300);
    const event: TextAnalysisResult = {
      ...baseEvent,
      excerpt: longExcerpt,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.triggerTextPreview).toBe(longExcerpt.slice(0, 200));
    expect(signal.triggerTextPreview.length).toBe(200);
  });

  it('preserves triggerTextPreview under 200 chars', () => {
    const shortExcerpt = 'Short text here';
    const event: TextAnalysisResult = {
      ...baseEvent,
      excerpt: shortExcerpt,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.triggerTextPreview).toBe(shortExcerpt);
  });

  // ---------------------------------------------------------------------------
  // Severity derivation
  // ---------------------------------------------------------------------------

  it('derives low severity for score < 40', () => {
    const event = { ...baseEvent, severityScore: 25 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.severity).toBe('low');
    expect(signal.severity).toBe(deriveSeverity(25));
  });

  it('derives medium severity for score 40-69', () => {
    const event = { ...baseEvent, severityScore: 55 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.severity).toBe('medium');
    expect(signal.severity).toBe(deriveSeverity(55));
  });

  it('derives high severity for score 70-89', () => {
    const event = { ...baseEvent, severityScore: 78 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.severity).toBe('high');
    expect(signal.severity).toBe(deriveSeverity(78));
  });

  it('derives critical severity for score >= 90', () => {
    const event = { ...baseEvent, severityScore: 95 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.severity).toBe('critical');
    expect(signal.severity).toBe(deriveSeverity(95));
  });

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------

  it('includes issueType and excerptLength in context', () => {
    const event: TextAnalysisResult = {
      ...baseEvent,
      excerpt: 'Hello world',
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.context.issueType).toBe('style_inconsistency');
    expect(signal.context.excerptLength).toBe(11);
  });

  // ---------------------------------------------------------------------------
  // traceId
  // ---------------------------------------------------------------------------

  it('uses provided traceId', () => {
    const event: TextAnalysisResult = { ...baseEvent, traceId: 'trace-abc' };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.traceId).toBe('trace-abc');
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('accepts severityScore of 0', () => {
    const event = { ...baseEvent, severityScore: 0 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.score).toBe(0);
  });

  it('accepts severityScore of 100', () => {
    const event = { ...baseEvent, severityScore: 100 };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    if (!signal) throw new Error('Expected non-null signal');
    expect(signal.score).toBe(100);
  });
});
