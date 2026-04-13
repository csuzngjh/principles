import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { normalizePath, isRisky, planStatus as getPlanStatus } from '../utils/io.js';
import {
  listSamplesByClassification,
  loadSampleContent,
} from './nocturnal-dataset.js';
import {
  getImplementationAssetRoot,
  loadEntrySource,
} from './code-implementation-storage.js';
import type {
  NocturnalDatasetRecord,
  SampleClassification,
} from './nocturnal-dataset.js';
import { loadLedger } from './principle-tree-ledger.js';
import type { Implementation } from '../types/principle-tree-schema.js';
import type { RuleHostHelpers } from './rule-host-helpers.js';
import { createRuleHostHelpers } from './rule-host-helpers.js';
import type { RuleHostInput, RuleHostResult } from './rule-host-types.js';
import { loadRuleImplementationModule } from './rule-implementation-runtime.js';
import {
  getNocturnalSessionSnapshot,
  type NocturnalGateBlock,
  type NocturnalSessionSnapshot,
  type NocturnalToolCall,
} from './nocturnal-trajectory-extractor.js';
import { TrajectoryRegistry } from './trajectory.js';

export interface ReplaySample {
  fingerprint: string;
  classification: SampleClassification;
  content: unknown;
  expectedOutcome: {
    shouldBlock?: boolean;
    shouldPass?: boolean;
    expectedPrinciple?: string;
  };
  record: NocturnalDatasetRecord;
}

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

export interface CandidateEvaluator {
   
  evaluate(sample: unknown): { passed: boolean; reason?: string; decision: string };
   
}

export class ReplayEngine {
  private readonly workspaceDir: string;
  private readonly stateDir: string;

  constructor(workspaceDir: string, stateDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = stateDir;
  }

  loadSamples(classifications: SampleClassification[]): ReplaySample[] {
    const samples: ReplaySample[] = [];

    for (const classification of classifications) {
      const records = listSamplesByClassification(this.workspaceDir, classification);

      for (const record of records) {
        try {
          const content = loadSampleContent(this.workspaceDir, record);
          const expectedOutcome = this._deriveExpectedOutcome(record);

          samples.push({
            fingerprint: record.sampleFingerprint,
            classification,
            content,
            expectedOutcome,
            record,
          });
        } catch (err) {
          console.warn(
            `[ReplayEngine] Skipping sample ${record.sampleFingerprint}: ${String(err)}`
          );
        }
      }
    }

    return samples;
  }

   
  runSingleSample(sample: ReplaySample, evaluator: CandidateEvaluator): ReplayResult {
    const evaluation = evaluator.evaluate(sample);
    return {
      sampleFingerprint: sample.fingerprint,
      classification: sample.classification,
      passed: evaluation.passed,
      reason: evaluation.passed ? undefined : evaluation.reason,
      decision: evaluation.decision,
    };
  }

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
    const allResults = samples.map((sample) => this.runSingleSample(sample, evaluator));
    const report = this._buildReport(candidateImplId, allResults);
    this._persistReport(report);
    return report;
  }

  runReplayForImplementation(
    implementationId: string,
    classifications?: SampleClassification[],
  ): ReplayReport {
    const implementation = this._getImplementationById(implementationId);
    if (!implementation) {
      throw new Error(`Implementation not found: ${implementationId}`);
    }

    const evaluator = this._createEvaluatorForImplementation(implementation);
    return this.runReplay(implementationId, evaluator, classifications);
  }

  listReports(implementationId: string): ReplayReport[] {
    const reportDir = path.join(
      getImplementationAssetRoot(this.stateDir, implementationId),
      'replays'
    );

    if (!fs.existsSync(reportDir)) return [];

    try {
      const files = fs.readdirSync(reportDir).filter((file) => file.endsWith('.json'));
      return files
        .sort()
        .reverse()
        .map((file) => {
          const content = fs.readFileSync(path.join(reportDir, file), 'utf-8');
          return JSON.parse(content) as ReplayReport;
        });
    } catch {
      return [];
    }
  }

  getLatestReport(implementationId: string): ReplayReport | null {
    const reports = this.listReports(implementationId);
    return reports.length > 0 ? reports[0] : null;
  }

  hasPassingReport(implementationId: string): boolean {
    return this.listReports(implementationId).some((report) => report.overallDecision === 'pass');
  }

  private _getImplementationById(implementationId: string): Implementation | null {
    const ledger = loadLedger(this.stateDir);
    return ledger.tree.implementations[implementationId] ?? null;
  }

  private _createEvaluatorForImplementation(implementation: Implementation): CandidateEvaluator {
    const sourceCode = loadEntrySource(this.stateDir, implementation.id);
    if (!sourceCode) {
      throw new Error(`Implementation asset entry source missing: ${implementation.id}`);
    }

    const moduleExports = loadRuleImplementationModule(sourceCode, implementation.id);
    if (typeof moduleExports.evaluate !== 'function') {
      throw new Error(`Implementation ${implementation.id} does not export evaluate().`);
    }

     
    const evaluate = moduleExports.evaluate as (
      _input: RuleHostInput,
      _helpers: RuleHostHelpers,
    ) => RuleHostResult;
     

    return {
      evaluate: (sample: unknown) => {
        const replaySample = sample as ReplaySample;
        const input = this._buildRuleHostInput(replaySample);
        if (!input) {
          return {
            passed: false,
            reason: `Could not build replay input for sample ${replaySample.fingerprint}.`,
            decision: 'replay-input-missing',
          };
        }

        const result = evaluate(input, createRuleHostHelpers(input));
        return this._scoreEvaluation(replaySample, result);
      },
    };
  }

    // eslint-disable-next-line complexity -- complexity 13, refactor candidate
  private _buildRuleHostInput(sample: ReplaySample): RuleHostInput | null {
    const snapshot = getNocturnalSessionSnapshot(
      TrajectoryRegistry.get(this.workspaceDir),
      sample.record.sessionId,
    );
    if (!snapshot) {
      return null;
    }

    const toolCall = this._selectToolCall(snapshot, sample.classification);
    if (!toolCall) {
      return null;
    }

    const normalizedPath =
      typeof toolCall.filePath === 'string' && toolCall.filePath.length > 0
        ? normalizePath(toolCall.filePath, this.workspaceDir)
        : null;
    const matchedGateBlock = this._matchGateBlock(snapshot.gateBlocks, toolCall);

    return {
      action: {
        toolName: toolCall.toolName,
        normalizedPath,
        paramsSummary: {
          artifactId: sample.record.artifactId,
          sourceSnapshotRef: sample.record.sourceSnapshotRef,
          classification: sample.classification,
        },
      },
      workspace: {
        isRiskPath:
          Boolean(matchedGateBlock) ||
          (normalizedPath !== null && this._isRiskPath(normalizedPath)),
        planStatus:
          matchedGateBlock?.planStatus === 'READY' ||
          matchedGateBlock?.planStatus === 'DRAFT' ||
          matchedGateBlock?.planStatus === 'NONE'
            ? matchedGateBlock.planStatus
            : this._safePlanStatus(),
        hasPlanFile: fs.existsSync(path.join(this.workspaceDir, 'PLAN.md')),
      },
      session: {
        sessionId: sample.record.sessionId,
        currentGfi: 0,
        recentThinking: false,
      },
      evolution: {
        epTier: 0,
      },
      derived: {
        estimatedLineChanges: this._estimateLineChanges(toolCall),
        bashRisk: this._inferBashRisk(toolCall),
      },
    };
  }

   
    // eslint-disable-next-line complexity -- complexity 11, slightly over threshold
  private _selectToolCall(
    snapshot: NocturnalSessionSnapshot,
    classification: SampleClassification,
  ): NocturnalToolCall | null {
    const byNewest = [...snapshot.toolCalls].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );

    if (classification === 'pain-negative') {
      return (
        byNewest.find((toolCall) => toolCall.outcome === 'blocked') ??
        byNewest.find((toolCall) => toolCall.outcome === 'failure') ??
        byNewest[0] ??
        null
      );
    }

    if (classification === 'success-positive' || classification === 'principle-anchor') {
      return (
        byNewest.find((toolCall) => toolCall.outcome === 'success') ??
        byNewest.find((toolCall) => toolCall.outcome === 'failure') ??
        byNewest[0] ??
        null
      );
    }

    return byNewest[0] ?? null;
  }

   
  private _matchGateBlock(
    gateBlocks: NocturnalGateBlock[],
    toolCall: NocturnalToolCall,
  ): NocturnalGateBlock | null {
    return (
      [...gateBlocks]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .find((gateBlock) => gateBlock.toolName === toolCall.toolName) ?? null
    );
  }

  private _isRiskPath(normalizedPath: string): boolean {
    try {
      const profilePath = path.join(this.workspaceDir, 'PROFILE.json');
      const riskPaths =
        fs.existsSync(profilePath)
          ? (((JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as { risk_paths?: unknown }).risk_paths as string[] | undefined) ?? [])
          : [];
      return isRisky(normalizedPath, riskPaths);
    } catch {
      return false;
    }
  }

  private _safePlanStatus(): 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN' {
    try {
      const status = getPlanStatus(this.workspaceDir);
      if (status === 'READY') return 'READY';
      if (status === 'DRAFT') return 'DRAFT';
      if (status === '') return 'NONE';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

   
  private _estimateLineChanges(toolCall: NocturnalToolCall): number {
    if (toolCall.toolName === 'edit' || toolCall.toolName === 'write') {
      return 20;
    }
    return 0;
  }

   
  private _inferBashRisk(toolCall: NocturnalToolCall): 'safe' | 'normal' | 'dangerous' | 'unknown' {
    if (toolCall.toolName !== 'bash' && toolCall.toolName !== 'run_shell_command') {
      return 'unknown';
    }
    const errorText = `${toolCall.errorType ?? ''} ${toolCall.errorMessage ?? ''}`;
    if (/\brm\s+-rf\b|\bchmod\b|\bchown\b|>\s*\/dev\//.test(errorText)) {
      return 'dangerous';
    }
    return toolCall.outcome === 'success' ? 'safe' : 'normal';
  }

    // eslint-disable-next-line complexity -- complexity 11, slightly over threshold
   
    // eslint-disable-next-line complexity -- complexity 11
  private _scoreEvaluation(
    sample: ReplaySample,
    result: RuleHostResult,
  ): { passed: boolean; reason?: string; decision: string } {
    switch (sample.classification) {
      case 'pain-negative':
        return {
          passed: result.decision === 'block' || result.decision === 'requireApproval',
          reason:
            result.decision === 'block' || result.decision === 'requireApproval'
              ? undefined
              : `Expected block/requireApproval but received ${result.decision}.`,
          decision: result.decision,
        };
      case 'success-positive':
        return {
          passed: result.decision === 'allow' || !result.matched,
          reason:
            result.decision === 'allow' || !result.matched
              ? undefined
              : `Expected allow/no-match but received ${result.decision}.`,
          decision: result.decision,
        };
      case 'principle-anchor':
        return {
          passed: result.decision !== 'block',
          reason:
            result.decision !== 'block'
              ? undefined
              : 'Principle-anchor sample should not regress to a hard block.',
          decision: result.decision,
        };
      default:
        return {
          passed: false,
          reason: 'Unknown replay classification.',
          decision: result.decision,
        };
    }
  }

  private _buildReport(
    implementationId: string,
    results: ReplayResult[]
  ): ReplayReport {
    const painNegative = results.filter((result) => result.classification === 'pain-negative');
    const successPositive = results.filter((result) => result.classification === 'success-positive');
    const principleAnchor = results.filter((result) => result.classification === 'principle-anchor');

    const toSummary = (details: ReplayResult[]): ClassificationSummary => ({
      total: details.length,
      passed: details.filter((result) => result.passed).length,
      failed: details.filter((result) => !result.passed).length,
      details,
    });

    const painSummary = toSummary(painNegative);
    const successSummary = toSummary(successPositive);
    const anchorSummary = toSummary(principleAnchor);
    const blockers: string[] = [];
    const totalSamples = results.length;

    if (totalSamples === 0) {
      blockers.push('NO REPLAY EVIDENCE: No classified replay samples were available. Report cannot justify promotion-quality conclusions.');
    }

    for (const leak of painSummary.details.filter((result) => !result.passed)) {
      blockers.push(
        `PAIN-NEGATIVE LEAK: Sample ${leak.sampleFingerprint} was not blocked. ${leak.reason ?? ''}`
      );
    }

    for (const violation of anchorSummary.details.filter((result) => !result.passed)) {
      blockers.push(
        `PRINCIPLE-ANCHOR VIOLATION: Sample ${violation.sampleFingerprint} did not adhere. ${violation.reason ?? ''}`
      );
    }

    for (const falsePositive of successSummary.details.filter((result) => !result.passed)) {
      blockers.push(
        `FALSE POSITIVE: Sample ${falsePositive.sampleFingerprint} was incorrectly blocked. ${falsePositive.reason ?? ''}`
      );
    }

    return {
      overallDecision: this._determineDecision(painSummary, successSummary, anchorSummary),
      replayResults: {
        painNegative: painSummary,
        successPositive: successSummary,
        principleAnchor: anchorSummary,
      },
      blockers,
      evidenceSummary: {
        evidenceStatus: totalSamples > 0 ? 'observed' : 'empty',
        totalSamples,
        classifiedCounts: {
          painNegative: painSummary.total,
          successPositive: successSummary.total,
          principleAnchor: anchorSummary.total,
        },
      },
      generatedAt: new Date().toISOString(),
      implementationId,
      sampleFingerprints: results.map((result) => result.sampleFingerprint),
    };
  }

   
  private _determineDecision(
    pain: ClassificationSummary,
    success: ClassificationSummary,
    anchor: ClassificationSummary
  ): 'pass' | 'fail' | 'needs-review' {
    if (pain.total + success.total + anchor.total === 0) return 'needs-review';
    if (pain.failed > 0) return 'fail';
    if (anchor.failed > 0) return 'fail';
    if (success.failed > 0) return 'needs-review';
    return 'pass';
  }

  private _persistReport(report: ReplayReport): void {
    const reportDir = path.join(
      getImplementationAssetRoot(this.stateDir, report.implementationId),
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

   
  private _deriveExpectedOutcome(
    record: NocturnalDatasetRecord,
  ): ReplaySample['expectedOutcome'] {
    switch (record.classification) {
      case 'pain-negative':
        return { shouldBlock: true };
      case 'success-positive':
        return { shouldPass: true };
      case 'principle-anchor':
        return { expectedPrinciple: record.principleId };
      default:
        return {};
    }
  }
}

export function formatReplayReport(report: ReplayReport): string {
  const decisionEmoji =
    report.overallDecision === 'pass'
      ? 'PASS'
      : report.overallDecision === 'fail'
        ? 'FAIL'
        : 'NEEDS-REVIEW';

  let output = '';
  output += '\nReplay Evaluation Report\n';
  output += `${'='.repeat(50)}\n`;
  output += `Implementation: ${report.implementationId}\n`;
  output += `Generated At:   ${report.generatedAt}\n`;
  output += `Overall Decision: [${decisionEmoji}]\n\n`;
  output += `Evidence Status: ${report.evidenceSummary.evidenceStatus} (samples=${report.evidenceSummary.totalSamples})\n\n`;

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
      section += '    Failures:\n';
      for (const detail of summary.details.filter((item) => !item.passed)) {
        section += `      - ${detail.sampleFingerprint}: ${detail.reason ?? detail.decision}\n`;
      }
    }
    return section;
  };

  output += formatSection('Pain-Negative Samples', report.replayResults.painNegative);
  output += formatSection('Success-Positive Samples', report.replayResults.successPositive);
  output += formatSection('Principle-Anchor Samples', report.replayResults.principleAnchor);

  if (report.blockers.length > 0) {
    output += '\nBlockers:\n';
    for (const blocker of report.blockers) {
      output += `  - ${blocker}\n`;
    }
  }

  output += `${'='.repeat(50)}\n`;
  return output;
}
