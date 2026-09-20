import { describe, expect, it } from 'vitest';
import {
  candidateIdFromDreamerTaskId,
  resolveLedgerPrincipleId,
} from '../../src/server/models/principle-id-resolution.js';
import type { PIArtifactRecord } from '@principles/core/runtime-v2';
import type { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';

const CANDIDATE_ID = 'e57b62ca-34e6-4863-aca5-ef8e5febc232';
const LEDGER_ID = '6d2f3fe6-b465-4a77-ad6b-af10aac5fc7d';

function makeArtifact(overrides: Partial<PIArtifactRecord> = {}): PIArtifactRecord {
  return {
    artifactId: 'pi-art-scribe-x-run_x_1',
    artifactKind: 'principle',
    sourceTaskId: 'scribe-x',
    sourcePrincipleId: null,
    sourceRuleId: null,
    lineageArtifactIds: ['pi-art-dreamer-x-run_x_1'],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleDraft: { title: '某草稿标题' } }),
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeLedger(overrides: Partial<Record<'has' | 'ids', unknown>> = {}): PrincipleTreeLedgerAdapter {
  const has = overrides.has ?? new Set<string>();
  const idsByCandidate = overrides.ids ?? new Map<string, { id: string }[]>();
  return {
    hasPrinciple: (id: string) => (has as Set<string>).has(id),
    listForCandidate: (candidateId: string) =>
      (idsByCandidate as Map<string, { id: string }[]>).get(candidateId) ?? [],
  } as unknown as PrincipleTreeLedgerAdapter;
}

const noopDeps = (ledger: PrincipleTreeLedgerAdapter) => ({
  ledger,
  getArtifactById: async () => null,
  getTaskDiagnosticJson: () => null,
});

describe('candidateIdFromDreamerTaskId', () => {
  it('extracts the candidate id from the middle segment', () => {
    expect(candidateIdFromDreamerTaskId(`dreamer-${CANDIDATE_ID}-prompt`)).toBe(CANDIDATE_ID);
    expect(candidateIdFromDreamerTaskId(`dreamer-${CANDIDATE_ID}-code_tool_hook`)).toBe(CANDIDATE_ID);
  });

  it('returns null for non-dreamer tasks and malformed ids', () => {
    expect(candidateIdFromDreamerTaskId('scribe-x')).toBeNull();
    expect(candidateIdFromDreamerTaskId(null)).toBeNull();
    expect(candidateIdFromDreamerTaskId('dreamer-not-a-uuid-prompt')).toBeNull();
  });
});

describe('resolveLedgerPrincipleId', () => {
  it('trusts a direct id only when the ledger contains it', async () => {
    const ledger = makeLedger({ has: new Set([LEDGER_ID]) });
    const artifact = makeArtifact({ sourcePrincipleId: LEDGER_ID });
    const result = await resolveLedgerPrincipleId(artifact, noopDeps(ledger));
    expect(result).toEqual({ status: 'resolved', principleId: LEDGER_ID, how: 'direct' });
  });

  it('F4: does NOT flow an unvalidated draft title into the ledger update path', async () => {
    // sourcePrincipleId is null and contentJson only carries a draft title —
    // the pre-fix code returned that title as "principleId" and the ledger
    // update failed with "Cannot update missing principle <title>".
    const ledger = makeLedger({ has: new Set<string>(), ids: new Map() });
    const result = await resolveLedgerPrincipleId(makeArtifact(), noopDeps(ledger));
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      // The title must never leak into the resolution as an id…
      expect(result.reason).not.toContain('某草稿标题');
      // …and the lineage walk (not the title) is what ends the resolution.
      expect(result.reason).toContain('dreamer artifact');
    }
  });

  it('F3: resolves the real ledger id through the candidate lineage', async () => {
    const dreamerTaskId = `dreamer-${CANDIDATE_ID}-prompt`;
    const ledger = makeLedger({
      has: new Set<string>(),
      ids: new Map([[CANDIDATE_ID, [{ id: LEDGER_ID }]]]),
    });
    const dreamerArtifact = makeArtifact({
      artifactId: 'pi-art-dreamer-x-run_x_1',
      sourceTaskId: dreamerTaskId,
      contentJson: JSON.stringify({ valid: true, taskId: dreamerTaskId, candidates: [], contextRefs: [] }),
    });
    const result = await resolveLedgerPrincipleId(makeArtifact(), {
      ledger,
      getArtifactById: async (id) => (id === dreamerArtifact.artifactId ? dreamerArtifact : null),
      getTaskDiagnosticJson: (taskId) =>
        taskId === dreamerTaskId
          ? JSON.stringify({ candidateId: CANDIDATE_ID, sourcePainId: 'pain_x' })
          : null,
    });
    expect(result).toEqual({
      status: 'resolved',
      principleId: LEDGER_ID,
      how: 'candidate_lineage',
    });
  });

  it('stays unresolved when a candidate maps to multiple ledger principles', async () => {
    const dreamerTaskId = `dreamer-${CANDIDATE_ID}-prompt`;
    const ledger = makeLedger({
      has: new Set<string>(),
      ids: new Map([[CANDIDATE_ID, [{ id: LEDGER_ID }, { id: 'aa353625-0000-4000-8000-000000000000' }]]]),
    });
    const dreamerArtifact = makeArtifact({
      artifactId: 'pi-art-dreamer-x-run_x_1',
      sourceTaskId: dreamerTaskId,
    });
    const result = await resolveLedgerPrincipleId(makeArtifact(), {
      ledger,
      getArtifactById: async (id) => (id === dreamerArtifact.artifactId ? dreamerArtifact : null),
      getTaskDiagnosticJson: () => JSON.stringify({ candidateId: CANDIDATE_ID }),
    });
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      expect(result.reason).toContain('2 ledger principles');
    }
  });
});
