import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrincipleTreeLedgerAdapter } from '../../src/core/principle-tree-ledger-adapter.js';
import { loadLedger } from '../../src/core/principle-tree-ledger.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES } from '@principles/core/runtime-v2';
import type { LedgerPrincipleEntry } from '@principles/core/runtime-v2';
import { safeRmDir } from '../test-utils.js';

// Mock principle-tree-ledger.js module
// Use vi.mock with factory to provide controllable addPrincipleToLedger
vi.mock('../../src/core/principle-tree-ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/principle-tree-ledger.js')>('../../src/core/principle-tree-ledger.js');
  return {
    ...actual,
    addPrincipleToLedger: vi.fn(actual.addPrincipleToLedger),
  };
});

describe('PrincipleTreeLedgerAdapter', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-adapter-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  function createEntry(overrides: Partial<LedgerPrincipleEntry> = {}): LedgerPrincipleEntry {
    return {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Test Principle',
      text: 'When file delete is attempted, then verify backup exists first.',
      triggerPattern: 'file delete',
      action: 'verify backup exists',
      status: 'probation',
      evaluability: 'weak_heuristic',
      sourceRef: 'candidate://test-candidate-001',
      artifactRef: 'artifact://test-artifact-001',
      taskRef: 'task://test-task-001',
      createdAt: '2026-04-26T10:00:00.000Z',
      ...overrides,
    };
  }

  describe('writeProbationEntry', () => {
    it('writes a LedgerPrinciple to the ledger file with correct field expansion', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry();
      const result = adapter.writeProbationEntry(entry);

      expect(result).toBe(entry);

      const store = loadLedger(stateDir);
      const written = store.tree.principles[entry.id];
      expect(written).toBeDefined();
      expect(written.id).toBe(entry.id);
      expect(written.text).toBe(entry.text);
      expect(written.status).toBe('candidate');
      expect(written.triggerPattern).toBe(entry.triggerPattern);
      expect(written.action).toBe(entry.action);
    });

    it('is idempotent — second call with same candidateId returns existing entry, no double write', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry();
      const first = adapter.writeProbationEntry(entry);
      const second = adapter.writeProbationEntry(entry);

      expect(second).toBe(first);

      const store = loadLedger(stateDir);
      expect(Object.keys(store.tree.principles).length).toBe(1);
    });

    it('different candidates produce different entries', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry1 = createEntry({
        id: '550e8400-e29b-41d4-a716-446655440000',
        sourceRef: 'candidate://alpha',
      });
      const entry2 = createEntry({
        id: '660e8400-e29b-41d4-a716-446655440001',
        sourceRef: 'candidate://beta',
        title: 'Another Principle',
        text: 'When network fails, retry with backoff.',
      });

      adapter.writeProbationEntry(entry1);
      adapter.writeProbationEntry(entry2);

      const store = loadLedger(stateDir);
      expect(Object.keys(store.tree.principles).length).toBe(2);
      expect(store.tree.principles[entry1.id]).toBeDefined();
      expect(store.tree.principles[entry2.id]).toBeDefined();

      expect(adapter.existsForCandidate('alpha')).toBeDefined();
      expect(adapter.existsForCandidate('beta')).toBeDefined();
    });
  });

  describe('existsForCandidate', () => {
    it('returns the entry for a previously written candidate', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry();
      adapter.writeProbationEntry(entry);

      const found = adapter.existsForCandidate('test-candidate-001');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(entry.id);
      expect(found?.title).toBe(entry.title);
      expect(found?.sourceRef).toBe(entry.sourceRef);
    });

    it('returns null for an unknown candidate', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const result = adapter.existsForCandidate('nonexistent-candidate');
      expect(result).toBeNull();
    });
  });

  describe('field expansion', () => {
    it('maps status probation to candidate', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry();
      adapter.writeProbationEntry(entry);

      const store = loadLedger(stateDir);
      const written = store.tree.principles[entry.id];
      expect(written.status).toBe('candidate');
      expect(written.status).not.toBe('probation');
    });

    it('applies default values correctly', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry({
        triggerPattern: undefined,
        action: undefined,
        artifactRef: undefined,
        taskRef: undefined,
      });
      adapter.writeProbationEntry(entry);

      const store = loadLedger(stateDir);
      const written = store.tree.principles[entry.id];
      expect(written.version).toBe(1);
      expect(written.priority).toBe('P1');
      expect(written.scope).toBe('general');
      expect(written.valueScore).toBe(0);
      expect(written.adherenceRate).toBe(0);
      expect(written.painPreventedCount).toBe(0);
      expect(written.createdAt).toBe(entry.createdAt);
      expect(written.updatedAt).toBe(entry.createdAt);
    });

    it('passes through triggerPattern and action (Decision B)', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry1 = createEntry({ triggerPattern: 'file delete', action: 'verify backup' });
      adapter.writeProbationEntry(entry1);

      let store = loadLedger(stateDir);
      let written = store.tree.principles[entry1.id];
      expect(written.triggerPattern).toBe('file delete');
      expect(written.action).toBe('verify backup');

      const entry2 = createEntry({
        id: '770e8400-e29b-41d4-a716-446655440002',
        sourceRef: 'candidate://test-002',
        triggerPattern: undefined,
        action: undefined,
      });
      adapter.writeProbationEntry(entry2);

      store = loadLedger(stateDir);
      written = store.tree.principles[entry2.id];
      expect(written.triggerPattern).toBe('');
      expect(written.action).toBe('');
    });

    it('does NOT include sourceRef, artifactRef, taskRef in ledger (Decision C)', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry();
      adapter.writeProbationEntry(entry);

      const store = loadLedger(stateDir);
      const written = store.tree.principles[entry.id];
      expect('sourceRef' in written).toBe(false);
      expect('artifactRef' in written).toBe(false);
      expect('taskRef' in written).toBe(false);

      // But existsForCandidate still works
      expect(adapter.existsForCandidate('test-candidate-001')).not.toBeNull();
    });

    it('populates derivedFromPainIds with candidateId (Q1 resolved)', () => {
      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry({ sourceRef: 'candidate://test-candidate-001' });
      adapter.writeProbationEntry(entry);

      const store = loadLedger(stateDir);
      const written = store.tree.principles[entry.id];
      expect(written.derivedFromPainIds).toEqual(['test-candidate-001']);
    });
  });

  describe('error handling', () => {
    it('throws LEDGER_WRITE_FAILED when addPrincipleToLedger fails', async () => {
      const mockedModule = await import('../../src/core/principle-tree-ledger.js');
      const mockAdd = vi.mocked(mockedModule.addPrincipleToLedger);
      mockAdd.mockImplementation(() => {
        throw new Error('Disk full');
      });

      const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const entry = createEntry();

      expect(() => adapter.writeProbationEntry(entry)).toThrow(CandidateIntakeError);
      try {
        adapter.writeProbationEntry(entry);
      } catch (err) {
        expect(err).toBeInstanceOf(CandidateIntakeError);
        expect((err as CandidateIntakeError).code).toBe(INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED);
        expect((err as Error).message).toContain(entry.id);
      }

      mockAdd.mockRestore();
    });
  });

  describe('instance isolation', () => {
    it('separate instances have separate Maps', () => {
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-adapter-'));
      const stateDir2 = path.join(tempDir2, '.state');
      fs.mkdirSync(stateDir2, { recursive: true });

      const adapterA = new PrincipleTreeLedgerAdapter({ stateDir });
      const adapterB = new PrincipleTreeLedgerAdapter({ stateDir: stateDir2 });

      const entryA = createEntry({ sourceRef: 'candidate://candidate-A' });
      adapterA.writeProbationEntry(entryA);

      expect(adapterB.existsForCandidate('candidate-A')).toBeNull();

      safeRmDir(tempDir2);
    });
  });
});
