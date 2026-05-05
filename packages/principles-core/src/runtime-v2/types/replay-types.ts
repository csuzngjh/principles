/**
 * Replay report types — pure data interfaces for replay evaluation reports.
 * Extracted from openclaw-plugin replay-engine.ts + nocturnal-dataset.ts (PRI-51).
 */
import type { SampleClassification } from './principle-enums.js';

export interface ReplayResult {
  sampleFingerprint: string;
  classification: SampleClassification;
  passed: boolean;
  reason?: string;
  decision: string;
}

export interface ClassificationSummary {
  total: number;
  passed: number;
  failed: number;
  details: ReplayResult[];
}

export interface ReplayReport {
  overallDecision: 'pass' | 'fail' | 'needs-review';
  replayResults: {
    painNegative: ClassificationSummary;
    successPositive: ClassificationSummary;
    principleAnchor: ClassificationSummary;
  };
  blockers: string[];
  evidenceSummary: {
    evidenceStatus: 'observed' | 'empty';
    totalSamples: number;
    classifiedCounts: {
      painNegative: number;
      successPositive: number;
      principleAnchor: number;
    };
  };
  generatedAt: string;
  implementationId: string;
  sampleFingerprints: string[];
}
