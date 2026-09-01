/**
 * PRI-641 — Core Principles Console Boundary: model-level invariants.
 *
 * Product invariant under test: "Immutable Core + Evolvable Workspace Layer".
 * The workspace projection (list/summary/categories) must contain only
 * workspace-governed principles, builtin axioms (T-01..T-10) must be refused
 * by governance mutations before any write, and Core IDs must never enter the
 * ordinary Owner Principle detail flow.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  PrinciplesConsoleModel,
  ImmutableCorePrincipleError,
  CorePrincipleNotGovernedError,
} from '../../src/server/models/PrinciplesConsoleModel.js';
import {
  createTestWorkspace,
  cleanupTestWorkspace,
  type TestWorkspace,
} from '../test-utils.js';

function writeLedger(workspaceDir: string, tree: Record<string, unknown>): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify({ _tree: tree }, null, 2),
    'utf8',
  );
}

function readLedgerRaw(workspaceDir: string): string {
  return fs.readFileSync(
    path.join(workspaceDir, '.state', 'principle_training_state.json'),
    'utf8',
  );
}

function coreLedgerFixture(): Record<string, unknown> {
  return {
    principles: {
      // Core axiom that mimics the classic Debt leak: active + no activation
      'T-01': {
        id: 'T-01',
        text: 'Builtin axiom (experimental workspace copy)',
        triggerPattern: 'always',
        action: 'plan',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      P_ACTIVE: {
        id: 'P_ACTIVE',
        text: 'Workspace principle (active)',
        triggerPattern: 'error',
        action: 'fix',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      P_CANDIDATE: {
        id: 'P_CANDIDATE',
        text: 'Workspace principle (candidate)',
        triggerPattern: 'warning',
        action: 'review',
        status: 'candidate',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-05-01T00:00:00Z',
  };
}

describe('PRI-641: PrinciplesConsoleModel core/workspace boundary', () => {
  let ws: TestWorkspace | null = null;

  afterEach(() => {
    if (ws) {
      cleanupTestWorkspace(ws);
      ws = null;
    }
  });

  // ── Workspace projection (read boundary) ──────────────────────────────────

  it('filter=all returns only workspace-governed principles (builtin excluded)', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples('all');

    expect(result.principles.map((p) => p.id).sort()).toEqual(['P_ACTIVE', 'P_CANDIDATE']);
  });

  it('summary counts only the workspace corpus', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples('all');

    // T-01 (active) must not inflate active/total counts
    expect(result.summary.total).toBe(2);
    expect(result.summary.active).toBe(1);
    expect(result.summary.candidate).toBe(1);
    expect(result.summary.probation).toBe(0);
    expect(result.summary.archived).toBe(0);
    expect(result.summary.deprecated).toBe(0);
  });

  it('categories reflect only workspace principles (no builtin category)', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples('all');

    expect(result.categories).toBeDefined();
    expect(result.categories).not.toHaveProperty('builtin');
    expect(Object.values(result.categories ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('actionable filter still works on the workspace corpus', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples('actionable');

    // PRI-629: without pending approvals nothing is owner-actionable —
    // and the Core axiom can never become actionable either way.
    expect(result.principles).toHaveLength(0);

    const withPending = await model.listPrinciples('actionable', undefined, new Set(['T-01', 'P_ACTIVE']));
    // Even with a (hypothetical) pending approval row naming T-01, the core
    // axiom is classified builtin before actionability, so it stays out.
    expect(withPending.principles.map((p) => p.id)).toEqual(['P_ACTIVE']);
  });

  // ── Debt regression (data layer) ──────────────────────────────────────────

  it('Debt source data: an active core axiom with no activation never reaches filter=all', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const result = await model.listPrinciples('all');

    // DebtPage computes never_activated debt from fetchPrinciples('all')
    // items with status 'active' and no active activation. The server-side
    // projection must therefore simply never hand it T-01.
    const debtCandidates = result.principles.filter((p) => p.status === 'active');
    expect(debtCandidates.map((p) => p.id)).toEqual(['P_ACTIVE']);
  });

  // ── Write boundary: archive / unarchive ───────────────────────────────────

  it('archivePrinciple refuses a core principle with ImmutableCorePrincipleError before any write', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());
    const before = readLedgerRaw(ws.workspaceDir);

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    await expect(model.archivePrinciple('T-01')).rejects.toBeInstanceOf(ImmutableCorePrincipleError);

    expect(readLedgerRaw(ws.workspaceDir)).toBe(before);
  });

  it('unarchivePrinciple refuses a core principle with ImmutableCorePrincipleError before any write', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());
    const before = readLedgerRaw(ws.workspaceDir);

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    await expect(model.unarchivePrinciple('T-01')).rejects.toBeInstanceOf(ImmutableCorePrincipleError);

    expect(readLedgerRaw(ws.workspaceDir)).toBe(before);
  });

  it('archive/unarchive still work for ordinary workspace principles', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    await expect(model.archivePrinciple('P_ACTIVE')).resolves.toBe(true);

    const afterArchive = await model.listPrinciples('all');
    expect(afterArchive.principles.find((p) => p.id === 'P_ACTIVE')?.status).toBe('archived');
    expect(afterArchive.summary.archived).toBe(1);

    await expect(model.unarchivePrinciple('P_ACTIVE')).resolves.toBe(true);
    const afterUnarchive = await model.listPrinciples('all');
    expect(afterUnarchive.principles.find((p) => p.id === 'P_ACTIVE')?.status).toBe('active');
  });

  // ── Detail boundary ───────────────────────────────────────────────────────

  it('getPrincipleDetail refuses core IDs with CorePrincipleNotGovernedError', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    await expect(model.getPrincipleDetail('T-03')).rejects.toBeInstanceOf(CorePrincipleNotGovernedError);
    // Refusal holds even when an experimental ledger row exists for the id
    await expect(model.getPrincipleDetail('T-01')).rejects.toBeInstanceOf(CorePrincipleNotGovernedError);
  });

  it('getPrincipleDetail still works for workspace principles', async () => {
    ws = await createTestWorkspace();
    writeLedger(ws.workspaceDir, coreLedgerFixture());

    const model = new PrinciplesConsoleModel(ws.workspaceDir);
    const detail = await model.getPrincipleDetail('P_ACTIVE');
    expect(detail?.principle.id).toBe('P_ACTIVE');
  });
});
