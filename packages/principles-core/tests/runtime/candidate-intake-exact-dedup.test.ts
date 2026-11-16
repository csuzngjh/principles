/**
 * Phase 7.2 B1 — CandidateIntakeService exact-duplicate downstream contract.
 *
 * Covers the service half of the guard (LEDGER_WRITE_SAFETY_SPEC §3.4):
 *   - a dedup resolution returns `{ written: false, deduplicatedAgainst }`
 *     with the SURVIVING entry and resolves the candidate onto the existing
 *     principle;
 *   - the resolution is audited OUTSIDE the ledger write via the existing
 *     appendReuseEvidence seam (actor ai_owner/exact-dedupe-guard), and the
 *     audit carries the candidate's real Pain source;
 *   - an audit failure fails the ENTIRE intake (no success, candidate stays
 *     pending) and a retry after the failure records exactly one entry
 *     (INV-R07 idempotency);
 *   - end-to-end with the REAL adapter + REAL ledger file: second candidate
 *     with identical text resolves onto the first candidate's principle.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CandidateIntakeService } from '../../src/runtime/candidate-intake-service.js';
import type { CandidateIntakeResult } from '../../src/runtime/candidate-intake-service.js';
import { CandidateIntakeError } from '../../src/runtime/candidate-intake.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../../src/runtime/candidate-intake.js';
import type { RuntimeStateManager } from '../../src/runtime/store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../../src/runtime/adapter/principle-tree-ledger-adapter.js';
import { loadLedger } from '../../src/principle-tree-ledger.js';

function createCandidate(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: 'cand-dedup-001',
    artifactId: 'art-dedup-001',
    taskId: 'task-dedup-001',
    sourceRunId: 'run-dedup-001',
    title: 'Verify before delete',
    description: 'When deleting files, always verify the backup exists first.',
    confidence: 0.95,
    sourceRecommendationJson: JSON.stringify({
      title: 'Verify before delete',
      text: 'When deleting files, always verify the backup exists first.',
      triggerPattern: 'file delete',
      action: 'verify backup',
    }),
    recommendationKind: 'principle',
    rawRecommendationKind: 'principle',
    status: 'pending' as const,
    createdAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

function createArtifact() {
  return {
    artifactId: 'art-dedup-001',
    runId: 'run-dedup-001',
    taskId: 'task-dedup-001',
    artifactKind: 'diagnostician_output',
    contentJson: JSON.stringify({ recommendation: { text: 'When deleting files, always verify the backup exists first.' } }),
    createdAt: '2026-11-16T00:00:00.000Z',
  };
}

function createMockStateManager(overrides: Record<string, unknown> = {}) {
  return {
    getCandidate: vi.fn(),
    getArtifact: vi.fn(),
    getTask: vi.fn().mockResolvedValue({ taskId: 'task-dedup-001', taskKind: 'legacy_manual_source' }),
    getDiagnosesByTaskId: vi.fn().mockResolvedValue([
      { id: 'dx-1', painId: 'pain-dedup-001', createdAt: '2026-11-16T00:00:00.000Z' },
    ]),
    updateCandidateStatus: vi.fn(),
    ...overrides,
  } as unknown as RuntimeStateManager;
}

function createMockLedgerAdapter(overrides: Record<string, unknown> = {}) {
  return {
    writeProbationEntry: vi.fn(),
    existsForCandidate: vi.fn(() => null),
    findReuseResolutionForCandidate: vi.fn(() => null),
    appendReuseEvidence: vi.fn((principleId: string, entry: { candidateId: string }) => ({
      principleId,
      reuseEvidence: [entry],
      appended: true,
    })),
    ...overrides,
  } as unknown as LedgerAdapter;
}

function mintedEntry(): LedgerPrincipleEntry {
  return {
    id: 'minted-uuid-0001',
    title: 'Verify before delete',
    text: 'When deleting files, always verify the backup exists first.',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: 'candidate://cand-dedup-001',
    artifactRef: 'artifact://art-dedup-001',
    createdAt: '2026-11-16T00:00:00.000Z',
  };
}

describe('Phase 7.2 B1 — CandidateIntakeService exact-duplicate resolution', () => {
  it('returns written:false + deduplicatedAgainst and audits the resolution outside the write', async () => {
    const stateManager = createMockStateManager({
      getCandidate: vi.fn().mockResolvedValue(createCandidate()),
      getArtifact: vi.fn().mockResolvedValue(createArtifact()),
    });
    const existingView: LedgerPrincipleEntry = { ...mintedEntry(), id: 'existing-principle-001' };
    const adapter = createMockLedgerAdapter({
      writeProbationEntry: vi.fn().mockImplementation((entry: LedgerPrincipleEntry) => {
        // Adapter contract on a dedup hit: same entry shape, the SURVIVING id
        // (differs from the id the service minted at step 5).
        expect(entry.id).not.toBe('existing-principle-001');
        return existingView;
      }),
    });

    const service = new CandidateIntakeService({ stateManager, ledgerAdapter: adapter });
    const result = await service.intake('cand-dedup-001');

    expect(result.outcome).toBe('ledger_entry');
    if (result.outcome !== 'ledger_entry') return;
    expect(result.written).toBe(false);
    expect(result.deduplicatedAgainst).toBe('existing-principle-001');
    expect(result.entry.id).toBe('existing-principle-001');

    // The audit: existing appendReuseEvidence seam, deterministic guard actor,
    // real pain source, INV-R07-compatible idempotency key.
    expect(adapter.appendReuseEvidence).toHaveBeenCalledOnce();
    const [principleId, entry] = (adapter.appendReuseEvidence as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(principleId).toBe('existing-principle-001');
    expect(entry.candidateId).toBe('cand-dedup-001');
    expect(entry.painId).toBe('pain-dedup-001');
    expect(entry.decision).toBe('reuse');
    expect(entry.actor).toEqual({ kind: 'ai_owner', id: 'exact-dedupe-guard' });
  });

  it('audit failure fails the whole intake — the candidate is never reported consumed', async () => {
    const stateManager = createMockStateManager({
      getCandidate: vi.fn().mockResolvedValue(createCandidate()),
      getArtifact: vi.fn().mockResolvedValue(createArtifact()),
    });
    const adapter = createMockLedgerAdapter({
      writeProbationEntry: vi.fn().mockImplementation((entry: LedgerPrincipleEntry) => ({
        ...entry,
        id: 'existing-principle-001',
      })),
      appendReuseEvidence: vi.fn(() => {
        throw new Error('EACCES: permission denied, open ledger.json');
      }),
    });

    const service = new CandidateIntakeService({ stateManager, ledgerAdapter: adapter });
    const err = await service.intake('cand-dedup-001').then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CandidateIntakeError);
    expect((err as CandidateIntakeError).code).toBe('reuse_check_failed');
    expect((err as CandidateIntakeError).context).toMatchObject({
      candidateId: 'cand-dedup-001',
      deduplicatedAgainst: 'existing-principle-001',
    });
  });

  it('an adapter that loses the evidence entry fails loud instead of reporting success', async () => {
    const stateManager = createMockStateManager({
      getCandidate: vi.fn().mockResolvedValue(createCandidate()),
      getArtifact: vi.fn().mockResolvedValue(createArtifact()),
    });
    const adapter = createMockLedgerAdapter({
      writeProbationEntry: vi.fn().mockImplementation((entry: LedgerPrincipleEntry) => ({
        ...entry,
        id: 'existing-principle-001',
      })),
      appendReuseEvidence: vi.fn(() => ({
        principleId: 'existing-principle-001',
        reuseEvidence: [], // contract violation: our candidateId vanished
        appended: true,
      })),
    });

    const service = new CandidateIntakeService({ stateManager, ledgerAdapter: adapter });
    await expect(service.intake('cand-dedup-001')).rejects.toMatchObject({
      name: 'CandidateIntakeError',
      code: 'reuse_check_failed',
    });
  });

  it('retry after an audit failure records exactly one evidence entry (INV-R07 through the real ledger)', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intake-dedup-retry-'));
    try {
      const realAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
      // First candidate registers the principle.
      const first = realAdapter.writeProbationEntry({
        ...mintedEntry(),
        id: 'first-principle-001',
        sourceRef: 'candidate://cand-first',
      });
      expect(first.id).toBe('first-principle-001');

      const stateManager = createMockStateManager({
        getCandidate: vi.fn().mockResolvedValue(createCandidate()),
        getArtifact: vi.fn().mockResolvedValue(createArtifact()),
      });
      const failingAdapter = createMockLedgerAdapter({
        writeProbationEntry: vi.fn().mockImplementation((entry: LedgerPrincipleEntry) => realAdapter.writeProbationEntry(entry)),
        appendReuseEvidence: vi.fn(() => {
          throw new Error('simulated first-attempt audit failure');
        }),
      });

      const failingService = new CandidateIntakeService({ stateManager, ledgerAdapter: failingAdapter });
      await expect(failingService.intake('cand-dedup-001')).rejects.toMatchObject({ code: 'reuse_check_failed' });
      // The ledger itself recorded the resolution (write happened), but the
      // AUDIT did not — the intake correctly reported failure.
      expect(loadLedger(stateDir).tree.principles['first-principle-001']?.reuseEvidence ?? []).toHaveLength(0);

      // Retry with the real adapter end to end: the audit lands exactly once.
      const retryService = new CandidateIntakeService({ stateManager, ledgerAdapter: realAdapter });
      const retried: CandidateIntakeResult = await retryService.intake('cand-dedup-001');
      expect(retried.outcome).toBe('ledger_entry');
      if (retried.outcome !== 'ledger_entry') return;
      expect(retried.written).toBe(false);
      expect(retried.deduplicatedAgainst).toBe('first-principle-001');

      const stored = loadLedger(stateDir).tree.principles['first-principle-001'];
      expect(stored?.reuseEvidence).toHaveLength(1);
      expect(stored?.reuseEvidence?.[0]).toMatchObject({
        candidateId: 'cand-dedup-001',
        decision: 'reuse',
        actor: { kind: 'ai_owner', id: 'exact-dedupe-guard' },
      });
      // Exactly one principle in the ledger — no parallel entry was created.
      expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('end-to-end with the REAL adapter: second identical candidate resolves onto the first principle', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intake-dedup-e2e-'));
    try {
      const realAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
      const firstService = new CandidateIntakeService({
        stateManager: createMockStateManager({
          getCandidate: vi.fn().mockResolvedValue(createCandidate({ candidateId: 'cand-first', taskId: 'task-first' })),
          getArtifact: vi.fn().mockResolvedValue(createArtifact()),
        }),
        ledgerAdapter: realAdapter,
      });
      const first = await firstService.intake('cand-first');
      expect(first.outcome).toBe('ledger_entry');
      if (first.outcome !== 'ledger_entry') return;
      expect(first.written).toBe(true);
      const firstId = first.entry.id;

      // Second candidate, IDENTICAL text, different candidate/pain/task.
      const secondService = new CandidateIntakeService({
        stateManager: createMockStateManager({
          getCandidate: vi.fn().mockResolvedValue(
            createCandidate({
              candidateId: 'cand-second',
              artifactId: 'art-second',
              taskId: 'task-second',
              sourceRunId: 'run-second',
            }),
          ),
          getArtifact: vi.fn().mockResolvedValue(createArtifact()),
          getDiagnosesByTaskId: vi.fn().mockResolvedValue([
            { id: 'dx-2', painId: 'pain-second-001', createdAt: '2026-11-16T01:00:00.000Z' },
          ]),
        }),
        ledgerAdapter: realAdapter,
      });
      const second = await secondService.intake('cand-second');

      expect(second.outcome).toBe('ledger_entry');
      if (second.outcome !== 'ledger_entry') return;
      expect(second.written).toBe(false);
      expect(second.deduplicatedAgainst).toBe(firstId);
      expect(second.entry.id).toBe(firstId);

      const ledger = loadLedger(stateDir);
      expect(Object.keys(ledger.tree.principles)).toHaveLength(1);
      const evidence = ledger.tree.principles[firstId]?.reuseEvidence ?? [];
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ candidateId: 'cand-second', painId: 'pain-second-001' });

      // Replay of the second candidate short-circuits at step 2b (reuse
      // resolution replay) — no second decision, no new principle.
      const replay = await secondService.intake('cand-second');
      expect(replay.outcome).toBe('refused');
      if (replay.outcome !== 'refused') return;
      expect(replay.reason).toBe('reuse_selected');
      expect(replay.selectedPrincipleId).toBe(firstId);
      expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
