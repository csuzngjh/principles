/**
 * D2 anchor single-track tests — SPEC-PD-PIPELINE-SPINE-001 v0.9 §3.2/§4.4
 * (PRI-1291 Phase 1A red-first).
 *
 * D2 (verified at origin/main): the `principle_deviation` write path stores
 * ONLY the legacy `deviationAnchor` pair, while the diagnostician read path
 * (`SqliteContextAssembler.reconstructDiagnosticianRecord`) restores the
 * Stage-A anchor ONLY from the canonical `parsed.anchor`. Historical and
 * `pain-ingress`-submitted deviation signals therefore lose their principle
 * anchor between write and read.
 *
 * These cases are deliberately written against the CONTRACT the SPEC fixes:
 *   - write side (`evaluatePainIngress` → `legacy`): a valid
 *     `deviationAnchor` must ALSO produce the canonical
 *     `anchor: { type: 'established_principle', ref: '<id>@<version>' }`;
 *   - read side (`reconstructDiagnosticianRecord`): a diagnosticJson with
 *     only a historical `deviationAnchor` must recover the anchor; a
 *     malformed one must surface in `ambiguityNotes` instead of silently
 *     becoming "unknown";
 *   - a canonical `anchor`, when present, always wins (no downgrade).
 */
import { describe, it, expect } from 'vitest';
import { evaluatePainIngress } from '../pain-ingress.js';
import type { PainIngressReport, IngressEvidenceEntry } from '../pain-ingress.js';

const SESSION = 'sess-d2-anchor-1';
const ENTRIES: [IngressEvidenceEntry, ...IngressEvidenceEntry[]] = [
  { kind: 'behavior_trace', sourceRef: 'owner_message:t1', note: 'deviated' },
];

function deviationReport(partial: Partial<PainIngressReport>): PainIngressReport {
  return {
    identity: { kind: 'manual_pain_id', painId: 'manual_d2_1' },
    painType: 'principle_deviation',
    source: 'manual',
    reason: 'violated the owner-review contract',
    score: 80,
    origin: { kind: 'owner_manual', channel: 'openclaw_command' },
    correlation: { status: 'bound', hostKind: 'openclaw', sessionId: SESSION },
    evidence: { status: 'available', entries: ENTRIES },
    deviationAnchor: { principleId: 'P_CANARY_ANCHOR_4d1e', principleVersion: '1' },
    ...partial,
  };
}

describe('D2 write side — evaluatePainIngress produces the canonical anchor', () => {
  it('a principle_deviation with a valid deviationAnchor also carries legacy.anchor', () => {
    const decision = evaluatePainIngress(deviationReport({}));
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    // canonical single-track anchor derived from the verified pair
    expect(decision.legacy.anchor).toEqual({
      type: 'established_principle',
      ref: 'P_CANARY_ANCHOR_4d1e@1',
    });
    // the legacy pair itself stays for existing consumers (compat)
    expect(decision.legacy.deviationAnchor).toEqual({
      principleId: 'P_CANARY_ANCHOR_4d1e',
      principleVersion: '1',
    });
  });

  it('a malformed deviationAnchor does NOT fabricate an anchor (write side stays fail-safe)', () => {
    const decision = evaluatePainIngress(deviationReport({
      deviationAnchor: { principleId: '   ', principleVersion: '1' },
    }));
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.anchor).toBeUndefined();
  });
});

// ── Read side ────────────────────────────────────────────────────────────────
//
// The read-side cases run through the REAL SqliteContextAssembler fixture
// harness (same pattern as sqlite-context-assembler.test.ts) so the anchor
// recovery is proven on the production reconstruction path, not on a private
// helper.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { SqliteRunStore } from '../store/run/sqlite-run-store.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import type { TaskStore } from '../store/task/task-store.js';
import type { DiagnosticianTaskRecord, TaskRecord } from '../task-status.js';

interface ReadFixture {
  tmpDir: string;
  connection: SqliteConnection;
  assembler: SqliteContextAssembler;
}

function createReadFixture(task: TaskRecord): ReadFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-d2-anchor-read-'));
  const connection = new SqliteConnection(tmpDir);
  const runStore = new SqliteRunStore(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const taskStore: TaskStore = {
    createTask: vi.fn(),
    getTask: vi.fn(async (taskId: string) => (taskId === task.taskId ? task : null)),
    updateTask: vi.fn(),
    updateTaskIfDiagnosticJsonUnchanged: vi.fn(async () => null),
    listTasks: vi.fn(async () => []),
    deleteTask: vi.fn(async () => true),
  };
  const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, {
    sourceMaterialAuthorization: { isHostSourceMaterialAuthorized: () => ({ authorized: true }) },
  });
  return { tmpDir, connection, assembler };
}

function makeTask(diagnosticJson: string): DiagnosticianTaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task_d2_read_1',
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    workspaceDir: '/tmp/d2-read-ws',
    reasonSummary: 'D2 read-side fixture',
    diagnosticJson,
  };
}

describe('D2 read side — reconstructDiagnosticianRecord recovers historical deviationAnchor', () => {
  it('diagnosticJson with only a deviationAnchor recovers the canonical anchor (historical rows)', async () => {
    const diagnosticJson = JSON.stringify({
      painId: 'pain-d2-1',
      reason: 'violated the owner-review contract',
      sourcePainId: 'pain-d2-1',
      hostKind: 'openclaw',
      deviationAnchor: { principleId: 'P_CANARY_ANCHOR_4d1e', principleVersion: '1' },
      evidence: [],
    });
    const fixture = createReadFixture(makeTask(diagnosticJson));
    try {
      const context = await fixture.assembler.assemble('task_d2_read_1');
      // historical single-track row: the anchor must be RECOVERED, not unknown
      expect(context.diagnosisTarget.anchor).toEqual({
        type: 'established_principle',
        ref: 'P_CANARY_ANCHOR_4d1e@1',
      });
    } finally {
      fixture.connection.close();
      fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it('a malformed historical deviationAnchor surfaces in ambiguityNotes instead of passing silently', async () => {
    const diagnosticJson = JSON.stringify({
      painId: 'pain-d2-2',
      reason: 'deviated',
      sourcePainId: 'pain-d2-2',
      hostKind: 'openclaw',
      // empty / non-numeric halves: NOT a valid anchor, must never be coerced
      deviationAnchor: { principleId: '', principleVersion: 'not-a-number' },
      evidence: [],
    });
    const fixture = createReadFixture(makeTask(diagnosticJson));
    try {
      const context = await fixture.assembler.assemble('task_d2_read_1');
      expect(context.diagnosisTarget.anchor).toBeUndefined();
      expect((context.ambiguityNotes ?? []).join(' ')).toMatch(/deviationAnchor/i);
    } finally {
      fixture.connection.close();
      fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it('a canonical anchor wins over a stale deviationAnchor (no downgrade)', async () => {
    const diagnosticJson = JSON.stringify({
      painId: 'pain-d2-3',
      reason: 'deviated',
      sourcePainId: 'pain-d2-3',
      hostKind: 'openclaw',
      deviationAnchor: { principleId: 'OLD', principleVersion: '9' },
      anchor: { type: 'established_principle', ref: 'P_CANARY_ANCHOR_4d1e@1' },
      evidence: [],
    });
    const fixture = createReadFixture(makeTask(diagnosticJson));
    try {
      const context = await fixture.assembler.assemble('task_d2_read_1');
      expect(context.diagnosisTarget.anchor).toEqual({ type: 'established_principle', ref: 'P_CANARY_ANCHOR_4d1e@1' });
      expect((context.ambiguityNotes ?? []).join(' ')).not.toMatch(/deviationAnchor/i);
    } finally {
      fixture.connection.close();
      fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});
