import { describe, expect, it } from 'vitest';
import { assembleEvidenceChain } from '../types/evidence-chain-contract.js';

/**
 * PRI-625 Slice D (SPEC §15): pain records identify the evidence host with
 * safe lineage. host_kind (PRI-640 column) flows through assembleEvidenceChain
 * onto the record; legacy rows without the column degrade to 'unknown' —
 * never dropped, never guessed.
 */

function makeBaseParams(overrides: Partial<Parameters<typeof assembleEvidenceChain>[0]> = {}) {
  return {
    workspaceDir: '/workspace/test',
    painEvents: [
      {
        id: 1,
        source: 'manual',
        reason: 'Repeated correction',
        text: 'Manual record',
        created_at: '2026-09-06T10:00:00.000Z',
        score: 90,
      },
    ],
    tasks: [],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
    ...overrides,
  };
}

describe('evidence chain — evidence host attribution (Slice D §15)', () => {
  it('passes a valid host_kind through to the record', () => {
    const response = assembleEvidenceChain(makeBaseParams({
      painEvents: [{ id: 1, source: 'manual', reason: 'r', text: 't', created_at: '2026-09-06T10:00:00.000Z', score: 90, host_kind: 'codex' }],
    }));
    expect(response.records).toHaveLength(1);
    expect(response.records[0]?.hostKind).toBe('codex');
  });

  it('degrades missing or unknown host_kind to unknown instead of dropping the record', () => {
    const withoutColumn = assembleEvidenceChain(makeBaseParams());
    expect(withoutColumn.records[0]?.hostKind).toBe('unknown');

    const withGarbage = assembleEvidenceChain(makeBaseParams({
      painEvents: [{ id: 1, source: 'manual', reason: 'r', text: 't', created_at: '2026-09-06T10:00:00.000Z', score: 90, host_kind: 'irc' }],
    }));
    expect(withGarbage.records[0]?.hostKind).toBe('unknown');
    expect(withGarbage.records).toHaveLength(1);
  });
});
