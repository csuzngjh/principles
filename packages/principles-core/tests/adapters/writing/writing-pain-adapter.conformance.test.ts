/**
 * WritingPainAdapter Conformance Tests
 *
 * Runs the PainAdapterConformance suite against WritingPainAdapter.
 */
import { describePainAdapterConformance } from '../../conformance/pain-adapter-conformance.js';
import { WritingPainAdapter } from '../../../src/adapters/writing/writing-pain-adapter.js';
import type { TextAnalysisResult } from '../../../src/adapters/writing/writing-types.js';

describePainAdapterConformance<TextAnalysisResult>(
  'WritingPainAdapter',
  () => new WritingPainAdapter(),
  {
    validFailureEvent: {
      issueType: 'style_inconsistency',
      severityScore: 65,
      description: 'Passive voice overuse detected',
      excerpt: 'The door was opened by her repeatedly.',
      sessionId: 'sess-write-conf-1',
    },
    nonFailureEvent: {
      // WritingPainAdapter returns null when sessionId is empty string
      issueType: 'style_inconsistency',
      severityScore: 65,
      description: 'Some issue',
      excerpt: 'Some excerpt',
      sessionId: '', // Empty sessionId is malformed for the adapter
    } as any,
    malformedEvent: {
      issueType: 'invalid_type' as any,
      severityScore: 50,
      description: 'test',
      excerpt: 'test',
      sessionId: '', // Empty sessionId is malformed
    },
    domain: 'writing',
  },
);
