import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { needsMigration } from '../../src/core/principle-tree-migration.js';
import { safeRmDir } from '../test-utils.js';

function writeLedger(stateDir: string, payload: unknown): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  );
}

describe('principle-tree-migration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) safeRmDir(dir);
    }
  });

  it('requires migration when trainingStore and tree.principles counts match but ids differ', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-migration-'));
    const stateDir = path.join(workspaceDir, '.state');
    tempDirs.push(workspaceDir);

    writeLedger(stateDir, {
      P_001: {
        principleId: 'P_001',
        evaluability: 'manual_only',
        applicableOpportunityCount: 0,
        observedViolationCount: 0,
        complianceRate: 0,
        violationTrend: 0,
        generatedSampleCount: 0,
        approvedSampleCount: 0,
        includedTrainRunIds: [],
        deployedCheckpointIds: [],
        internalizationStatus: 'prompt_only',
      },
      _tree: {
        principles: {
          P_999: {
            id: 'P_999',
            version: 1,
            text: 'Other principle',
            triggerPattern: '',
            action: '',
            status: 'candidate',
            priority: 'P1',
            scope: 'general',
            evaluability: 'manual_only',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
            derivedFromPainIds: [],
            ruleIds: [],
            conflictsWithPrincipleIds: [],
            createdAt: '2026-04-10T00:00:00.000Z',
            updatedAt: '2026-04-10T00:00:00.000Z',
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-04-10T00:00:00.000Z',
      },
    });

    expect(needsMigration(stateDir)).toBe(true);
  });
});
