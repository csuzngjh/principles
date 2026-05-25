
import * as fs from 'fs';
import * as path from 'path';
import { getImplementationAssetRoot } from './code-implementation-storage.js';
import { loadLedger } from './principle-tree-ledger.js';
import type { Implementation } from '../types/principle-tree-schema.js';
import type { ReplayReport, ClassificationSummary, ReplayResult } from '@principles/core/runtime-v2';

export type { ReplayReport, ClassificationSummary, ReplayResult };

export class ReplayEngine {
  private readonly workspaceDir: string;
  private readonly stateDir: string;

  constructor(workspaceDir: string, stateDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = stateDir;
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
    } catch (err) {
    console.warn(`[ReplayEngine] Failed to read reports in ${reportDir}: ${err instanceof Error ? err.message : String(err)}`);
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
