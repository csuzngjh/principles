import type { LifecycleDatasource } from '@principles/core/runtime-v2';
import type { LedgerTreeStore, ReplayReport, ArtifactLineageRecord } from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class LineageSourceRetiredError extends Error {
  constructor() {
    super(
      'Artifact lineage source retired in PRI-230. ' +
      'The nocturnal-artifact-lineage module has been deleted; ' +
      'this datasource cannot provide lineage records. ' +
      'Callers must handle this error explicitly rather than interpreting an empty result as "no lineage".'
    );
    this.name = 'LineageSourceRetiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateReplayReport(raw: unknown): ReplayReport | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.implementationId !== 'string') return null;
  if (typeof raw.overallDecision !== 'string') return null;
  if (typeof raw.generatedAt !== 'string') return null;
  return raw as unknown as ReplayReport;
}

export class ConsoleLifecycleDatasource implements LifecycleDatasource {
  constructor(
    private readonly workspaceDir: string,
    private readonly stateDir: string,
  ) {}

  loadLedger(): LedgerTreeStore {
    const hybrid = loadLedger(this.stateDir);
    return hybrid.tree as unknown as LedgerTreeStore;
  }

  listReplayReports(implementationId: string): ReplayReport[] {
    const reportDir = path.join(
      this.stateDir, 'principles', 'implementations', implementationId, 'replays',
    );

    if (!fs.existsSync(reportDir)) return [];

    try {
      const files = fs.readdirSync(reportDir).filter((file) => file.endsWith('.json'));
      return files
        .sort()
        .reverse()
        .map((file) => {
          const content = fs.readFileSync(path.join(reportDir, file), 'utf-8');
          const parsed: unknown = JSON.parse(content);
          return validateReplayReport(parsed);
        })
        .filter((report): report is ReplayReport => report !== null);
    } catch {
      return [];
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  listLineageRecords(_kind: 'behavioral-sample' | 'rule-implementation-candidate'): ArtifactLineageRecord[] {
    throw new LineageSourceRetiredError();
  }
}
