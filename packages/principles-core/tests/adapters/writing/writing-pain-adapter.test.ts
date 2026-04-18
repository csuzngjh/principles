import { describe, it, expect, beforeEach } from 'vitest';
import { WritingPainAdapter } from '../../../src/adapters/writing/writing-pain-adapter.js';
import { validatePainSignal } from '../../../src/pain-signal.js';

describe('WritingPainAdapter', () => {
  let adapter: WritingPainAdapter;

  beforeEach(() => {
    adapter = new WritingPainAdapter();
  });

  function createValidAnalysis(overrides = {}) {
    return {
      issueType: 'style_inconsistency' as const,
      severityScore: 65,
      description: 'Passive voice overuse in paragraph 3',
      excerpt: 'The door was opened by her.',
      sessionId: 'sess-writing-1',
      ...overrides,
    };
  }

  describe('capture()', () => {
    it('returns valid PainSignal for style_inconsistency', () => {
      const event = createValidAnalysis({ issueType: 'style_inconsistency' });
      const result = adapter.capture(event);
      expect(result).not.toBeNull();
      expect(result!.source).toBe('style_inconsistency');
      expect(result!.domain).toBe('writing');
      expect(result!.score).toBe(65);
      expect(result!.severity).toBe('medium');
    });

    it('returns valid PainSignal for text_coherence_violation', () => {
      const event = createValidAnalysis({ issueType: 'text_coherence_violation', severityScore: 80 });
      const result = adapter.capture(event);
      expect(result!.source).toBe('text_coherence_violation');
      expect(result!.severity).toBe('high');
    });

    it('returns valid PainSignal for narrative_arc_break', () => {
      const event = createValidAnalysis({ issueType: 'narrative_arc_break', severityScore: 55 });
      const result = adapter.capture(event);
      expect(result!.source).toBe('narrative_arc_break');
      expect(result!.severity).toBe('medium');
    });

    it('returns valid PainSignal for tone_mismatch', () => {
      const event = createValidAnalysis({ issueType: 'tone_mismatch', severityScore: 72 });
      const result = adapter.capture(event);
      expect(result!.source).toBe('tone_mismatch');
      expect(result!.severity).toBe('high');
    });

    it('returns null for missing issueType', () => {
      const event = createValidAnalysis();
      delete (event as any).issueType;
      expect(adapter.capture(event)).toBeNull();
    });

    it('returns null for missing sessionId', () => {
      const event = createValidAnalysis();
      delete (event as any).sessionId;
      expect(adapter.capture(event)).toBeNull();
    });

    it('returns null for severityScore < 0', () => {
      const event = createValidAnalysis({ severityScore: -1 });
      expect(adapter.capture(event)).toBeNull();
    });

    it('returns null for severityScore > 100', () => {
      const event = createValidAnalysis({ severityScore: 101 });
      expect(adapter.capture(event)).toBeNull();
    });

    it('output passes validatePainSignal()', () => {
      const event = createValidAnalysis();
      const result = adapter.capture(event);
      expect(result).not.toBeNull();
      const validation = validatePainSignal(result);
      expect(validation.valid).toBe(true);
    });

    it('sets domain to writing', () => {
      const result = adapter.capture(createValidAnalysis());
      expect(result!.domain).toBe('writing');
    });

    it('sets agentId to writing-evaluator', () => {
      const result = adapter.capture(createValidAnalysis());
      expect(result!.agentId).toBe('writing-evaluator');
    });

    it('truncates triggerTextPreview to 200 chars', () => {
      const longExcerpt = 'a'.repeat(300);
      const result = adapter.capture(createValidAnalysis({ excerpt: longExcerpt }));
      expect(result!.triggerTextPreview.length).toBe(200);
      expect(result!.triggerTextPreview).toBe('a'.repeat(200));
    });

    it('includes issueType in context', () => {
      const result = adapter.capture(createValidAnalysis({ issueType: 'narrative_arc_break' }));
      expect(result!.context.issueType).toBe('narrative_arc_break');
    });

    it('uses provided traceId when available', () => {
      const result = adapter.capture(createValidAnalysis({ traceId: 'trace-789' }));
      expect(result!.traceId).toBe('trace-789');
    });

    it('defaults traceId to unknown when not provided', () => {
      const result = adapter.capture(createValidAnalysis());
      expect(result!.traceId).toBe('unknown');
    });
  });
});
