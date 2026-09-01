import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { PrinciplesConsoleModel } from '../../src/server/models/PrinciplesConsoleModel.js';
import {
  createTestWorkspace,
  cleanupTestWorkspace,
  type TestWorkspace,
} from '../test-utils.js';

describe('PrinciplesConsoleModel', () => {
  let ws: TestWorkspace | null = null;

  afterEach(() => {
    if (ws) {
      cleanupTestWorkspace(ws);
      ws = null;
    }
  });

  it('listPrinciples returns empty list for workspace with no principles', async () => {
    ws = await createTestWorkspace();
    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it('listPrinciples returns principles with correct summary counts', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        p1: {
          id: 'p1',
          status: 'active',
          text: 'Rule 1',
          triggerPattern: 't1',
          action: 'a1',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        p2: {
          id: 'p2',
          status: 'active',
          text: 'Rule 2',
          triggerPattern: 't2',
          action: 'a2',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        p3: {
          id: 'p3',
          status: 'candidate',
          text: 'Rule 3',
          triggerPattern: 't3',
          action: 'a3',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        p4: {
          id: 'p4',
          status: 'archived',
          text: 'Rule 4',
          triggerPattern: 't4',
          action: 'a4',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        p5: {
          id: 'p5',
          status: 'deprecated',
          text: 'Rule 5',
          triggerPattern: 't5',
          action: 'a5',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        p6: {
          id: 'p6',
          status: 'probation',
          text: 'Rule 6',
          triggerPattern: 't6',
          action: 'a6',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });
    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.summary.total).toBe(6);
    expect(result.summary.active).toBe(2);
    expect(result.summary.candidate).toBe(1);
    expect(result.summary.archived).toBe(1);
    expect(result.summary.deprecated).toBe(1);
    expect(result.summary.probation).toBe(1);
  });

  it('listPrinciples defaults unknown status to candidate', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-unknown': {
          id: 'p-unknown',
          status: 'weird-status',
          text: 'Unknown status principle',
          triggerPattern: 'always',
          action: 'do something',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].status).toBe('candidate');
    expect(result.summary.candidate).toBe(1);
  });

  it('listPrinciples defaults missing fields safely', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-minimal': {
          id: 'p-minimal',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    const p = result.principles[0];
    expect(p.text).toBe('');
    expect(p.triggerPattern).toBe('');
    expect(p.action).toBe('');
    expect(p.priority).toBe('P2');
    expect(p.scope).toBe('general');
    expect(p.domain).toBeNull();
    expect(p.evaluability).toBe('manual_only');
    expect(p.valueScore).toBe(0);
    expect(p.adherenceRate).toBe(0);
    expect(p.painPreventedCount).toBe(0);
  });

  it('listPrinciples sorts by valueScore descending', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-low': {
          id: 'p-low',
          valueScore: 10,
          text: 'Low',
          triggerPattern: 'x',
          action: 'y',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'p-high': {
          id: 'p-high',
          valueScore: 100,
          text: 'High',
          triggerPattern: 'x',
          action: 'y',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'p-mid': {
          id: 'p-mid',
          valueScore: 50,
          text: 'Mid',
          triggerPattern: 'x',
          action: 'y',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles[0].id).toBe('p-high');
    expect(result.principles[1].id).toBe('p-mid');
    expect(result.principles[2].id).toBe('p-low');
  });

  it('getPrincipleDetail returns principle with linked rules', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-with-rules': {
          id: 'p-with-rules',
          text: 'Principle with rules',
          triggerPattern: 'on-error',
          action: 'fix',
          status: 'active',
          priority: 'P0',
          evaluability: 'deterministic',
          ruleIds: ['r1', 'r2'],
          valueScore: 50,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {
        r1: {
          id: 'r1',
          name: 'Rule 1',
          description: 'First rule',
          type: 'gate',
          triggerCondition: 'always',
          enforcement: 'block',
          action: 'reject',
          status: 'enforced',
        },
        r2: {
          id: 'r2',
          name: 'Rule 2',
          description: 'Second rule',
          type: 'hook',
          triggerCondition: 'on-warn',
          enforcement: 'warn',
          action: 'notify',
          status: 'implemented',
        },
      },
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const detail = await model.getPrincipleDetail('p-with-rules');

    expect(detail).not.toBeNull();
    expect(detail!.principle.id).toBe('p-with-rules');
    expect(detail!.principle.priority).toBe('P0');
    expect(detail!.principle.rules).toHaveLength(2);
    expect(detail!.principle.rules.map(r => r.id)).toContain('r1');
    expect(detail!.principle.rules.map(r => r.id)).toContain('r2');
  });

  it('getPrincipleDetail returns null for non-existent principle', async () => {
    ws = await createTestWorkspace();
    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const detail = await model.getPrincipleDetail('nonexistent');

    expect(detail).toBeNull();
  });

  it('getPrincipleDetail handles principle with no rules', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-no-rules': {
          id: 'p-no-rules',
          text: 'No rules',
          triggerPattern: 'x',
          action: 'y',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const detail = await model.getPrincipleDetail('p-no-rules');

    expect(detail).not.toBeNull();
    expect(detail!.principle.rules).toHaveLength(0);
  });

  it('handles missing ledger file gracefully', async () => {
    ws = await createTestWorkspace();
    const stateDir = path.join(ws.workspaceDir, '.state');
    const ledgerPath = path.join(stateDir, 'principle_training_state.json');
    if (fs.existsSync(ledgerPath)) {
      fs.unlinkSync(ledgerPath);
    }

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles).toHaveLength(0);
  });

  it('handles corrupted ledger JSON gracefully', async () => {
    ws = await createTestWorkspace();
    writeRawLedger(ws.workspaceDir, 'this is not valid json {{{');

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles).toHaveLength(0);
  });

  it('handles empty ledger file gracefully', async () => {
    ws = await createTestWorkspace();
    writeRawLedger(ws.workspaceDir, '');

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles).toHaveLength(0);
  });

  it('handles ledger with non-object principle entries', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-valid': {
          id: 'p-valid',
          text: 'Valid principle',
          triggerPattern: 'x',
          action: 'y',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'p-array': ['this', 'is', 'an', 'array'],
        'p-string': 'just a string',
        'p-number': 42,
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].id).toBe('p-valid');
  });

  it('defaults invalid enum values to fallback', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-bad-enums': {
          id: 'p-bad-enums',
          text: 'Bad enums',
          triggerPattern: 'x',
          action: 'y',
          status: 'invalid-status',
          priority: 'P9',
          scope: 'universe',
          evaluability: 'telepathy',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    const p = result.principles[0];
    expect(p.status).toBe('candidate');
    expect(p.priority).toBe('P2');
    expect(p.scope).toBe('general');
    expect(p.evaluability).toBe('manual_only');
  });

  it('caches ledger reads', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-cache': {
          id: 'p-cache',
          text: 'Cache test',
          triggerPattern: 'x',
          action: 'y',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result1 = await model.listPrinciples();
    const result2 = await model.listPrinciples();

    expect(result1.principles).toHaveLength(1);
    expect(result2.principles).toHaveLength(1);
  });

  it('detail includes relationship fields', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-rels': {
          id: 'p-rels',
          text: 'Relations',
          triggerPattern: 'x',
          action: 'y',
          coreAxiomId: 'axiom-1',
          lastPainPreventedAt: '2026-04-01T00:00:00Z',
          derivedFromPainIds: ['pain-1', 'pain-2'],
          conflictsWithPrincipleIds: ['p-other'],
          supersedesPrincipleId: 'p-old',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const detail = await model.getPrincipleDetail('p-rels');

    expect(detail).not.toBeNull();
    expect(detail!.principle.coreAxiomId).toBe('axiom-1');
    expect(detail!.principle.lastPainPreventedAt).toBe('2026-04-01T00:00:00Z');
    expect(detail!.principle.derivedFromPainIds).toEqual(['pain-1', 'pain-2']);
    expect(detail!.principle.conflictsWithPrincipleIds).toEqual(['p-other']);
    expect(detail!.principle.supersedesPrincipleId).toBe('p-old');
  });

  // ── PRI-330: filter and categories tests ────────────────────────────────

  it('listPrinciples returns categories breakdown', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'T-01': {
          id: 'T-01',
          text: 'Map before territory',
          triggerPattern: 'always',
          action: 'plan first',
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_DEMO': {
          id: 'P_DEMO',
          text: 'This is a demo principle',
          triggerPattern: 'demo',
          action: 'nothing',
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_001': {
          id: 'P_001',
          text: 'Real principle',
          triggerPattern: 'error',
          action: 'fix',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_OLD': {
          id: 'P_OLD',
          text: 'Old principle',
          triggerPattern: 'old',
          action: 'archive',
          status: 'archived',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();

    expect(result.categories).toBeDefined();
    // PRI-641: builtin axioms are excluded from the workspace projection —
    // they are served by the Core reference surface, not counted here.
    expect(result.categories).not.toHaveProperty('builtin');
    expect(result.categories!['demo']).toBe(1);
    // PRI-629 INV-02: candidate 生命周期 → in_pipeline (不再是 owner_actionable)
    expect(result.categories!['in_pipeline']).toBe(1);
    expect(result.categories!['historical']).toBe(1);
  });

  it('listPrinciples with filter=actionable returns only actionable principles', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'T-01': {
          id: 'T-01',
          text: 'Map before territory',
          triggerPattern: 'always',
          action: 'plan first',
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_DEMO': {
          id: 'P_DEMO',
          text: 'Demo principle for testing',
          triggerPattern: 'demo',
          action: 'nothing',
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_001': {
          id: 'P_001',
          text: 'Real actionable principle',
          triggerPattern: 'error',
          action: 'fix',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_002': {
          id: 'P_002',
          text: 'Another actionable principle',
          triggerPattern: 'warning',
          action: 'review',
          status: 'probation',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const allResult = await model.listPrinciples('all');
    // PRI-629 INV-02: lifecycle 不是 attention — candidate/probation 全部落入
    // in_pipeline;只有携带 pending approval 的原则 actionable。
    const actionableResult = await model.listPrinciples('actionable');
    const actionableWithPending = await model.listPrinciples('actionable', undefined, new Set(['P_001']));

    // PRI-641: filter=all = all workspace-governed principles (T-01 excluded)
    expect(allResult.principles).toHaveLength(3);
    expect(actionableResult.principles).toHaveLength(0);
    expect(actionableWithPending.principles).toHaveLength(1);
    expect(actionableWithPending.principles[0].id).toBe('P_001');
  });

  it('listPrinciples with filter=all returns all workspace principles (builtin excluded)', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'T-01': {
          id: 'T-01',
          text: 'Builtin axiom',
          triggerPattern: 'always',
          action: 'plan',
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        'P_001': {
          id: 'P_001',
          text: 'Actionable principle',
          triggerPattern: 'error',
          action: 'fix',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples('all');

    // PRI-641: filter=all means "all workspace-governed principles" — the
    // builtin axiom T-01 is served by the Core reference surface instead.
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0]?.id).toBe('P_001');
    expect(result.summary.total).toBe(1);
    expect(result.summary.candidate).toBe(1);
    expect(result.summary.active).toBe(0);
  });

  // ── PRI-332: Language detection & readability tests ──────────────────────

  it('PRI-332: detects Chinese text language as zh', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-zh': {
          id: 'p-zh',
          text: '修改配置前展示影响范围',
          triggerPattern: '配置变更',
          action: '展示影响',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].detectedLanguage).toBe('zh');
    expect(result.principles[0].readabilityWarningCode).toBeUndefined();
  });

  it('PRI-332: detects English text language as en', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-en': {
          id: 'p-en',
          text: 'Always show impact scope before modifying configuration',
          triggerPattern: 'config change',
          action: 'show impact',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].detectedLanguage).toBe('en');
  });

  it('PRI-332: detects empty text as unknown', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-empty': {
          id: 'p-empty',
          text: '',
          triggerPattern: '',
          action: '',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].detectedLanguage).toBe('unknown');
  });

  it('PRI-332: sets readabilityWarningCode for regex-like triggerPattern', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-regex': {
          id: 'p-regex',
          text: 'Some principle text',
          triggerPattern: '/^error\\s+\\d+/gi',
          action: 'log',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].readabilityWarningCode).toBe('technical_pattern');
  });

  it('PRI-332: sets readabilityWarningCode for Error:-prefixed triggerPattern', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-err': {
          id: 'p-err',
          text: 'Handle errors gracefully',
          triggerPattern: 'Error: ECONNREFUSED',
          action: 'retry',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].readabilityWarningCode).toBe('diagnostic_residue');
  });

  it('PRI-332: no readabilityWarningCode for normal human-readable title', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        'p-normal': {
          id: 'p-normal',
          text: 'Always confirm before deleting files',
          triggerPattern: 'User deletes file',
          action: 'ask confirmation',
          status: 'candidate',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    });

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples();
    expect(result.principles).toHaveLength(1);
    expect(result.principles[0].readabilityWarningCode).toBeUndefined();
  });

  it('archivePrinciple archives an active principle and unarchivePrinciple restores it', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, {
      principles: {
        p1: {
          id: 'p1',
          status: 'active',
          text: 'Rule 1',
          triggerPattern: 't1',
          action: 'a1',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: '2026-05-01T00:00:00Z',
    });
    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    
    // Archive
    const archiveResult = await model.archivePrinciple('p1');
    expect(archiveResult).toBe(true);
    
    const detailAfterArchive = await model.getPrincipleDetail('p1');
    expect(detailAfterArchive?.principle.status).toBe('archived');
    
    // Unarchive
    const unarchiveResult = await model.unarchivePrinciple('p1');
    expect(unarchiveResult).toBe(true);
    
    const detailAfterUnarchive = await model.getPrincipleDetail('p1');
    expect(detailAfterUnarchive?.principle.status).toBe('active');
  });
});

function writeLedger(workspaceDir: string, tree: Record<string, unknown>): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify({ _tree: tree }, null, 2),
    'utf8',
  );
}

function writeRawLedger(workspaceDir: string, content: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    content,
    'utf8',
  );
}
