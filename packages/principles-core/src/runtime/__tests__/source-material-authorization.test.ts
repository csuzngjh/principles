import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDRuntimeError } from '../error-categories.js';
import {
  RuntimeStateManager,
  createDiagnosticianTaskId,
} from '../index.js';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import { denyAllSourceMaterialAuthorization } from '../source-material-authorization.js';
import { assertPayloadSourceAuthorization, assertArtifactEvidenceAuthorized } from '../internalization/source-authorization-boundary.js';
import type { SourceMaterialAuthorizationPort } from '../source-material-authorization.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';

/**
 * PRI-1283 core-side unit coverage:
 *  - the pure authorization helpers (sourceRef attribution, filtering);
 *  - the model-boundary assertion (assembly -> model call, TECH §2.2 ruling 5)
 *    for BOTH the payload evidence and the governed conversation window;
 *  - the SqliteContextAssembler gate over a REAL SQLite task store.
 */

const allowAll: SourceMaterialAuthorizationPort = {
  isHostSourceMaterialAuthorized: () => ({ authorized: true }),
};

function deny(hostToDeny: 'codex' | 'workbuddy'): SourceMaterialAuthorizationPort {
  return {
    isHostSourceMaterialAuthorized: (host) => (host === hostToDeny
      ? { authorized: false, reason: 'consent_revoked' }
      : { authorized: true }),
  };
}

function payloadFixture(args: { evidenceSourceRefs?: string[]; hostKind?: string; windowEntries?: number } = {}): DiagnosticianContextPayload {
  return {
    contextId: 'ctx-1',
    contextHash: 'hash-1',
    taskId: 'diagnosis_pain_1',
    workspaceDir: '/tmp/ws',
    sourceRefs: ['diagnosis_pain_1'],
    diagnosisTarget: {
      painId: 'pain_1',
      ...(args.hostKind !== undefined ? { hostKind: args.hostKind } : {}),
      evidence: (args.evidenceSourceRefs ?? []).map((sourceRef) => ({ sourceRef, note: 'note' })),
    },
    conversationWindow: Array.from({ length: args.windowEntries ?? 0 }, (_, i) => ({ ts: `2026-11-21T10:0${i}:00Z`, role: 'user' as const, text: `turn ${i}` })),
  } as DiagnosticianContextPayload;
}

describe('PRI-1283 core — model-boundary source authorization', () => {
  it('blocks a payload whose evidence cites a revoked source (exact ref in the error)', () => {
    expect(() => assertPayloadSourceAuthorization(payloadFixture({ evidenceSourceRefs: ['governance_observation:codex|r|t|user'] }), deny('codex'), 'task-1'))
      .toThrowError(/source_authorization_revoked.*codex\|r\|t\|user/);
  });

  it('blocks a governed host conversation window even when evidence refs are clean (post-assembly revocation)', () => {
    const payload = payloadFixture({ hostKind: 'codex', windowEntries: 3 });
    expect(() => assertPayloadSourceAuthorization(payload, deny('codex'), 'task-1'))
      .toThrowError(/conversation window.*codex/);
  });

  it('allows owner-reported material and granted hosts', () => {
    expect(() => assertPayloadSourceAuthorization(payloadFixture({ evidenceSourceRefs: ['owner_reported:cli'], hostKind: 'openclaw', windowEntries: 2 }), allowAll, 'task-1')).not.toThrow();
    expect(() => assertPayloadSourceAuthorization(payloadFixture({ evidenceSourceRefs: ['governance_observation:wb|s|t'] }), deny('codex'), 'task-1')).not.toThrow();
  });

  it('artifact-evidence assertion blocks downstream stages on a revoked ref and passes clean refs', () => {
    expect(() => assertArtifactEvidenceAuthorized({
      stage: 'diag_router', taskId: 't', evidenceSourceRefs: ['owner_reported:cli', 'governance_observation:wb|s|t'], port: deny('workbuddy'),
    })).toThrowError(/source_authorization_revoked/);
    expect(() => assertArtifactEvidenceAuthorized({
      stage: 'diag_router', taskId: 't', evidenceSourceRefs: ['owner_reported:cli'], port: denyAllSourceMaterialAuthorization,
    })).not.toThrow();
  });

  it('an unattributable governance ref in the payload is denied (fail closed)', () => {
    expect(() => assertPayloadSourceAuthorization(payloadFixture({ evidenceSourceRefs: ['governance_observation:weird|x'] }), allowAll, 'task-1'))
      .toThrowError(PDRuntimeError);
  });
});

describe('PRI-1283 core — SqliteContextAssembler gate (real SQLite)', () => {
  let workspaceDir: string;
  let stateManager: RuntimeStateManager;

  beforeEach(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1283-core-'));
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    await stateManager.createTask({
      taskId: createDiagnosticianTaskId('pain_1'),
      taskKind: 'diagnostician',
      inputRef: 'pain_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain_1',
        reasonSummary: 'r',
        source: 'user_correction',
        severity: 'severe',
        sessionIdHint: null,
        provenance: 'host_context_bound',
        hostKind: 'codex',
        evidence: [
          { sourceRef: 'governance_observation:codex|rollout-1|turn-1|user', note: 'codex excerpt' },
          { sourceRef: 'owner_reported:cli', note: 'owner note' },
        ],
        correctionEvidence: { text: 'owner words', classification: 'owner_statement', channel: 'codex_explicit_prefix' },
        workspaceDir,
      }),
    });
  });

  afterEach(async () => {
    await stateManager.close().catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  });

  function assembler(port?: SourceMaterialAuthorizationPort): SqliteContextAssembler {
    return new SqliteContextAssembler(
      stateManager.taskStore,
      new SqliteHistoryQuery(stateManager.connection),
      stateManager.runStore,
      { ...(port !== undefined ? { sourceMaterialAuthorization: port } : {}) },
    );
  }

  it('authorized port keeps governance evidence and correction evidence', async () => {
    const payload = await assembler(allowAll).assemble(createDiagnosticianTaskId('pain_1'));
    expect(payload.diagnosisTarget.evidence?.map((e) => e.sourceRef)).toEqual([
      'governance_observation:codex|rollout-1|turn-1|user',
      'owner_reported:cli',
    ]);
    expect(payload.diagnosisTarget.correctionEvidence?.text).toBe('owner words');
  });

  it('revoked port withholds governance evidence + correction evidence, records an ambiguity note, keeps owner evidence', async () => {
    const payload = await assembler(deny('codex')).assemble(createDiagnosticianTaskId('pain_1'));
    expect(payload.diagnosisTarget.evidence?.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    expect(payload.diagnosisTarget.correctionEvidence).toBeUndefined();
    expect(payload.sourceRefs).not.toContain('governance_observation:codex|rollout-1|turn-1|user');
    expect(payload.ambiguityNotes?.some((n) => n.includes('withheld'))).toBe(true);
    // The withheld note must not leak the excerpt text.
    expect(payload.ambiguityNotes?.some((n) => n.includes('codex excerpt'))).toBe(false);
  });

  it('unwired assembler fails CLOSED for governance material (deny-all default)', async () => {
    const payload = await assembler().assemble(createDiagnosticianTaskId('pain_1'));
    expect(payload.diagnosisTarget.evidence?.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    expect(payload.diagnosisTarget.correctionEvidence).toBeUndefined();
  });
});
