import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PDRuntimeError } from '../error-categories.js';
import {
  RuntimeStateManager,
  createDiagnosticianTaskId,
} from '../index.js';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import { denyAllSourceMaterialAuthorization } from '../source-material-authorization.js';
import {
  filterEvidenceByAuthorization,
  hostKindFromGovernanceSourceRef,
  isOwnerManualCorrectionEvidence,
} from '../source-material-authorization.js';
import { fingerprintStatement } from '../store/candidate/admission-document.js';
import { readPromotedEvidenceWindow } from '../store/context/promoted-evidence-reader.js';
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

  it('evidence filter removes revoked-source entries and keeps owner-reported ones', () => {
    const filtered = filterEvidenceByAuthorization([
      { sourceRef: 'governance_observation:codex|rollout-1|turn-1|user', note: 'x' },
      { sourceRef: 'owner_reported:cli', note: 'y' },
      { sourceRef: 'candidate://abc', note: 'z' },
    ], deny('codex'));
    expect(filtered.kept.map((e) => e.sourceRef)).toEqual(['owner_reported:cli', 'candidate://abc']);
    expect(filtered.removed.length).toBe(1);
    expect(filtered.denialReasons).toEqual(['consent_revoked']);
    expect(filterEvidenceByAuthorization([{ sourceRef: 'owner_reported:cli', note: 'y' }], denyAllSourceMaterialAuthorization).kept.length).toBe(1);
  });

  it('an unattributable governance sourceRef maps to no host', () => {
    expect(hostKindFromGovernanceSourceRef('governance_observation:alien|x')).toBeNull();
  });
});

describe('PRI-1283 core — promoted evidence window honors authorized hosts (real SQLite)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1283-core-pw-'));
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('serves promoted rows of an authorized host and excludes a revoked host', () => {
    // Direct SQL seeding of the promoted shape the host-runtime promoter
    // writes: retention_class='promoted', promotion_ref = pain id.
    const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`CREATE TABLE governance_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_kind TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      rollout_identity TEXT,
      root_session_id TEXT,
      host_turn_id TEXT,
      kind TEXT NOT NULL,
      visible_text TEXT,
      sanitized_tool_facts_json TEXT,
      source TEXT,
      completeness TEXT,
      observed_at TEXT NOT NULL,
      retention_class TEXT NOT NULL DEFAULT 'operational',
      expired_at TEXT,
      promotion_ref TEXT,
      source_order INTEGER
    )`);
    const insert = sqlite.prepare(
      "INSERT INTO governance_observations (host_kind, logical_key, kind, visible_text, observed_at, retention_class, promotion_ref, source_order) VALUES (?, ?, 'user_turn', ?, ?, 'promoted', ?, ?)",
    );
    insert.run('codex', 'codex|rollout-1|turn-1|user', 'promoted codex excerpt', '2026-11-21T10:00:00Z', 'pain-1', 1);
    insert.run('workbuddy', 'wb|wb-session-1|wb-turn-1', 'promoted wb excerpt', '2026-11-21T10:01:00Z', 'pain-1', 2);
    sqlite.close();

    const granted = readPromotedEvidenceWindow({ workspaceDir, painId: 'pain-1', maxEntries: 10, authorizedHostKinds: ['codex', 'workbuddy'] });
    expect(granted.status).toBe('ok');
    if (granted.status === 'ok') expect(granted.entries.length).toBe(2);

    const wbOnly = readPromotedEvidenceWindow({ workspaceDir, painId: 'pain-1', maxEntries: 10, authorizedHostKinds: ['workbuddy'] });
    expect(wbOnly.status).toBe('ok');
    if (wbOnly.status === 'ok') {
      expect(wbOnly.entries.length).toBe(1);
      expect(wbOnly.entries[0]?.text).toContain('promoted wb excerpt');
    }
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

  it('revoked port withholds governance evidence, keeps OWNER-EXPLICIT correction evidence (directive B), records an ambiguity note', async () => {
    const payload = await assembler(deny('codex')).assemble(createDiagnosticianTaskId('pain_1'));
    expect(payload.diagnosisTarget.evidence?.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    // The fixture's correction channel is codex_explicit_prefix — an explicit
    // Owner submission is an Owner act and SURVIVES the revocation.
    expect(payload.diagnosisTarget.correctionEvidence?.text).toBe('owner words');
    expect(payload.sourceRefs).not.toContain('governance_observation:codex|rollout-1|turn-1|user');
    expect(payload.ambiguityNotes?.some((n) => n.includes('withheld'))).toBe(true);
    // The withheld note must not leak the excerpt text.
    expect(payload.ambiguityNotes?.some((n) => n.includes('codex excerpt'))).toBe(false);
  });

  it('revoked port still withholds a CHANNEL-LESS governed correction (legacy codex attribution)', async () => {
    await stateManager.createTask({
      taskId: createDiagnosticianTaskId('pain_legacy'),
      taskKind: 'diagnostician',
      inputRef: 'pain_legacy',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain_legacy',
        reasonSummary: 'r',
        source: 'user_correction',
        severity: 'severe',
        sessionIdHint: null,
        provenance: 'host_context_bound',
        hostKind: 'codex',
        evidence: [{ sourceRef: 'owner_reported:cli', note: 'owner note' }],
        // Channel-less correction of a codex task: legacy governed shape.
        correctionEvidence: { text: 'governed correction words', classification: 'owner_statement' },
        workspaceDir,
      }),
    });
    const payload = await assembler(deny('codex')).assemble(createDiagnosticianTaskId('pain_legacy'));
    expect(payload.diagnosisTarget.correctionEvidence).toBeUndefined();
  });

  it('unwired assembler fails CLOSED for governance material (deny-all default) but keeps OWNER-EXPLICIT corrections', async () => {
    const payload = await assembler().assemble(createDiagnosticianTaskId('pain_1'));
    expect(payload.diagnosisTarget.evidence?.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    expect(payload.diagnosisTarget.correctionEvidence?.text).toBe('owner words');
  });

  async function createAgentChannelTask(painId: string, correctionEvidence: Record<string, unknown>): Promise<void> {
    await stateManager.createTask({
      taskId: createDiagnosticianTaskId(painId),
      taskKind: 'diagnostician',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: painId,
        reasonSummary: 'r',
        source: 'user_correction',
        severity: 'severe',
        sessionIdHint: null,
        provenance: 'host_context_bound',
        hostKind: 'codex',
        evidence: [{ sourceRef: 'owner_reported:cli', note: 'owner note' }],
        correctionEvidence,
        workspaceDir,
      }),
    });
  }

  it('r3: revoked port WITHHOLDS an unverified codex_explicit_agent correction (Agent-derived, governed)', async () => {
    await createAgentChannelTask('pain_agent_unverified', {
      text: 'agent-transcribed words',
      channel: 'codex_explicit_agent',
    });
    const payload = await assembler(deny('codex')).assemble(createDiagnosticianTaskId('pain_agent_unverified'));
    expect(payload.diagnosisTarget.correctionEvidence).toBeUndefined();
    // Self-declared classification does not rescue it either.
    await createAgentChannelTask('pain_agent_selfdeclared', {
      text: 'agent-claimed owner words',
      classification: 'owner_statement',
      channel: 'codex_explicit_agent',
    });
    const selfDeclared = await assembler(deny('codex')).assemble(createDiagnosticianTaskId('pain_agent_selfdeclared'));
    expect(selfDeclared.diagnosisTarget.correctionEvidence).toBeUndefined();
  });

  it('r3: revoked port KEEPS a codex_explicit_agent correction carrying a bound Owner confirmation', async () => {
    const text = 'owner words relayed verbatim';
    await createAgentChannelTask('pain_agent_confirmed', {
      text,
      classification: 'owner_statement',
      channel: 'codex_explicit_agent',
      ownerConfirmation: { kind: 'owner_verbatim_turn_match', statementFingerprint: fingerprintStatement(text) },
    });
    const payload = await assembler(deny('codex')).assemble(createDiagnosticianTaskId('pain_agent_confirmed'));
    expect(payload.diagnosisTarget.correctionEvidence?.text).toBe(text);
  });
});

describe('PRI-1283 r3 — owner_manual 判定 (Owner classification ruling)', () => {
  const confirmed = (text: string) => ({
    text,
    classification: 'owner_statement',
    channel: 'codex_explicit_agent',
    ownerConfirmation: { kind: 'owner_verbatim_turn_match', statementFingerprint: fingerprintStatement(text) },
  });

  it('直接 Owner 通道属于 owner_manual（无需确认记录）', () => {
    for (const channel of ['codex_explicit_prefix', 'workbuddy_explicit_prefix', 'cli_owner_statement', 'openclaw_manual_pain']) {
      expect(isOwnerManualCorrectionEvidence({ text: 'owner words', channel })).toBe(true);
    }
  });

  it('Agent 代提交 + 绑定确认记录属于 owner_manual', () => {
    expect(isOwnerManualCorrectionEvidence(confirmed('owner words verbatim'))).toBe(true);
  });

  it('Agent 自行转述/总结（无确认记录）属于 Agent-derived', () => {
    expect(isOwnerManualCorrectionEvidence({ text: 'agent words', channel: 'codex_explicit_agent' })).toBe(false);
    expect(isOwnerManualCorrectionEvidence({ text: 'agent words', channel: 'codex_explicit_agent', classification: 'owner_statement' })).toBe(false);
  });

  it('Payload 中自我声明的 Owner 确认不构成有效确认', () => {
    // 伪造 kind / 伪造 fingerprint 均不满足。
    expect(isOwnerManualCorrectionEvidence({
      text: 't', classification: 'owner_statement', channel: 'codex_explicit_agent',
      ownerConfirmation: { kind: 'self_declared', statementFingerprint: fingerprintStatement('t') },
    })).toBe(false);
    expect(isOwnerManualCorrectionEvidence({
      text: 't', classification: 'owner_statement', channel: 'codex_explicit_agent',
      ownerConfirmation: { kind: 'owner_verbatim_turn_match', statementFingerprint: 'forged' },
    })).toBe(false);
    expect(isOwnerManualCorrectionEvidence({
      text: 't', classification: 'owner_statement', channel: 'codex_explicit_agent',
      ownerConfirmation: 'not-an-object',
    })).toBe(false);
  });

  it('确认内容与最终提交不一致（fingerprint 绑定失败）不属于 owner_manual', () => {
    expect(isOwnerManualCorrectionEvidence({
      text: 'final submitted text',
      classification: 'owner_statement',
      channel: 'codex_explicit_agent',
      ownerConfirmation: { kind: 'owner_verbatim_turn_match', statementFingerprint: fingerprintStatement('different confirmed text') },
    })).toBe(false);
  });

  it('非受管/未知通道不属于 owner_manual；缺 text 不属于 owner_manual', () => {
    expect(isOwnerManualCorrectionEvidence({ text: 't', channel: 'some_other' })).toBe(false);
    expect(isOwnerManualCorrectionEvidence({ channel: 'codex_explicit_prefix' })).toBe(false);
    expect(isOwnerManualCorrectionEvidence({ text: '', channel: 'codex_explicit_prefix' })).toBe(false);
    expect(isOwnerManualCorrectionEvidence('not-an-object')).toBe(false);
    expect(isOwnerManualCorrectionEvidence(null)).toBe(false);
  });
});
