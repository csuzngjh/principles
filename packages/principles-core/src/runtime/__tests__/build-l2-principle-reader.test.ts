import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock loadLedger with a controllable implementation (default: real behavior)
vi.mock('../../principle-tree-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadLedger: vi.fn(actual.loadLedger as (...args: unknown[]) => unknown),
  };
});

import { loadLedger } from '../../principle-tree-ledger.js';
import { buildL2PrincipleReader, buildL2PrincipleReaderFromLedger } from '../build-l2-principle-reader.js';

// ── Helpers (declared before describe to satisfy no-use-before-define) ───────

function writeLedger(stateDir: string, tree: { principles: Record<string, unknown> }): void {
  const ledger = {
    _tree: {
      principles: tree.principles,
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: new Date().toISOString(),
    },
    trainingStore: {},
  };
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify(ledger, null, 2));
}

function makePrinciple(overrides: { id: string; text: string; status: string }): Record<string, unknown> {
  return {
    id: overrides.id,
    version: 1,
    text: overrides.text,
    triggerPattern: '*',
    action: 'noop',
    status: overrides.status,
    priority: 'medium',
    scope: 'global',
    evaluability: 'manual_only',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * PRI-431: Characterization tests for buildL2PrincipleReader.
 *
 * These tests capture the behavior of the existing `makeDreamerPrincipleReader`
 * (duplicated in runtime-internalization-run-once.ts and auto-consumer-service.ts)
 * so the extracted `buildL2PrincipleReader` in core preserves the same contract.
 *
 * TDD flow: these tests are RED until buildL2PrincipleReader is implemented.
 */
describe('buildL2PrincipleReader (PRI-431)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-l2-reader-'));
    vi.mocked(loadLedger).mockRestore();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns active principles with id + statement', async () => {
    writeLedger(tmpDir, {
      principles: {
        'p-001': makePrinciple({ id: 'p-001', text: 'Always validate input', status: 'active' }),
        'p-002': makePrinciple({ id: 'p-002', text: 'Log errors with context', status: 'active' }),
      },
    });

    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { id: 'p-001', statement: 'Always validate input' },
        { id: 'p-002', statement: 'Log errors with context' },
      ]),
    );
  });

  it('filters out non-active principles', async () => {
    writeLedger(tmpDir, {
      principles: {
        'p-active': makePrinciple({ id: 'p-active', text: 'Active one', status: 'active' }),
        'p-regressed': makePrinciple({ id: 'p-regressed', text: 'Regressed one', status: 'regressed' }),
        'p-deployed': makePrinciple({ id: 'p-deployed', text: 'Deployed one', status: 'deployed_pending_eval' }),
      },
    });

    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 'p-active', statement: 'Active one' });
  });

  it('returns empty array on missing ledger (degraded mode)', async () => {
    // No ledger file written — loadLedger returns empty tree
    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    expect(result).toEqual([]);
  });

  it('returns empty array on empty ledger', async () => {
    writeLedger(tmpDir, { principles: {} });

    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    expect(result).toEqual([]);
  });

  it('returns empty array on malformed ledger JSON', async () => {
    // loadLedger internally catches JSON parse errors and returns empty tree.
    // buildL2PrincipleReader should return [] without throwing.
    fs.writeFileSync(path.join(tmpDir, 'principle_training_state.json'), '{ not valid json');

    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    expect(result).toEqual([]);
  });

  it('logs a warning and returns [] when loadLedger throws', async () => {
    // Simulate a loadLedger exception (e.g., permission error, unexpected runtime error).
    // The existing makeDreamerPrincipleReader catches this and logs a degradation warning.
    vi.mocked(loadLedger).mockImplementation(() => {
      throw new Error('permission denied');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // suppress console.warn during test
    });

    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(warnMsg).toContain('degraded');
    expect(warnMsg).toContain('permission denied');

    warnSpy.mockRestore();
  });

  it('uses custom logger when provided', async () => {
    vi.mocked(loadLedger).mockImplementation(() => {
      throw new Error('custom error');
    });

    const customWarn = vi.fn();
    const reader = buildL2PrincipleReader(tmpDir, { logger: { warn: customWarn } });
    await reader.listActivePrinciples();

    expect(customWarn).toHaveBeenCalledTimes(1);
    const warnMsg = customWarn.mock.calls[0]?.[0] ?? '';
    expect(warnMsg).toContain('degraded');
    expect(warnMsg).toContain('custom error');
  });

  it('returns a PdL2PrincipleReader object', () => {
    const reader = buildL2PrincipleReader(tmpDir);
    expect(reader).toBeDefined();
    expect(typeof reader.listActivePrinciples).toBe('function');
  });

  it('filters out active principles with empty text', async () => {
    // Edge case: empty string text should be rejected as an invalid principle statement.
    // The filter checks `typeof p.text === 'string'` and `p.text.length > 0`.
    writeLedger(tmpDir, {
      principles: {
        'p-good': makePrinciple({ id: 'p-good', text: 'Good principle', status: 'active' }),
        'p-empty-text': makePrinciple({ id: 'p-empty-text', text: '', status: 'active' }),
      },
    });

    const reader = buildL2PrincipleReader(tmpDir);
    const result = await reader.listActivePrinciples();

    // p-empty-text is skipped because empty text is not a valid principle statement.
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('p-good');
  });

  it('buildL2PrincipleReaderFromLedger works without file I/O', async () => {
    const ledger = {
      tree: {
        principles: {
          'p-1': { status: 'active', id: 'p-1', text: 'Test principle' },
          'p-2': { status: 'draft', id: 'p-2', text: 'Draft principle' },
        },
      },
    };
    const reader = buildL2PrincipleReaderFromLedger(ledger);
    const result = await reader.listActivePrinciples();
    expect(result).toEqual([{ id: 'p-1', statement: 'Test principle' }]);
  });

  it('buildL2PrincipleReaderFromLedger warns on malformed principles', async () => {
    const warnings: string[] = [];
    // Simulate a ledger where a principle has a non-string id (e.g., corrupted data)
    const ledger = {
      tree: {
        principles: {
          'p-ok': { status: 'active', id: 'p-ok', text: 'OK' },
          'p-bad': { status: 'active', id: 123 as unknown as string, text: 'Bad id' },
        },
      },
    };
    const reader = buildL2PrincipleReaderFromLedger(ledger, {
      logger: { warn: (msg) => warnings.push(msg) },
    });
    const result = await reader.listActivePrinciples();
    expect(result).toEqual([{ id: 'p-ok', statement: 'OK' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('skipping active principle');
  });
});
