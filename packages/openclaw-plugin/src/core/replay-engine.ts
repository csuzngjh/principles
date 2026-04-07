/**
 * Replay Engine — Offline Stress-Testing for Code Implementation Candidates
 * ========================================================================
 *
 * PURPOSE: Run a candidate implementation against classified nocturnal samples
 * to produce a structured evaluation report for manual promotion decisions.
 *
 * ARCHITECTURE:
 *   - Reads samples from nocturnal-dataset.ts classified registry
 *   - Runs candidate evaluate() against each sample
 *   - Produces ReplayReport with per-classification breakdown
 *   - Persists report under implementations/{implId}/replays/{timestamp}.json
 *
 * DESIGN CONSTRAINTS:
 *   - Does NOT create a parallel sample system — reuses nocturnal-dataset
 *   - All writes use withLock for atomicity
 *   - Reports are machine-readable for Phase 14/15 consumption
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import {
  listSamplesByClassification,
  loadSampleContent,
  generateSampleFingerprint,
} from './nocturnal-dataset.js';
import type { NocturnalDatasetRecord, SampleClassification } from './nocturnal-dataset.js';
import { findActiveImplementation, listImplementationsForRule } from './principle-tree-ledger.js';
import type { Implementation } from '../types/principle-tree-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A sample prepared for replay evaluation.
 */
export interface ReplaySample {
  /** Unique fingerprint from the nocturnal dataset */
  fingerprint: string;
  /** Classification: pain-negative, success-positive, or principle-anchor */
  classification: SampleClassification;
  /** Raw artifact content from the sample file */
  content: unknown;
  /** Expected outcome based on classification */
  expectedOutcome: {
    /** For pain-negative: expect block/denial */
    shouldBlock?: boolean;
    /** For success-positive: expect pass/allow */
    shouldPass?: boolean;
    /** For principle-anchor: expect principle-adherent behavior */
    expectedPrinciple?: string;
  };
}

/**
 * Result of replaying a single sample.
 */
export interface ReplayResult {
  /** Sample fingerprint */
  sampleFingerprint: string;
  /** Sample classification */
  classification: SampleClassification;
  /** Whether the candidate behaved correctly on this sample */
  passed: boolean;
  /** Reason for failure (empty if passed) */
  reason?: string;
  /** Decision outcome: blocked, passed, adhered, leaked, misfired, violated */
  decision: string;
}

/**
 * Per-classification aggregated results.
 */
export interface ClassificationSummary {
  total: number;
  passed: number;
  failed: number;
  details: ReplayResult[];
}

/**
 * Structured evaluation report produced by ReplayEngine.
 * Matches D-05 shape from Phase 13 context.
 */
export interface ReplayReport {
  /** Overall pass/fail/needs-review decision */
  overallDecision: 'pass' | 'fail' | 'needs-review';
  /** Per-classification breakdown */
  replayResults: {
    painNegative: ClassificationSummary;
    successPositive: ClassificationSummary;
    principleAnchor: ClassificationSummary;
  };
  /** Blocker reasons that contributed to fail/needs-review */
  blockers: string[];
  /** ISO timestamp of report generation */
  generatedAt: string;
  /** Implementation ID being evaluated */
  implementationId: string;
  /** Fingerprints of all samples used in this replay */
  sampleFingerprints: string[];
}

// ---------------------------------------------------------------------------
// Candidate Evaluation Interface
// ---------------------------------------------------------------------------

/**
 * Abstract interface for candidate evaluation.
 * Implementations should provide this to test against replay samples.
 */
export interface CandidateEvaluator {
  /**
   * Evaluate a sample against the candidate implementation.
   * Returns true if the candidate handled the sample correctly.
   */
  evaluate(sample: unknown): { passed: boolean; reason?: string; decision: string };
}

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

/**
 * ReplayEngine runs candidate implementations against classified samples.
 *
 * Usage:
 *   const engine = new ReplayEngine(workspaceDir, stateDir);
 *   const report = engine.runReplay('IMPL_060_01_hook', evaluator, ['pain-negative', 'principle-anchor']);
 *   console.log(report.overallDecision); // 'pass' | 'fail' | 'needs-review'
 */
export class ReplayEngine {
  private readonly workspaceDir: string;
  private readonly stateDir: string;

  constructor(workspaceDir: string, stateDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = stateDir;
  }

  /**
   * Load samples by classification from the nocturnal dataset.
   */
  loadSamples(classifications: SampleClassification[]): ReplaySample[] {
    const samples: ReplaySample[] = [];

    for (const classification of classifications) {
      const records = listSamplesByClassification(this.workspaceDir, classification);

      for (const record of records) {
        try {
          const content = loadSampleContent(this.workspaceDir, record);
          const expectedOutcome = this._deriveExpectedOutcome(record, content);

          samples.push({
            fingerprint: record.sampleFingerprint,
            classification,
            content,
            expectedOutcome,
          });
        } catch (err) {
          // Log but continue — one bad sample shouldn't abort the entire replay
          console.warn(
            `[ReplayEngine] Skipping sample ${record.sampleFingerprint}: ${String(err)}`
          );
        }
      }
    }

    return samples;
  }

  /**
   * Run evaluation on a single sample.
   */
  runSingleSample(sample: ReplaySample, evaluator: CandidateEvaluator): ReplayResult {
    const evaluation = evaluator.evaluate(sample.content);

    // Determine if the result matches the expected outcome for this classification
    let passed: boolean;
    const decision = evaluation.decision;

    switch (sample.classification) {
      case 'pain-negative':
        // Pain-negative samples: candidate should BLOCK them
        passed = evaluation.passed;
        break;
      case 'success-positive':
        // Success-positive samples: candidate should PASS them (not produce false positive)
        passed = evaluation.passed;
        break;
      case 'principle-anchor':
        // Principle-anchor: candidate should adhere to principle
        passed = evaluation.passed;
        break;
      default:
        passed = evaluation.passed;
    }

    return {
      sampleFingerprint: sample.fingerprint,
      classification: sample.classification,
      passed,
      reason: passed ? undefined : evaluation.reason,
      decision,
    };
  }

  /**
   * Run a full replay over selected classifications for a candidate.
   */
  runReplay(
    candidateImplId: string,
    evaluator: CandidateEvaluator,
    classifications?: SampleClassification[]
  ): ReplayReport {
    const selectedClassifications: SampleClassification[] = classifications ?? [
      'pain-negative',
      'success-positive',
      'principle-anchor',
    ];

    const samples = this.loadSamples(selectedClassifications);
    const allResults: ReplayResult[] = [];
    let failed = false;

    for (const sample of samples) {
      const result = this.runSingleSample(sample, evaluator);
      allResults.push(result);
      if (!result.passed) failed = true;
    }

    // Build the report
    const report = this._buildReport(candidateImplId, allResults);

    // Persist the report
    this._persistReport(report);

    return report;
  }

  /**
   * Build a ReplayReport from raw results.
   */
  private _buildReport(
    implementationId: string,
    results: ReplayResult[]
  ): ReplayReport {
    const painNegative: ReplayResult[] = results.filter(
      (r) => r.classification === 'pain-negative'
    );
    const successPositive: ReplayResult[] = results.filter(
      (r) => r.classification === 'success-positive'
    );
    const principleAnchor: ReplayResult[] = results.filter(
      (r) => r.classification === 'principle-anchor'
    );

    const toSummary = (details: ReplayResult[]): ClassificationSummary => ({
      total: details.length,
      passed: details.filter((r) => r.passed).length,
      failed: details.filter((r) => !r.passed).length,
      details,
    });

    const painSummary = toSummary(painNegative);
    const successSummary = toSummary(successPositive);
    const anchorSummary = toSummary(principleAnchor);

    // Build blockers list
    const blockers: string[] = [];

    // Pain-negative leaks are critical failures
    const leakedPain = painSummary.details.filter(
      (r) => !r.passed && r.classification === 'pain-negative'
    );
    for (const lp of leakedPain) {
      blockers.push(
        `PAIN-NEGATIVE LEAK: Sample ${lp.sampleFingerprint} was not blocked. ${lp.reason ?? ''}`
      );
    }

    // Principle-anchor violations are critical failures
    const violatedAnchors = anchorSummary.details.filter(
      (r) => !r.passed && r.classification === 'principle-anchor'
    );
    for (const va of violatedAnchors) {
      blockers.push(
        `PRINCIPLE-ANCHOR VIOLATION: Sample ${va.sampleFingerprint} did not adhere. ${va.reason ?? ''}`
      );
    }

    // Success-positive false positives
    const falsePositives = successSummary.details.filter(
      (r) => !r.passed && r.classification === 'success-positive'
    );
    for (const fp of falsePositives) {
      blockers.push(
        `FALSE POSITIVE: Sample ${fp.sampleFingerprint} was incorrectly blocked. ${fp.reason ?? ''}`
      );
    }

    // Determine overall decision (D-08)
    const overallDecision = this._determineDecision(
      painSummary,
      successSummary,
      anchorSummary
    );

    return {
      overallDecision,
      replayResults: {
        painNegative: painSummary,
        successPositive: successSummary,
        principleAnchor: anchorSummary,
      },
      blockers,
      generatedAt: new Date().toISOString(),
      implementationId,
      sampleFingerprints: results.map((r) => r.sampleFingerprint),
    };
  }

  /**
   * Determine overall replay decision per D-08:
   * - fail: any pain-negative leaked, any principle-anchor violated
   * - needs-review: any success-positive false positive (non-critical)
   * - pass: everything correct
   */
  private _determineDecision(
    pain: ClassificationSummary,
    success: ClassificationSummary,
    anchor: ClassificationSummary
  ): 'pass' | 'fail' | 'needs-review' {
    // Critical: pain-negative leakage
    if (pain.failed > 0) return 'fail';
    // Critical: principle-anchor violated
    if (anchor.failed > 0) return 'fail';
    // Non-critical: success-positive false positives
    if (success.failed > 0) return 'needs-review';
    // All clear
    return 'pass';
  }

  /**
   * Persist report as versioned JSON under implementation storage.
   */
  private _persistReport(report: ReplayReport): void {
    const reportDir = path.join(
      this.stateDir,
      '.state',
      'principles',
      'implementations',
      report.implementationId,
      'replays'
    );

    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `${timestamp}.json`);

    withLock(reportPath, () => {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    });
  }

  /**
   * Derive expected outcome from sample classification and content.
   */
  private _deriveExpectedOutcome(
    record: NocturnalDatasetRecord,
    content: unknown
  ): ReplaySample['expectedOutcome'] {
    switch (record.classification) {
      case 'pain-negative':
        return { shouldBlock: true };
      case 'success-positive':
        return { shouldPass: true };
      case 'principle-anchor':
        return {
          expectedPrinciple: record.principleId,
        };
      default:
        return {};
    }
  }

  /**
   * List all replay reports for an implementation.
   */
  listReports(implementationId: string): ReplayReport[] {
    const reportDir = path.join(
      this.stateDir,
      '.state',
      'principles',
      'implementations',
      implementationId,
      'replays'
    );

    if (!fs.existsSync(reportDir)) return [];

    try {
      const files = fs.readdirSync(reportDir).filter((f) => f.endsWith('.json'));
      return files
        .sort()
        .reverse()
        .map((f) => {
          const content = fs.readFileSync(path.join(reportDir, f), 'utf-8');
          return JSON.parse(content) as ReplayReport;
        });
    } catch {
      return [];
    }
  }

  /**
   * Get the latest replay report for an implementation.
   */
  getLatestReport(implementationId: string): ReplayReport | null {
    const reports = this.listReports(implementationId);
    return reports.length > 0 ? reports[0] : null;
  }

  /**
   * Check if an implementation has at least one passing replay report.
   */
  hasPassingReport(implementationId: string): boolean {
    const reports = this.listReports(implementationId);
    return reports.some((r) => r.overallDecision === 'pass');
  }
}

// ---------------------------------------------------------------------------
// Report Formatting Helper
// ---------------------------------------------------------------------------

/**
 * Format a replay report as human-readable CLI output.
 */
export function formatReplayReport(report: ReplayReport): string {
  const lang = 'en'; // Bilingual support — default to en for now
  const isZh = lang === 'zh';

  const decisionEmoji =
    report.overallDecision === 'pass'
      ? 'PASS'
      : report.overallDecision === 'fail'
        ? 'FAIL'
        : 'NEEDS-REVIEW';

  let output = '';
  output += `${isZh ? '\n\ud83d\udccb \u56de\u653e\u8bc4\u4f30\u62a5\u544a' : '\nReplay Evaluation Report'}\n`;
  output += `${'='.repeat(50)}\n`;
  output += `Implementation: ${report.implementationId}\n`;
  output += `Generated At:   ${report.generatedAt}\n`;
  output += `Overall Decision: [${decisionEmoji}]\n\n`;

  const formatSection = (
    label: string,
    summary: ClassificationSummary
  ) => {
    const rate = summary.total > 0
      ? ((summary.passed / summary.total) * 100).toFixed(1)
      : 'N/A';
    let section = `  ${label}:\n`;
    section += `    Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}\n`;
    section += `    Pass Rate: ${rate}%\n`;
    if (summary.failed > 0) {
      section += `    Failures:\n`;
      for (const detail of summary.details.filter((d) => !d.passed)) {
        section += `      - ${detail.sampleFingerprint}: ${detail.reason ?? detail.decision}\n`;
      }
    }
    return section;
  };

  output += formatSection(
    isZh ? '\u75db\u70b9\u8d1f\u9762\u6837\u672c' : 'Pain-Negative Samples',
    report.replayResults.painNegative
  );
  output += formatSection(
    isZh ? '\u6210\u529f\u6b63\u9762\u6837\u672c' : 'Success-Positive Samples',
    report.replayResults.successPositive
  );
  output += formatSection(
    isZh ? '\u539f\u5219\u951a\u70b9\u6837\u672c' : 'Principle-Anchor Samples',
    report.replayResults.principleAnchor
  );

  if (report.blockers.length > 0) {
    output += `\n${isZh ? '\u963b\u585e\u56e0\u7d20' : 'Blockers'}:\n`;
    for (const b of report.blockers) {
      output += `  - ${b}\n`;
    }
  }

  output += `${'='.repeat(50)}\n`;
  return output;
}
