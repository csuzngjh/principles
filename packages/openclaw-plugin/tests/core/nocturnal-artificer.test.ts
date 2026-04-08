import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseArtificerOutput,
  resolveArtificerTargetRule,
  shouldRunArtificer,
} from '../../src/core/nocturnal-artificer.js';
import { saveLedger, type LedgerPrinciple, type LedgerRule } from '../../src/core/principle-tree-ledger.js';
import type { NocturnalSessionSnapshot } from '../../src/core/nocturnal-trajectory-extractor.js';
import { safeRmDir } from '../test-utils.js';

function createPrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: 'P-001',
    version: 1,
    text: 'Use the right safety hook',
    triggerPattern: 'gate',
    action: 'align code fixes to the correct rule',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'deterministic',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function createRule(overrides: Partial<LedgerRule> = {}): LedgerRule {
  return {
    id: 'R-001',
    version: 1,
    name: 'Protect destructive writes',
    description: 'Gate write operations on risky paths.',
    type: 'gate',
    triggerCondition: 'write risk path',
    enforcement: 'block',
    action: 'require approval for risky write',
    principleId: 'P-001',
    status: 'implemented',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: [],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function createSnapshot(): NocturnalSessionSnapshot {
  return {
    sessionId: 'session-1',
    startedAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:10:00.000Z',
    assistantTurns: [],
    userTurns: [],
    toolCalls: [
      {
        toolName: 'write',
        outcome: 'failure',
        filePath: 'src/risk.ts',
        durationMs: 10,
        exitCode: 1,
        errorType: 'blocked',
        errorMessage: 'risky write',
        createdAt: '2026-04-08T00:01:00.000Z',
      },
    ],
    painEvents: [
      {
        source: 'gate',
        score: 0.9,
        severity: 'high',
        reason: 'write operation touched a risky path without approval',
        createdAt: '2026-04-08T00:02:00.000Z',
      },
    ],
    gateBlocks: [
      {
        toolName: 'write',
        filePath: 'src/risk.ts',
        reason: 'risky write requires approval',
        planStatus: 'DRAFT',
        createdAt: '2026-04-08T00:03:00.000Z',
      },
    ],
    stats: {
      totalAssistantTurns: 0,
      totalToolCalls: 1,
      totalPainEvents: 1,
      totalGateBlocks: 1,
      failureCount: 1,
    },
  };
}

describe('nocturnal-artificer', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-artificer-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  it('selects the only rule for a principle without scoring ambiguity', () => {
    saveLedger(stateDir, {
      trainingStore: {},
      tree: {
        principles: {
          'P-001': createPrinciple({ ruleIds: ['R-001'] }),
        },
        rules: {
          'R-001': createRule(),
        },
        implementations: {},
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });

    const resolution = resolveArtificerTargetRule(stateDir, 'P-001', createSnapshot());

    expect(resolution).toMatchObject({
      status: 'selected',
      ruleId: 'R-001',
      reason: 'single-rule',
    });
  });

  it('selects the highest-signal rule when one rule has deterministic evidence', () => {
    saveLedger(stateDir, {
      trainingStore: {},
      tree: {
        principles: {
          'P-001': createPrinciple({ ruleIds: ['R-001', 'R-002'] }),
        },
        rules: {
          'R-001': createRule(),
          'R-002': createRule({
            id: 'R-002',
            name: 'Protect archive deletes',
            description: 'Require approval for delete operations.',
            triggerCondition: 'delete archive',
            action: 'block unreviewed delete',
          }),
        },
        implementations: {},
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });

    const resolution = resolveArtificerTargetRule(stateDir, 'P-001', createSnapshot());

    expect(resolution).toMatchObject({
      status: 'selected',
      ruleId: 'R-001',
      reason: 'evidence-winner',
    });
    expect(resolution.scores[0]?.score).toBeGreaterThan(resolution.scores[1]?.score ?? 0);
  });

  it('skips Artificer routing when multiple rules tie on the same evidence', () => {
    saveLedger(stateDir, {
      trainingStore: {},
      tree: {
        principles: {
          'P-001': createPrinciple({ ruleIds: ['R-001', 'R-002'] }),
        },
        rules: {
          'R-001': createRule({
            name: 'Protect risky write',
            description: 'risky write requires approval',
            triggerCondition: 'write risky',
            action: 'require approval for risky write',
          }),
          'R-002': createRule({
            id: 'R-002',
            name: 'Protect risky write',
            description: 'risky write requires approval',
            triggerCondition: 'write risky',
            action: 'require approval for risky write',
          }),
        },
        implementations: {},
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });

    const resolution = resolveArtificerTargetRule(stateDir, 'P-001', createSnapshot());

    expect(resolution).toMatchObject({
      status: 'skip',
      reason: 'ambiguous-target-rule',
    });
    expect(shouldRunArtificer(createSnapshot(), resolution)).toBe(false);
  });

  it('parses a structured code-candidate output contract with lineage metadata', () => {
    const parsed = parseArtificerOutput(
      JSON.stringify({
        ruleId: 'R-001',
        candidateSource: 'export const meta = {}; export function evaluate() {}',
        helperUsage: ['getToolName', 'hasPlanFile'],
        expectedDecision: 'requireApproval',
        rationale: 'Target the risky write path guard.',
        lineage: {
          artifactKind: 'rule-implementation-candidate',
          sourceSnapshotRef: 'snapshot-session-1',
          sourcePainIds: [],
          sourceGateBlockIds: [],
        },
      })
    );

    expect(parsed).toMatchObject({
      ruleId: 'R-001',
      implementationType: 'code',
      helperUsage: ['getToolName', 'hasPlanFile'],
      expectedDecision: 'requireApproval',
      lineage: {
        artifactKind: 'rule-implementation-candidate',
      },
    });
  });
});
