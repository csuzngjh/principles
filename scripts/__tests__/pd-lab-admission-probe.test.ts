/**
 * PRI-1257 / PD-Lab v0.3 T7a-Data — admission probe contract tests.
 *
 * Drives the REAL `admission-probe.mjs` CLI (the `npm run lab:probe` entry)
 * as a subprocess against synthetic snapshots built with the REAL trajectory
 * schema. No real full-fidelity data, no network, no model calls — the
 * real-data probe stays NOT_RUN without Owner decision D6.
 *
 * Coverage required by HANDOFF T7a / the task card:
 *  - every CONTRACT §2.4 problem code has a real triggering case and the
 *    closed set of emitted codes equals the CONTRACT first-batch list
 *    (ERR-146 round-trip: no dead enum entries, no unlisted codes);
 *  - DT-02 (early-trajectory gap → INCOMPLETE + remediation reason),
 *    DT-03 (blob missing / digest mismatch), DT-04 (same-source variants
 *    share one group; a split is INVALID_PLAN), DT-05 (research-inference
 *    expectation never reported as user-explicit), DT-06 (withdrawn /
 *    structure-only authorizations), DT-07 (late first row without retention
 *    evidence stays SOURCE_GAP, never SOURCE_RETENTION_EXPIRED);
 *  - source-groups: same-session mechanical rule, no cross-session merging
 *    without an auditable basis, 16-sample / 14-group reality, INVALID_PLAN
 *    on incomplete mapping (SC-19);
 *  - path classification: PIPELINE_REPLAY / EXPECTATION_LABELING /
 *    BEHAVIOR_BRANCH decided independently;
 *  - safety: read-only snapshot discipline, no message bodies in reports,
 *    exit codes 0/1/2/3.
 *
 * Subprocess driving and fixture construction live in
 * fixtures/pd-lab-admission-probe-helpers.mjs (argv-array command form).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTRACT_PROBLEM_CODES,
  SCRIPT_SOURCE,
  T0,
  PAIN_AT,
  buildWorld,
  buildHealthyWorld,
  runProbe,
  readOut,
  codesOf,
  writeJson,
  fingerprintTree,
  healthyExpectations,
  healthyAuthorizations,
  fullGrant,
  stderrReason,
  runNpmLabProbe,
  tmpRoot,
  sha256File,
} from './fixtures/pd-lab-admission-probe-helpers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3'); // same resolution as the helpers fixture

// ---------------------------------------------------------------------------
// Data-integrity checks (TECH §5.2 table rows → CONTRACT §2.4 codes)
// ---------------------------------------------------------------------------

describe('pd-lab admission probe (PRI-1257 T7a-Data)', () => {
  it('healthy sample: COMPLETE_FOR_ANALYSIS, PIPELINE_REPLAY + EXPECTATION_LABELING READY, BEHAVIOR_BRANCH BLOCKED', () => {
    const world = buildHealthyWorld('healthy');
    const exp = writeJson(world.root, 'exp.json', healthyExpectations());
    const auth = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', exp, '--authorizations', auth]);
    expect(run.status).toBe(0);

    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.completeness).toBe('COMPLETE_FOR_ANALYSIS');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
    // Environment evidence is structurally absent from a T1 snapshot →
    // BEHAVIOR_BRANCH stays BLOCKED even though the other paths are READY.
    expect(sample.pathReadiness.BEHAVIOR_BRANCH).toBe('BLOCKED');
    expect(codesOf(out, 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
    expect(sample.executableForDeclaredPath).toEqual({
      PIPELINE_REPLAY: true,
      EXPECTATION_LABELING: true,
      BEHAVIOR_BRANCH: false,
    });
  });

  it('DT-02: session with no turn rows → SOURCE_GAP, INCOMPLETE, remediation entry (not a complete case)', () => {
    const world = buildWorld('nogap', {
      sessions: [{ sessionId: 'sess-empty', startedAt: T0, omitSessionRow: true }],
      samples: [{ caseId: 'S01', sessionId: 'sess-empty' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);

    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('SOURCE_GAP');
    expect(out.report.perSample[0].completeness).toBe('INCOMPLETE');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    const queueEntry = out.queue.entries.find((e: { caseId: string; problemCode: string }) => e.caseId === 'S01' && e.problemCode === 'SOURCE_GAP');
    expect(queueEntry).toBeDefined();
    expect(queueEntry.remediable).toBe(true);
  });

  it('role error: assistant turns without user turns → SOURCE_GAP with a role-coverage impact', () => {
    const world = buildWorld('roleerr', {
      sessions: [{ sessionId: 'sess-role', startedAt: T0, userTurns: [], assistantTurns: [{ createdAt: T0 }, { createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-role' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'SOURCE_GAP');
    expect(problem).toBeDefined();
    expect(problem.impact).toContain('no user turns');
  });

  it('message order error: turn_index contiguous but created_at goes backwards → SOURCE_GAP with order impact', () => {
    const world = buildWorld('order', {
      sessions: [
        {
          sessionId: 'sess-order',
          startedAt: T0,
          userTurns: [
            { turnIndex: 0, createdAt: '2026-09-01T10:02:00.000Z' },
            { turnIndex: 1, createdAt: T0 },
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:02:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-order' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'SOURCE_GAP');
    expect(problem.impact).toContain('not monotonic');
  });

  it('tool call/return break: params_json not valid JSON → REFERENCE_UNAVAILABLE', () => {
    const world = buildWorld('toolbreak', {
      sessions: [
        {
          sessionId: 'sess-tool',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{not json', resultPreview: 'ok' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-tool' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('REFERENCE_UNAVAILABLE');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('TOOL_RESULT_PREVIEW_ONLY: 500-char form recorded; replay NOT blocked; labeling blocked only when the expectation depends on tool output', () => {
    const truncated = `${'x'.repeat(497)}...`; // exactly the RESULT_PREVIEW_MAX_LENGTH truncation form
    const world = buildWorld('preview', {
      sessions: [
        {
          sessionId: 'sess-prev',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{}', resultPreview: truncated }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-prev' }],
    });
    const auth = writeJson(world.root, 'auth.json', healthyAuthorizations());

    // Without an expectation record: preview-only does NOT block replay.
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', auth]);
    expect(run.status).toBe(0);
    let out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('TOOL_RESULT_PREVIEW_ONLY');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED'); // EXPECTATION_UNRESOLVED present

    // Resolved expectation NOT depending on tool output: labeling READY.
    const out2Dir = path.join(world.root, 'out-b');
    const exp2 = writeJson(world.root, 'exp2.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: false },
    });
    const run2 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', out2Dir, '--expectations', exp2, '--authorizations', auth]);
    expect(run2.status).toBe(0);
    out = readOut(out2Dir);
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('READY');

    // Expectation depends on tool output: preview-only blocks the labeling path.
    const out3Dir = path.join(world.root, 'out-c');
    const exp3 = writeJson(world.root, 'exp3.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
    });
    const run3 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', out3Dir, '--expectations', exp3, '--authorizations', auth]);
    expect(run3.status).toBe(0);
    out = readOut(out3Dir);
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('DT-03: blob missing from snapshot → TURN_BLOB_MISSING; blob hash mismatch → DIGEST_MISMATCH', () => {
    const blobName = `assistant-${'a'.repeat(64)}.txt`;
    const blobName2 = `assistant-${'b'.repeat(64)}.txt`;
    const world = buildWorld('blobs', {
      sessions: [
        {
          sessionId: 'sess-blob',
          startedAt: T0,
          userTurns: [{ turnIndex: 0, blobRef: blobName }],
          assistantTurns: [{ createdAt: T0, blobRef: blobName2 }],
        },
        {
          // a complete inline session so SOURCE_GAP is not the story here
          sessionId: 'sess-blob-full',
          startedAt: T0,
          userTurns: [{ turnIndex: 0, blobRef: blobName }],
          assistantTurns: [{ createdAt: T0, blobRef: blobName2 }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-blob-full' }],
      corruptManifestEntry: (entry: { ref: string; sha256: string }) => {
        if (entry.ref === blobName2) {
          entry.sha256 = 'f'.repeat(64); // wrong digest for the existing file
        }
      },
      dropBlob: blobName, // manifest lists it, file removed → TURN_BLOB_MISSING
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).toContain('TURN_BLOB_MISSING');
    expect(codes).toContain('DIGEST_MISMATCH');
    expect(codes).not.toContain('SOURCE_GAP'); // inline text absent but rows exist on both sides
  });

  it('PAIN_ANCHOR_MISSING: empty session_id on the pain event; case still gets a complete single-case group', () => {
    const world = buildWorld('anchor', {
      sessions: [{ sessionId: 'sess-x', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: '' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('PAIN_ANCHOR_MISSING');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    expect(out.groups.groups.S01).toMatch(/^sg-/);
    expect(out.groups.rationales[out.groups.groups.S01]).toContain('no session anchor');
  });

  it('EXPECTATION_UNRESOLVED: missing record and unresolved record both block labeling', () => {
    const world = buildHealthyWorld('expmiss');
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    let out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('EXPECTATION_UNRESOLVED');
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('READY');

    const unresolvedDir = path.join(world.root, 'out-b');
    const expFile = writeJson(world.root, 'exp.json', { S01: { basis: 'EXPLICIT_AT_TIME', resolved: false } });
    const run2 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', unresolvedDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run2.status).toBe(0);
    out = readOut(unresolvedDir);
    expect(codesOf(out, 'S01')).toContain('EXPECTATION_UNRESOLVED');
  });

  it('DT-06: withdrawn / expired / structure-only authorizations → AUTHORIZATION_UNVERIFIED, paths blocked, queue marks Owner decision', () => {
    const world = buildHealthyWorld('authz');
    const cases = [
      ['withdrawn', { status: 'withdrawn', scope: 'full_fidelity' }],
      ['expired', { status: 'expired', scope: 'full_fidelity' }],
      ['structure', { status: 'granted', scope: 'structure_only' }],
    ] as const;
    for (const [name, record] of cases) {
      const outDir = path.join(world.root, `out-${name}`);
      const authFile = writeJson(world.root, `auth-${name}.json`, { S01: record });
      const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', outDir, '--authorizations', authFile]);
      expect(run.status).toBe(0);
      const out = readOut(outDir);
      expect(codesOf(out, 'S01')).toContain('AUTHORIZATION_UNVERIFIED');
      expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
      const queueEntry = out.queue.entries.find((e: { caseId: string; problemCode: string }) => e.caseId === 'S01' && e.problemCode === 'AUTHORIZATION_UNVERIFIED');
      expect(queueEntry).toBeDefined();
      expect(queueEntry.requiresOwnerDecision).toBe(true);
    }
    // Withdrawal is tracked as its own authorization status, never flattened.
    const withdrawnOut = readOut(path.join(world.root, 'out-withdrawn'));
    expect(withdrawnOut.report.perSample[0].authorizationStatus).toBe('withdrawn');
  });

  it('FUTURE_INFORMATION: expectation visible only after the pain trigger', () => {
    const world = buildHealthyWorld('future');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'LATER_CLARIFICATION', resolved: true, visibleAt: '2026-09-02T00:00:00.000Z' },
    });
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('FUTURE_INFORMATION');
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(out.report.perSample[0].completeness).toBe('INCOMPLETE');
  });

  it('DT-05: research-inference expectation is reported as RESEARCH_INFERENCE, never as user-explicit', () => {
    const world = buildHealthyWorld('basis');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'RESEARCH_INFERENCE', resolved: true, visibleAt: T0 },
    });
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.report.perSample[0].expectationBasis).toBe('RESEARCH_INFERENCE');
    expect(out.report.perSample[0].expectationBasis).not.toBe('EXPLICIT_AT_TIME');
  });

  it('ENVIRONMENT_UNAVAILABLE: emitted for every sample; BEHAVIOR_BRANCH blocked without degrading completeness', () => {
    const world = buildHealthyWorld('env');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
    expect(out.report.perSample[0].pathReadiness.BEHAVIOR_BRANCH).toBe('BLOCKED');
    expect(out.report.perSample[0].completeness).toBe('COMPLETE_FOR_ANALYSIS');
  });

  it('structured evidenceRefs that do not resolve → REFERENCE_UNAVAILABLE (3 kinds); non-structural refs are not guessed', () => {
    const world = buildHealthyWorld('evref');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    dataset.samples[0].evidenceRefs = ['session:sess-healthy', 'session:sess-never-existed', 'blob:assistant-doesnotexist.txt', 'pain:99999', 'owner_reported:cli'];
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const refProblems = out.report.perSample[0].problems.filter((p: { code: string }) => p.code === 'REFERENCE_UNAVAILABLE');
    expect(refProblems.length).toBe(3); // missing session, missing blob, missing pain row
    expect(refProblems.every((p: { fieldOrRef: string }) => p.fieldOrRef === 'evidenceRefs:S01')).toBe(true);
  });

  it('redacted public copy → all paths NOT_EVALUATED, structural audit still runs', () => {
    const world = buildHealthyWorld('redacted');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    dataset.samples[0].painEvent.reason = '«redacted sha256:ac8a071a3f5ff649 len:28»';
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.report.dataset.redactedPublicCopy).toBe(true);
    const sample = out.report.perSample[0];
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('NOT_EVALUATED');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('NOT_EVALUATED');
    expect(sample.pathReadiness.BEHAVIOR_BRANCH).toBe('NOT_EVALUATED');
    expect(sample.notEvaluatedReason).toContain('redacted');
    expect(codesOf(out, 'S01')).toContain('EXPECTATION_UNRESOLVED'); // structural findings still surface
  });

  it('unsupported host kind → all paths NOT_EVALUATED (first version covers OpenClaw only)', () => {
    const world = buildWorld('host', {
      sessions: [{ sessionId: 'sess-h', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-h', hostKind: 'codex' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('NOT_EVALUATED');
    expect(sample.notEvaluatedReason).toContain('unsupported_host_kind');
  });
});

// ---------------------------------------------------------------------------
// Retention discrimination (CONTRACT §2.4 rule, DT-07)
// ---------------------------------------------------------------------------

describe('retention discrimination (DT-07)', () => {
  it('healthy session: no SOURCE_* problem at all', () => {
    const world = buildHealthyWorld('ret-ok');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).not.toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('DT-07: first row later than pain, session created WITH the first row → SOURCE_GAP, never SOURCE_RETENTION_EXPIRED', () => {
    const lateStart = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('ret-gap', {
      sessions: [
        {
          sessionId: 'sess-late',
          startedAt: lateStart, // consistent with the first row — no evidence of earlier rows
          userTurns: [{ turnIndex: 0, createdAt: lateStart }],
          assistantTurns: [{ createdAt: lateStart }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-late', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const codes = codesOf(out, 'S01');
    expect(codes).toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'SOURCE_GAP');
    expect(problem.impact).toContain('Both readings are possible');
  });

  it('positive retention evidence (session created strictly before earliest surviving turn) → SOURCE_RETENTION_EXPIRED', () => {
    const lateStart = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('ret-expired', {
      sessions: [
        {
          sessionId: 'sess-expired',
          startedAt: T0, // session created at 10:00, first surviving row at 10:06
          userTurns: [{ turnIndex: 0, createdAt: lateStart }],
          assistantTurns: [{ createdAt: lateStart }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-expired', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const codes = codesOf(out, 'S01');
    expect(codes).toContain('SOURCE_RETENTION_EXPIRED');
    expect(codes).not.toContain('SOURCE_GAP');
  });

  it('PRODUCTION numbering: contiguous turn_index starting at 2 (OpenClaw nextUserTurnIndex semantics) is NORMAL — no gap, no retention claim', () => {
    // openclaw-plugin/src/hooks/prompt.ts numbers the first recorded user
    // turn as host-user-message-count + 1 → real sessions start at >= 2.
    // The CONTRACT §2.4 turn_index example assumes 0-based numbering and is
    // not mechanizable for this producer; the probe must not treat a
    // non-zero start as a gap or as retention evidence. The pain trigger is
    // set AFTER the turns so the "earliest turn after the pain" gap reason
    // cannot fire — this isolates the numbering assertion.
    const lateStart = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('ret-index-prod', {
      sessions: [
        {
          sessionId: 'sess-idx',
          startedAt: lateStart,
          userTurns: [{ turnIndex: 2, createdAt: lateStart }, { turnIndex: 3, createdAt: lateStart }],
          assistantTurns: [{ createdAt: lateStart }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-idx', createdAt: '2026-09-01T10:07:00.000Z' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).not.toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('retention-expired rows are NOT remediable (deleted rows are unrecoverable from this snapshot)', () => {
    const lateStart = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('ret-queue', {
      sessions: [
        { sessionId: 'sess-q', startedAt: T0, userTurns: [{ turnIndex: 0, createdAt: lateStart }], assistantTurns: [{ createdAt: lateStart }] },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-q', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const entry = out.queue.entries.find((e: { problemCode: string }) => e.problemCode === 'SOURCE_RETENTION_EXPIRED');
    expect(entry).toBeDefined();
    expect(entry.remediable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source groups (CONTRACT §3)
// ---------------------------------------------------------------------------

describe('source groups', () => {
  it('same session always one group; different sessions not merged by default (DT-04 leakage guard)', () => {
    const world = buildWorld('sg-basic', {
      sessions: [
        { sessionId: 'sess-1', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
        { sessionId: 'sess-2', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
      ],
      samples: [
        { caseId: 'S01', sessionId: 'sess-1' },
        { caseId: 'S08', sessionId: 'sess-1' },
        { caseId: 'S02', sessionId: 'sess-2' },
      ],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.groups.groups.S01).toBe(out.groups.groups.S08);
    expect(out.groups.groups.S02).not.toBe(out.groups.groups.S01);
    expect(out.report.sourceGroups.groupCount).toBe(2);
    expect(out.report.counts).toMatchObject({ painCount: 3, caseCount: 3, sessionCount: 2 });
    for (const groupId of new Set(Object.values(out.groups.groups))) {
      expect(out.groups.rationales[groupId]).toBeTruthy();
    }
  });

  it('DT-04: ten same-source variants collapse into ONE group (no source leakage across groups)', () => {
    const sessions = [{ sessionId: 'sess-mono', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }];
    const samples = Array.from({ length: 10 }, (_, i) => ({ caseId: `V${String(i).padStart(2, '0')}`, sessionId: 'sess-mono' }));
    const world = buildWorld('sg-ten', { sessions, samples });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(new Set(Object.values(out.groups.groups)).size).toBe(1);
  });

  it('16-sample reality: S01/S08 share a session and S02/S04 share a session → exactly 14 groups, never 16', () => {
    const sessionIds = Array.from({ length: 14 }, (_, i) => `sess-${String(i).padStart(2, '0')}`);
    const sessions = sessionIds.map((sessionId) => ({
      sessionId,
      startedAt: T0,
      userTurns: [{ turnIndex: 0 }],
      assistantTurns: [{ createdAt: T0 }],
    }));
    // 14 base cases S01..S14 mapped onto 14 distinct sessions, then fold
    // S08 onto S01's session and S04 onto S02's session: 16 pains, 14 sessions.
    const samples = sessionIds.map((sessionId, i) => ({
      caseId: `S${String(i + 1).padStart(2, '0')}`,
      sessionId,
    }));
    const sixteen = [...samples];
    sixteen.push({ caseId: 'S15', sessionId: sessionIds[0] });
    sixteen.push({ caseId: 'S16', sessionId: sessionIds[1] });
    const world = buildWorld('sg-16', { sessions, samples: sixteen });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(sixteen.length).toBe(16);
    expect(new Set(Object.values(out.groups.groups)).size).toBe(14);
    expect(Object.keys(out.groups.groups).length).toBe(16);
    expect(out.report.counts).toMatchObject({ painCount: 16, sessionCount: 14 });
    expect(out.report.sourceGroups.independentSourceGroupCount).toBe(14);
  });

  it('cross-session merge WITH auditable basis is applied and recorded', () => {
    const world = buildWorld('sg-merge', {
      sessions: [
        { sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
        { sessionId: 'sess-b', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
      ],
      samples: [
        { caseId: 'S01', sessionId: 'sess-a' },
        { caseId: 'S02', sessionId: 'sess-b' },
      ],
    });
    const reviewFile = writeJson(world.root, 'review.json', {
      merges: [{ sessionIds: ['sess-a', 'sess-b'], basis: 'same incident re-reported across two sessions, Owner reviewed 2026-11-20', approvedBy: 'Owner' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--cross-session-review', reviewFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.groups.groups.S01).toBe(out.groups.groups.S02);
    expect(out.groups.crossSessionMerges.length).toBe(1);
    expect(Object.values(out.groups.rationales)[0]).toContain('cross-session merge approved by Owner');
  });

  it('cross-session merge WITHOUT basis → INVALID_PLAN (exit 3), never silently merged', () => {
    const world = buildWorld('sg-nobasis', {
      sessions: [
        { sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
        { sessionId: 'sess-b', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
      ],
      samples: [
        { caseId: 'S01', sessionId: 'sess-a' },
        { caseId: 'S02', sessionId: 'sess-b' },
      ],
    });
    const groupsFile = writeJson(world.root, 'forged-groups.json', {
      schema: 'pd-lab-source-groups.v1',
      groups: { S01: 'sg-manual', S02: 'sg-manual' }, // merged with NO merge basis
      rationales: { 'sg-manual': 'manually merged, no basis recorded' },
      sessionIndex: { S01: 'sess-a', S02: 'sess-b' },
      crossSessionMerges: [],
      digest: 'sha256:whatever',
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--verify-source-groups', groupsFile]);
    expect(run.status).toBe(3);
    const out = readOut(world.outDir, true);
    const codes = out.report.invalidPlan.map((r: { code: string }) => r.code);
    expect(codes).toContain('CROSS_SESSION_MERGE_WITHOUT_BASIS');
    expect(codes).toContain('SOURCE_GROUPS_DIGEST_MISMATCH');
  });

  it('missing case mapping → INVALID_PLAN (exit 3), no one-case-one-group default (SC-19)', () => {
    const world = buildWorld('sg-miss', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [
        { caseId: 'S01', sessionId: 'sess-a' },
        { caseId: 'S02', sessionId: 'sess-a' },
      ],
    });
    const honestRun = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(honestRun.status).toBe(0);
    const honest = JSON.parse(fs.readFileSync(path.join(world.outDir, 'source-groups.json'), 'utf8'));
    delete honest.groups.S02; // incomplete mapping

    const groupsFile = writeJson(world.root, 'holey-groups.json', honest);
    const verifyDir = path.join(world.root, 'verify-out');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', verifyDir, '--verify-source-groups', groupsFile]);
    expect(run.status).toBe(3);
    const codes = readOut(verifyDir, true).report.invalidPlan.map((r: { code: string }) => r.code);
    expect(codes).toContain('CASE_UNMAPPED');
    expect(codes).toContain('SOURCE_GROUPS_DIGEST_MISMATCH'); // digest was computed with S02 present
  });

  it('same session split across groups → INVALID_PLAN (session-split guard)', () => {
    const world = buildWorld('sg-split', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [
        { caseId: 'S01', sessionId: 'sess-a' },
        { caseId: 'S02', sessionId: 'sess-a' },
      ],
    });
    const groupsFile = writeJson(world.root, 'split-groups.json', {
      schema: 'pd-lab-source-groups.v1',
      groups: { S01: 'sg-one', S02: 'sg-two' }, // same session, two groups
      rationales: { 'sg-one': 'mechanical', 'sg-two': 'mechanical' },
      sessionIndex: { S01: 'sess-a', S02: 'sess-a' },
      crossSessionMerges: [],
      digest: 'sha256:x',
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--verify-source-groups', groupsFile]);
    expect(run.status).toBe(3);
    const codes = readOut(world.outDir, true).report.invalidPlan.map((r: { code: string }) => r.code);
    expect(codes).toContain('SESSION_SPLIT_ACROSS_GROUPS');
  });

  it('group reference invalid (rationale missing) → INVALID_PLAN; verify of the probe’s own file passes', () => {
    const world = buildWorld('sg-reverify', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-a' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);

    const generated = path.join(world.outDir, 'source-groups.json');
    const noRationale = JSON.parse(fs.readFileSync(generated, 'utf8'));
    noRationale.rationales = {}; // every group loses its rationale
    const badFile = writeJson(world.root, 'norationale-groups.json', noRationale);
    const badDir = path.join(world.root, 'verify-bad');
    const badRun = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', badDir, '--verify-source-groups', badFile]);
    expect(badRun.status).toBe(3);
    const badCodes = readOut(badDir, true).report.invalidPlan.map((r: { code: string }) => r.code);
    expect(badCodes).toContain('GROUP_WITHOUT_RATIONALE');
    expect(badCodes).toContain('SOURCE_GROUPS_DIGEST_MISMATCH');

    // The probe's own generated file re-verifies cleanly (digest stable).
    const verifyDir = path.join(world.root, 'verify-out');
    const verify = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', verifyDir, '--verify-source-groups', generated]);
    expect(verify.status).toBe(0);
    expect(readOut(verifyDir, true).report.invalidPlan).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path-classification independence & counts
// ---------------------------------------------------------------------------

describe('path classification and counts', () => {
  it('PIPELINE_REPLAY READY does not make EXPECTATION_LABELING READY (missing expectation)', () => {
    const world = buildHealthyWorld('indep');
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.executableForDeclaredPath.PIPELINE_REPLAY).toBe(true);
    expect(sample.executableForDeclaredPath.EXPECTATION_LABELING).toBe(false);
  });

  it('per-path counts are reported separately (READY/BLOCKED/NOT_EVALUATED)', () => {
    const world = buildWorld('counts', {
      sessions: [
        { sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
        { sessionId: 'sess-missing', startedAt: T0, omitSessionRow: true },
      ],
      samples: [
        { caseId: 'S01', sessionId: 'sess-a' },
        { caseId: 'S02', sessionId: 'sess-missing' },
        { caseId: 'S03', sessionId: 'sess-a', hostKind: 'codex' },
      ],
    });
    const authFile = writeJson(world.root, 'auth.json', {
      S01: fullGrant('S01'),
      S02: fullGrant('S02'),
      S03: fullGrant('S03'),
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const counts = out.report.counts as { paths: Record<string, Record<string, number>> };
    expect(counts.paths.PIPELINE_REPLAY).toEqual({ total: 3, READY: 1, BLOCKED: 1, NOT_EVALUATED: 1 });
    expect(counts.paths.BEHAVIOR_BRANCH).toEqual({ total: 3, READY: 0, BLOCKED: 2, NOT_EVALUATED: 1 });
    expect(counts.problemCodes).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Safety & CLI contract
// ---------------------------------------------------------------------------

describe('safety and CLI contract', () => {
  it('read-only discipline: every source file’s hash and mtime unchanged after the run', () => {
    const world = buildHealthyWorld('readonly');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const before = fingerprintTree(world.root);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const after = fingerprintTree(world.root);
    // The probe wrote only inside outDir; every pre-existing file is unchanged
    // (exp.json/auth.json are included: the probe must not touch its inputs).
    for (const [rel, meta] of before) {
      expect(after.get(rel), `source file ${rel} must be unchanged`).toEqual(meta);
    }
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(true);
  });

  it('report contains no message bodies (markers planted in the DB never appear)', () => {
    const truncated = `${'y'.repeat(497)}...`;
    const world = buildWorld('noleak', {
      sessions: [
        {
          sessionId: 'sess-leak',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{"private":"PARAMS-CONFIDENTIAL-MARKER"}', resultPreview: truncated }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-leak' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const reportText = fs.readFileSync(path.join(world.outDir, 'admission-report.json'), 'utf8');
    for (const marker of world.bodyMarkers) {
      expect(reportText.includes(marker)).toBe(false);
    }
    expect(reportText.includes('PARAMS-CONFIDENTIAL-MARKER')).toBe(false);
    expect(reportText.includes(truncated)).toBe(false);
  });

  it('no network/model surface: the script imports no http(s)/net and references no provider endpoints', () => {
    // Negative capability control over the CLI's own source (allowed use of
    // string checks per TECH §9 — capability absence, not behavior proof).
    expect(SCRIPT_SOURCE).not.toMatch(/import[^;]*['"]node:(http|https|net|tls)['"]/);
    expect(SCRIPT_SOURCE).not.toContain('open.bigmodel.cn');
    expect(SCRIPT_SOURCE).not.toContain('ZAI_API_KEY');
    expect(SCRIPT_SOURCE).not.toMatch(/\bfetch\s*\(/);
  });

  it('usage: missing required options exit 2 with usage text', () => {
    const world = buildHealthyWorld('usage');
    const run = runProbe([]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('missing required option');
    expect(run.stderr).toContain('--dataset');
    const run2 = runProbe(['--dataset', world.datasetPath]);
    expect(run2.status).toBe(2);
    expect(run2.stderr).toContain('--snapshot');
  });

  it('unreadable trajectory.db fails loudly (exit 1) — never a zero-problem success', () => {
    const world = buildHealthyWorld('unreadable');
    fs.rmSync(path.join(world.snapshotDir, 'trajectory.db'));
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('snapshot_trajectory_missing');
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(false);
  });

  it('trajectory.db missing core tables fails loudly (exit 1), not zero problems', () => {
    const world = buildHealthyWorld('badtable');
    const snapshotDir = path.join(world.root, 'badtable-snapshot');
    fs.mkdirSync(path.join(snapshotDir, 'blobs'), { recursive: true });
    // An unrelated sqlite DB with none of the trajectory tables.
    const db = new Database(path.join(snapshotDir, 'trajectory.db'));
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    db.pragma('journal_mode = DELETE');
    db.close();
    fs.writeFileSync(
      path.join(snapshotDir, 'blob-manifest.json'),
      JSON.stringify({ schema: 'pd-lab-blob-manifest.v1', ok: true, consistencyStatus: 'CONSISTENT_WITHIN_WINDOW', files: [], counts: { referencedDistinct: 0, referencedRows: 0, copied: 0, orphansNotCopied: 0 } }),
      'utf8',
    );
    const datasetPath = path.join(world.root, 'badtable-dataset.json');
    fs.writeFileSync(datasetPath, JSON.stringify({ samples: [{ experimentPainId: 'S01', painEvent: { id: 1, session_id: 's', created_at: PAIN_AT } }] }), 'utf8');
    const run = runProbe(['--dataset', datasetPath, '--snapshot', snapshotDir, '--out', path.join(world.root, 'badtable-out')]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('trajectory_schema_unexpected');
  });

  it('write-once: an existing --out dir is refused (exit 1)', () => {
    const world = buildHealthyWorld('writeonce');
    fs.mkdirSync(world.outDir, { recursive: true });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('out_already_exists');
  });

  it('invalid expectations/authorizations files fail structurally (exit 1)', () => {
    const world = buildHealthyWorld('badinputs');
    const badExp = writeJson(world.root, 'bad-exp.json', { S01: { basis: 'NOT_A_BASIS' } });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', badExp]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('expectations_invalid_structure');

    const out2 = path.join(world.root, 'out2');
    const badAuth = writeJson(world.root, 'bad-auth.json', { S01: { status: 'maybe' } });
    const run2 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', out2, '--authorizations', badAuth]);
    expect(run2.status).toBe(1);
    expect(stderrReason(run2).reason).toBe('authorizations_invalid_structure');
  });

  it('stdout summary is one JSON line; probe version digest recorded; real-data status NOT_RUN_WITHOUT_D6', () => {
    const world = buildHealthyWorld('stdout');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    const summary = JSON.parse(lines[0]);
    expect(summary.ok).toBe(true);
    expect(summary.sampleCount).toBe(1);
    expect(summary.sourceGroupCount).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(world.outDir, 'admission-report.json'), 'utf8'));
    expect(report.probe.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.realDataProbe.status).toBe('NOT_RUN_WITHOUT_D6');
  });
});

// ---------------------------------------------------------------------------
// Review-hardening negatives (CodeRabbit r1 on PR#2733 — all valid, fixed)
// ---------------------------------------------------------------------------

describe('review hardening (PR#2733 r1)', () => {
  it('turn_index hole without retention evidence → SOURCE_GAP (TECH §5.2 row 7 has its own case)', () => {
    const world = buildWorld('hole', {
      sessions: [
        {
          sessionId: 'sess-hole',
          startedAt: T0,
          userTurns: [
            { turnIndex: 0, createdAt: T0 },
            { turnIndex: 2, createdAt: T0 }, // hole at 1; started_at == first row → no evidence
          ],
          assistantTurns: [{ createdAt: T0 }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-hole' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const codes = codesOf(out, 'S01');
    expect(codes).toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'SOURCE_GAP');
    expect(problem.impact).toContain('not contiguous');
  });

  it('npm run lab:probe alias works end to end (package.json wiring, cli-7)', () => {
    const world = buildHealthyWorld('alias');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runNpmLabProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(true);
    const summaryLine = (run.stdout ?? '').trim().split('\n').filter((l: string) => l.startsWith('{')).pop();
    expect(summaryLine).toBeDefined();
    expect(JSON.parse(summaryLine!).ok).toBe(true);
  });

  it('read-only discipline: no NEW files outside --out either (after-set minus outDir equals before-set)', () => {
    const world = buildHealthyWorld('nofiles');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const before = fingerprintTree(world.root);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const after = fingerprintTree(world.root);
    const outPrefix = 'probe-out/';
    const newOutsideOut = [...after.keys()].filter((rel) => !rel.startsWith(outPrefix) && !before.has(rel));
    expect(newOutsideOut).toEqual([]); // no WAL sidecars, no scratch files anywhere else
    const removed = [...before.keys()].filter((rel) => !after.has(rel));
    expect(removed).toEqual([]);
  });

  it('existing-but-unreadable trajectory.db → trajectory_db_unavailable (distinct from missing)', () => {
    const world = buildHealthyWorld('corrupt');
    fs.writeFileSync(path.join(world.snapshotDir, 'trajectory.db'), 'this is definitely not a sqlite database', 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('trajectory_db_unavailable');
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(false);
  });

  it('authorization without an explicit scope is rejected structurally (never defaults to full fidelity)', () => {
    const world = buildHealthyWorld('noscope');
    const authFile = writeJson(world.root, 'auth.json', { S01: { status: 'granted' } });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', authFile]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('authorizations_invalid_structure');
  });

  it('LATER_CLARIFICATION without visibleAt cannot prove contemporaneous visibility → FUTURE_INFORMATION', () => {
    const world = buildHealthyWorld('novisible');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'LATER_CLARIFICATION', resolved: true },
    });
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('FUTURE_INFORMATION');
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
  });

  it('timezone-offset visibleAt is compared by instant, not string order', () => {
    const world = buildHealthyWorld('tz');
    // 2026-09-01T09:10:00-01:00 == 10:10Z — five minutes AFTER the 10:05Z
    // trigger; a string comparison would call it "earlier".
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: '2026-09-01T09:10:00-01:00' },
    });
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    expect(codesOf(readOut(world.outDir), 'S01')).toContain('FUTURE_INFORMATION');
  });

  it('blob-manifest duplicate ref is rejected (Map.has, not hasOwn)', () => {
    const blobName = `assistant-${'e'.repeat(64)}.txt`;
    const world = buildWorld('dupref', {
      sessions: [{ sessionId: 'sess-d', startedAt: T0, userTurns: [{ turnIndex: 0, blobRef: blobName }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-d' }],
    });
    const manifestPath = path.join(world.snapshotDir, 'blob-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push({ ...manifest.files[0] }); // duplicate entry, second copy wins on the old bug
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('blob_manifest_invalid_structure');
  });

  it('blob ref with path separators in the manifest is rejected (no traversal into blobs/)', () => {
    const world = buildHealthyWorld('travref');
    const manifestPath = path.join(world.snapshotDir, 'blob-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push({ path: 'blobs/../../escape.txt', ref: '../../escape.txt', bytes: 1, sha256: '0'.repeat(64), referenceCount: 0, referencedBy: [] });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('blob_manifest_invalid_structure');
  });

  it('overlapping cross-session merge sets are rejected (ambiguous group instructions)', () => {
    const world = buildWorld('overlap', {
      sessions: ['sess-a', 'sess-b', 'sess-c'].map((sessionId) => ({
        sessionId,
        startedAt: T0,
        userTurns: [{ turnIndex: 0 }],
        assistantTurns: [{ createdAt: T0 }],
      })),
      samples: [
        { caseId: 'S01', sessionId: 'sess-a' },
        { caseId: 'S02', sessionId: 'sess-b' },
        { caseId: 'S03', sessionId: 'sess-c' },
      ],
    });
    const reviewFile = writeJson(world.root, 'review.json', {
      merges: [
        { sessionIds: ['sess-a', 'sess-b'], basis: 'first merge', approvedBy: 'Owner' },
        { sessionIds: ['sess-b', 'sess-c'], basis: 'second merge claims sess-b again', approvedBy: 'Owner' },
      ],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--cross-session-review', reviewFile]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('cross_session_review_invalid_structure');
  });

  it('verify rejects a source-groups file bound to a different dataset (datasetSha256 mismatch)', () => {
    const world = buildWorld('dsbind', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-a' }],
    });
    const honestRun = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(honestRun.status).toBe(0);
    const generated = JSON.parse(fs.readFileSync(path.join(world.outDir, 'source-groups.json'), 'utf8'));
    generated.datasetSha256 = 'f'.repeat(64); // claims a different frozen dataset
    generated.digest = 'sha256:x'; // would also mismatch, but the dataset binding must be its own reason
    const groupsFile = writeJson(world.root, 'rebound-groups.json', generated);
    const verifyDir = path.join(world.root, 'verify-out');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', verifyDir, '--verify-source-groups', groupsFile]);
    expect(run.status).toBe(3);
    const codes = readOut(verifyDir, true).report.invalidPlan.map((r: { code: string }) => r.code);
    expect(codes).toContain('DATASET_SHA256_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// r2 final remediation — P1-1 pain anchor truth, P1-2 authorization
// completeness, P1-3 blob path safety, P2-1 datasetSha256 binding, P2-2
// evidenceRefs element validity, P2-3 blob evidence digest.
// ---------------------------------------------------------------------------

describe('P1-1 pain anchor truth (real CLI subprocess)', () => {
  it('pain id with no row in pain_events → PAIN_ANCHOR_MISSING (db record missing)', () => {
    const world = buildWorld('p1a-missing', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-a', pain: { omitRow: true } }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('PAIN_ANCHOR_MISSING');
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'PAIN_ANCHOR_MISSING');
    expect(problem.impact).toContain('no such row');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('pain row bound to a DIFFERENT session than the frozen sample → PAIN_ANCHOR_MISSING (session mismatch)', () => {
    const world = buildWorld('p1a-session', {
      sessions: [{ sessionId: 'sess-real', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-claimed', pain: { sessionOverride: 'sess-real' }, noSessionRows: true }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'PAIN_ANCHOR_MISSING');
    expect(problem).toBeDefined();
    expect(problem.impact).toContain('disagree on WHERE');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('pain row created_at differing from the frozen trigger time → PAIN_ANCHOR_MISSING (instant mismatch)', () => {
    const world = buildWorld('p1a-time', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-a', pain: { timeOverride: '2026-09-01T11:30:00.000Z' } }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'PAIN_ANCHOR_MISSING');
    expect(problem.impact).toContain('instants differ');
    expect(problem.impact).toContain('compared as instants');
  });

  it('equivalent trigger instant in a different timezone offset → anchor PASSES (instant equality, not string order)', () => {
    const world = buildWorld('p1a-tz', {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      // 2026-09-01T12:05:00+02:00 == 10:05:00Z — the same instant as PAIN_AT.
      samples: [{ caseId: 'S01', sessionId: 'sess-a', pain: { timeOverride: '2026-09-01T12:05:00+02:00' }, createdAt: PAIN_AT }],
    });
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    expect(codesOf(readOut(world.outDir), 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
  });

  it('malformed pain id (non-integer) → structural rejection before any DB work', () => {
    const world = buildHealthyWorld('p1a-badid');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    dataset.samples[0].painEvent.id = 'not-a-number';
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('dataset_invalid_structure');
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(false);
  });

  it('missing pain id entirely → structural rejection (no honest anchor check without it)', () => {
    const world = buildHealthyWorld('p1a-noid');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    delete dataset.samples[0].painEvent.id;
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('dataset_invalid_structure');
  });
});

describe('P1-2 authorization completeness (real CLI subprocess)', () => {
  const base = { status: 'granted', scope: 'full_fidelity' };

  function authCase(label: string, record: Record<string, unknown>) {
    const world = buildHealthyWorld(label);
    const authFile = writeJson(world.root, 'auth.json', { S01: record });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    return { world, authFile, expFile };
  }

  it('missing purpose → AUTHORIZATION_UNVERIFIED, paths blocked, completeness INCOMPLETE', () => {
    const { world, authFile, expFile } = authCase('p12-purpose', { ...base, effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'AUTHORIZATION_UNVERIFIED');
    expect(problem.fieldOrRef).toContain('purpose');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    expect(out.report.perSample[0].completeness).toBe('INCOMPLETE');
  });

  it('missing effectiveAt → AUTHORIZATION_UNVERIFIED (activation cannot be proven)', () => {
    const { world, authFile, expFile } = authCase('p12-effective', { ...base, purpose: 'pd-lab-admission-probe', expiresAt: '2099-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.report.perSample[0].problems.some((p: { code: string; fieldOrRef: string }) => p.code === 'AUTHORIZATION_UNVERIFIED' && p.fieldOrRef.includes('effectiveAt'))).toBe(true);
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('missing expiresAt → AUTHORIZATION_UNVERIFIED (open-ended grant is not verifiable)', () => {
    const { world, authFile, expFile } = authCase('p12-expires', { ...base, purpose: 'pd-lab-admission-probe', effectiveAt: '2020-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.report.perSample[0].problems.some((p: { code: string; fieldOrRef: string }) => p.code === 'AUTHORIZATION_UNVERIFIED' && p.fieldOrRef.includes('expiresAt'))).toBe(true);
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('not yet effective → AUTHORIZATION_UNVERIFIED (evaluation instant before effectiveAt)', () => {
    const { world, authFile, expFile } = authCase('p12-notyet', { ...base, purpose: 'pd-lab-admission-probe', effectiveAt: '2030-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'AUTHORIZATION_UNVERIFIED');
    expect(problem.impact).toContain('NOT YET EFFECTIVE');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('expired window → AUTHORIZATION_UNVERIFIED with status expired', () => {
    const { world, authFile, expFile } = authCase('p12-expired', { ...base, purpose: 'pd-lab-admission-probe', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2021-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'AUTHORIZATION_UNVERIFIED');
    expect(problem.impact).toContain('EXPIRED');
    expect(out.report.perSample[0].authorizationStatus).toBe('unverified');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('withdrawn grant fails regardless of every other field (short-circuit)', () => {
    const { world, authFile, expFile } = authCase('p12-withdrawn', { status: 'withdrawn', scope: 'full_fidelity', purpose: 'pd-lab-admission-probe', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('AUTHORIZATION_UNVERIFIED');
    expect(out.report.perSample[0].authorizationStatus).toBe('withdrawn');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    // Withdrawal problem is the ONLY authorization problem (no window noise).
    const authProblems = out.report.perSample[0].problems.filter((p: { code: string }) => p.code === 'AUTHORIZATION_UNVERIFIED');
    expect(authProblems.length).toBe(1);
  });

  it('purpose mismatch → AUTHORIZATION_UNVERIFIED (grant does not cover this study)', () => {
    const { world, authFile, expFile } = authCase('p12-mismatch', { ...base, purpose: 'some-other-study', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'AUTHORIZATION_UNVERIFIED');
    expect(problem.impact).toContain('does not match');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('scope mismatch (structure_only) → AUTHORIZATION_UNVERIFIED; matching --study-purpose accepts a differently-purposed run', () => {
    const { world, authFile, expFile } = authCase('p12-scope', { ...base, purpose: 'pd-lab-admission-probe', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    // Override: structure-only scope.
    const scopeOnly = writeJson(world.root, 'auth-scope.json', {
      S01: { ...base, scope: 'structure_only', purpose: 'pd-lab-admission-probe', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    expect(codesOf(readOut(world.outDir), 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']); // full valid grant passes

    const run2 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', path.join(world.root, 'out2'), '--expectations', expFile, '--authorizations', scopeOnly]);
    expect(run2.status).toBe(0);
    const out2 = readOut(path.join(world.root, 'out2'));
    expect(codesOf(out2, 'S01')).toContain('AUTHORIZATION_UNVERIFIED');
    expect(out2.report.perSample[0].authorizationStatus).toBe('granted'); // granted, scope structure_only
    expect(out2.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });

  it('a differently-declared --study-purpose matches a grant issued for that purpose', () => {
    const world = buildHealthyWorld('p12-study');
    const authFile = writeJson(world.root, 'auth.json', {
      S01: { ...base, purpose: 't7a-real-data-probe', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile, '--study-purpose', 't7a-real-data-probe']);
    expect(run.status).toBe(0);
    expect(codesOf(readOut(world.outDir), 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
  });
});

describe('P1-3 blob path safety (real CLI subprocess, symlink discipline)', () => {
  const BLOB = `assistant-${'e'.repeat(64)}.txt`;

  function blobWorld(label: string) {
    return buildWorld(label, {
      sessions: [{ sessionId: 'sess-b', startedAt: T0, userTurns: [{ turnIndex: 0, blobRef: BLOB }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-b' }],
    });
  }

  it('regular blob file referenced by a turn → clean (no TURN_BLOB_MISSING / DIGEST_MISMATCH)', () => {
    const world = blobWorld('p13-clean');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).not.toContain('TURN_BLOB_MISSING');
    expect(codes).not.toContain('DIGEST_MISMATCH');
  });

  it('symlink pointing OUTSIDE the snapshot → refused without reading the external file', () => {
    const externalBody = 'EXTERNAL-SECRET-CONTENT-MUST-NOT-BE-READ';
    const world = blobWorld('p13-escape');
    // A junction is a symlink-class reparse point on Windows (creatable
    // without elevated privileges) and a plain symlink on POSIX. The SECURITY
    // invariant is outcome-based: the link is refused, nothing is read, the
    // target is untouched. The REASON LABEL is platform-honest: POSIX
    // (O_NOFOLLOW at open) classifies exactly as 'symlink'; Windows open
    // follows the junction before any check, so the refusal lands on the
    // directory/missing classification with the same blocking effect.
    const externalDir = path.join(world.root, 'outside-secret-dir');
    fs.mkdirSync(externalDir);
    const externalFile = path.join(externalDir, 'secret.txt');
    fs.writeFileSync(externalFile, externalBody, 'utf8');
    const before = { sha: sha256File(externalFile), mtime: fs.statSync(externalFile).mtimeMs };
    fs.rmSync(path.join(world.snapshotDir, 'blobs', BLOB));
    fs.symlinkSync(externalDir, path.join(world.snapshotDir, 'blobs', BLOB), 'junction');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'TURN_BLOB_MISSING');
    expect(problem).toBeDefined();
    expect(problem.impact).toMatch(/symbolic link|not a regular file/);
    expect(codesOf(out, 'S01')).not.toContain('DIGEST_MISMATCH'); // external content was never hashed
    expect(codesOf(out, 'S01')).not.toContain('REFERENCE_UNAVAILABLE');
    const reportText = fs.readFileSync(path.join(world.outDir, 'admission-report.json'), 'utf8');
    expect(reportText.includes(externalBody)).toBe(false); // external content not leaked either
    const after = { sha: sha256File(externalFile), mtime: fs.statSync(externalFile).mtimeMs };
    expect(after).toEqual(before); // external file untouched
  });

  it('symlink pointing to ANOTHER location INSIDE the snapshot → still refused (all links refused)', () => {
    const world = blobWorld('p13-inside');
    const insideDir = path.join(world.snapshotDir, 'other-blobs-dir');
    fs.mkdirSync(insideDir);
    const otherFile = path.join(insideDir, 'other-blob.bin');
    fs.writeFileSync(otherFile, 'inside-target-body', 'utf8');
    const before = { sha: sha256File(otherFile), mtime: fs.statSync(otherFile).mtimeMs };
    fs.rmSync(path.join(world.snapshotDir, 'blobs', BLOB));
    fs.symlinkSync(insideDir, path.join(world.snapshotDir, 'blobs', BLOB), 'junction');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'TURN_BLOB_MISSING');
    expect(problem.impact).toMatch(/symbolic link|not a regular file/);
    const after = { sha: sha256File(otherFile), mtime: fs.statSync(otherFile).mtimeMs };
    expect(after).toEqual(before); // link target untouched
  });

  it('dangling symlink (target does not exist) → refused as symlink, not silently "missing"', () => {
    const world = blobWorld('p13-dangling');
    fs.rmSync(path.join(world.snapshotDir, 'blobs', BLOB));
    fs.symlinkSync(path.join(world.root, 'never-existed-dir'), path.join(world.snapshotDir, 'blobs', BLOB), 'junction');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const problem = readOut(world.outDir).report.perSample[0].problems.find((p: { code: string }) => p.code === 'TURN_BLOB_MISSING');
    expect(problem).toBeDefined();
    expect(problem.impact).toMatch(/symbolic link|absent from the snapshot/);
  });

  it('blob path is a DIRECTORY → refused (not a regular file)', () => {
    const world = blobWorld('p13-dir');
    fs.rmSync(path.join(world.snapshotDir, 'blobs', BLOB));
    fs.mkdirSync(path.join(world.snapshotDir, 'blobs', BLOB));
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const problem = readOut(world.outDir).report.perSample[0].problems.find((p: { code: string }) => p.code === 'TURN_BLOB_MISSING');
    expect(problem.impact).toContain('not a regular file');
  });

  it('manifest ref carrying path separators → structural rejection before any path work', () => {
    const world = blobWorld('p13-traverse');
    const manifestPath = path.join(world.snapshotDir, 'blob-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push({ path: 'blobs/../../x.txt', ref: '../../x.txt', bytes: 1, sha256: '0'.repeat(64), referenceCount: 0, referencedBy: [] });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('blob_manifest_invalid_structure');
  });
});

describe('P2-1 source-groups datasetSha256 mandatory binding (real CLI subprocess)', () => {
  function worldWithGroups(label: string) {
    const world = buildWorld(label, {
      sessions: [{ sessionId: 'sess-a', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-a' }],
    });
    const honestRun = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(honestRun.status).toBe(0);
    const generated = JSON.parse(fs.readFileSync(path.join(world.outDir, 'source-groups.json'), 'utf8'));
    return { world, generated };
  }

  function verifyWith(world: { root: string; datasetPath: string; snapshotDir: string }, mutated: Record<string, unknown>) {
    const groupsFile = writeJson(world.root, 'mutated-groups.json', mutated);
    const verifyDir = path.join(world.root, 'verify-out');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', verifyDir, '--verify-source-groups', groupsFile]);
    return { run, codes: readOut(verifyDir, true).report.invalidPlan.map((r: { code: string }) => r.code) };
  }

  it('missing datasetSha256 → DATASET_SHA256_MISSING (exit 3)', () => {
    const { world, generated } = worldWithGroups('p21-missing');
    delete generated.datasetSha256;
    const { run, codes } = verifyWith(world, generated);
    expect(run.status).toBe(3);
    expect(codes).toContain('DATASET_SHA256_MISSING');
  });

  it('null datasetSha256 → DATASET_SHA256_MISSING (exit 3)', () => {
    const { world, generated } = worldWithGroups('p21-null');
    generated.datasetSha256 = null;
    const { run, codes } = verifyWith(world, generated);
    expect(run.status).toBe(3);
    expect(codes).toContain('DATASET_SHA256_MISSING');
  });

  it('empty string datasetSha256 → DATASET_SHA256_MISSING (exit 3)', () => {
    const { world, generated } = worldWithGroups('p21-empty');
    generated.datasetSha256 = '';
    const { run, codes } = verifyWith(world, generated);
    expect(run.status).toBe(3);
    expect(codes).toContain('DATASET_SHA256_MISSING');
  });

  it('malformed digest (not 64-hex) → DATASET_SHA256_FORMAT (exit 3)', () => {
    const { world, generated } = worldWithGroups('p21-format');
    generated.datasetSha256 = 'deadbeef';
    const { run, codes } = verifyWith(world, generated);
    expect(run.status).toBe(3);
    expect(codes).toContain('DATASET_SHA256_FORMAT');
  });

  it('well-formed but wrong digest → DATASET_SHA256_MISMATCH (exit 3)', () => {
    const { world, generated } = worldWithGroups('p21-mismatch');
    generated.datasetSha256 = 'a'.repeat(64);
    const { run, codes } = verifyWith(world, generated);
    expect(run.status).toBe(3);
    expect(codes).toContain('DATASET_SHA256_MISMATCH');
  });

  it('correct binding → verify passes (the generated file itself)', () => {
    const { world, generated } = worldWithGroups('p21-ok');
    expect(generated.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
    const { run, codes } = verifyWith(world, generated);
    expect(run.status).toBe(0);
    expect(codes).toEqual([]);
  });
});

describe('P2-2 evidenceRefs element validity (real CLI subprocess)', () => {
  function datasetWithRefs(label: string, evidenceRefs: unknown) {
    const world = buildHealthyWorld(label);
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    dataset.samples[0].evidenceRefs = evidenceRefs;
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    return world;
  }

  function expectStructuralReject(label: string, evidenceRefs: unknown) {
    const world = datasetWithRefs(label, evidenceRefs);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    const reason = stderrReason(run);
    expect(reason.reason).toBe('dataset_invalid_structure');
    expect(JSON.stringify(reason)).toContain('evidenceRefs');
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(false);
    return reason;
  }

  it('normal string array passes and resolves as before', () => {
    const world = datasetWithRefs('p22-ok', ['session:sess-healthy', 'owner_reported:cli']);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    expect(readOut(world.outDir).report.perSample[0].problems.some((p: { code: string }) => p.code === 'REFERENCE_UNAVAILABLE')).toBe(false);
  });

  it('element null → structural rejection (never silently filtered)', () => {
    expectStructuralReject('p22-null-el', ['session:sess-healthy', null]);
  });

  it('element number → structural rejection', () => {
    expectStructuralReject('p22-num-el', ['session:sess-healthy', 42]);
  });

  it('element object → structural rejection', () => {
    expectStructuralReject('p22-obj-el', [{ sourceId: 'x' }]);
  });

  it('element empty string → structural rejection', () => {
    expectStructuralReject('p22-empty-el', ['session:sess-healthy', '']);
  });

  it('whole field null → structural rejection', () => {
    expectStructuralReject('p22-null-field', null);
  });

  it('whole field non-array (object) → structural rejection', () => {
    expectStructuralReject('p22-obj-field', { refs: ['session:sess-healthy'] });
  });

  it('whole field missing → fine (optional field)', () => {
    const world = buildHealthyWorld('p22-absent');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    delete dataset.samples[0].evidenceRefs;
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    expect(readOut(world.outDir).report.perSample[0].problems.some((p: { code: string }) => p.code === 'REFERENCE_UNAVAILABLE')).toBe(false);
  });
});

describe('P2-3 blob evidenceRef content digest (real CLI subprocess)', () => {
  const ORPHAN_BLOB = `assistant-${'9'.repeat(64)}.txt`;

  it('blob referenced ONLY via evidenceRefs, content tampered without touching the manifest → DIGEST_MISMATCH on the evidence path', () => {
    const world = buildWorld('p23-digest', {
      sessions: [{ sessionId: 'sess-o', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-o', evidenceRefs: [`blob:${ORPHAN_BLOB}`] }],
      blobBodies: new Map([[ORPHAN_BLOB, 'original-orphan-body']]),
    });
    // No turn references ORPHAN_BLOB — only the dataset evidenceRef does.
    // Tamper the file bytes WITHOUT updating the manifest.
    fs.writeFileSync(path.join(world.snapshotDir, 'blobs', ORPHAN_BLOB), 'tampered-orphan-body', 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const digest = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'DIGEST_MISMATCH');
    expect(digest).toBeDefined();
    expect(digest.fieldOrRef).toBe('evidenceRefs:S01');
    // And the evidence path must NOT count as resolved.
    expect(out.report.perSample[0].problems.some((p: { code: string }) => p.code === 'REFERENCE_UNAVAILABLE')).toBe(false);
  });

  it('blob referenced ONLY via evidenceRefs with intact content → resolves cleanly', () => {
    const world = buildWorld('p23-clean', {
      sessions: [{ sessionId: 'sess-o', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-o', evidenceRefs: [`blob:${ORPHAN_BLOB}`] }],
      blobBodies: new Map([[ORPHAN_BLOB, 'original-orphan-body']]),
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.report.perSample[0].problems.some((p: { code: string }) => p.code === 'DIGEST_MISMATCH')).toBe(false);
    expect(out.report.perSample[0].problems.some((p: { code: string }) => p.code === 'REFERENCE_UNAVAILABLE')).toBe(false);
  });
});

describe('P2-4 WAL production read-only discipline (real CLI subprocess)', () => {
  /** Header bytes 18/19 must say WAL (2) for the fixture to be a real WAL db. */
  function assertWalHeader(dbPath: string) {
    const fd = fs.openSync(dbPath, 'r');
    try {
      const header = Buffer.alloc(100);
      fs.readSync(fd, header, 0, 100, 0);
      expect(header[18]).toBe(2);
      expect(header[19]).toBe(2);
    } finally {
      fs.closeSync(fd);
    }
  }

  function shaOf(p: string) {
    return sha256File(p);
  }

  function assertTreeUnchanged(before: Map<string, { sha256: string; mtimeMs: number }>, after: Map<string, { sha256: string; mtimeMs: number }>, label: string) {
    const newPaths = [...after.keys()].filter((rel) => !before.has(rel));
    expect(newPaths, `${label}: no new files`).toEqual([]);
    const removed = [...before.keys()].filter((rel) => !after.has(rel));
    expect(removed, `${label}: nothing deleted`).toEqual([]);
    for (const [rel, meta] of before) {
      expect(after.get(rel), `${label}: ${rel} unchanged`).toEqual(meta);
    }
  }

  function assertNoStagingLeftovers() {
    const leftovers = fs.readdirSync(tmpRoot()).filter((name) => name.startsWith('pd-lab-probe-stage-'));
    expect(leftovers).toEqual([]);
  }

  it('A. silent WAL: WAL-header db without sidecars is read through staging; source untouched', () => {
    const world = buildWorld('p24-silent', {
      journalMode: 'wal',
      sessions: [{ sessionId: 'sess-w', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-w' }],
    });
    assertWalHeader(path.join(world.snapshotDir, 'trajectory.db'));
    // A clean close must have removed the sidecars.
    expect(fs.existsSync(path.join(world.snapshotDir, 'trajectory.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(world.snapshotDir, 'trajectory.db-shm'))).toBe(false);

    const before = fingerprintTree(world.root);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const after = fingerprintTree(world.root);
    // Everything outside --out must be byte-and-mtime identical; --out is the
    // ONLY new tree.
    const stripOut = (tree: Map<string, { sha256: string; mtimeMs: number }>) =>
      new Map([...tree].filter(([rel]) => !rel.startsWith('probe-out/')));
    assertTreeUnchanged(stripOut(before), stripOut(after), 'silent WAL');
    const newPaths = [...after.keys()].filter((rel) => !before.has(rel));
    expect(newPaths.every((rel) => rel.startsWith('probe-out/'))).toBe(true);

    const report = JSON.parse(fs.readFileSync(path.join(world.outDir, 'admission-report.json'), 'utf8'));
    expect(report.snapshot.readPlan).toBe('stage');
    expect(report.snapshot.stagedRead).toMatchObject({ used: true, copiedWal: false, cleanup: 'removed' });
    assertNoStagingLeftovers();
  });

  it('B. active WAL: committed-but-uncheckpointed data is read correctly; db/-wal/-shm untouched', () => {
    const WAL_SESSION = 'sess-wal-only';
    const world = buildWorld('p24-active', {
      journalMode: 'wal',
      keepOpen: true,
      omitSampleRows: ['W01'],
      sessions: [
        { sessionId: 'sess-main', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] },
      ],
      samples: [
        { caseId: 'M01', sessionId: 'sess-main' },
        { caseId: 'W01', sessionId: WAL_SESSION },
      ],
    });
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    assertWalHeader(dbPath);
    expect(fs.existsSync(walPath)).toBe(true); // writer holds it open

    // Commit the W01 sample rows through the open writer; autocheckpoint is
    // off, so the frames stay in -wal (never reach the main db).
    const writer = world.db;
    writer.prepare('INSERT INTO pain_events (id, session_id, source, score, created_at) VALUES (?, ?, ?, ?, ?)').run(2, WAL_SESSION, 'user_frustration', 80, PAIN_AT);
    writer.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run(WAL_SESSION, T0, T0);
    writer.prepare('INSERT INTO user_turns (session_id, turn_index, raw_text, created_at) VALUES (?, ?, ?, ?)').run(WAL_SESSION, 0, 'wal-committed-body', T0);
    writer.prepare('INSERT INTO assistant_turns (session_id, run_id, provider, model, sanitized_text, usage_json, empathy_signal_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(WAL_SESSION, 'run-wal', 'p', 'm', '[wal]', '{}', '{}', T0);

    const dbShaBefore = shaOf(dbPath);
    const dbMtimeBefore = fs.statSync(dbPath).mtimeMs;
    const walShaBefore = shaOf(walPath);
    const walMtimeBefore = fs.statSync(walPath).mtimeMs;
    const shmShaBefore = fs.existsSync(shmPath) ? shaOf(shmPath) : null;
    const beforeSet = new Set(fs.readdirSync(world.snapshotDir));

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);

    // Committed WAL data IS visible to the probe: W01 resolves its session
    // rows (no SOURCE_GAP from "no rows").
    const out = readOut(world.outDir);
    const w01 = out.report.perSample.find((s: { caseId: string }) => s.caseId === 'W01');
    expect(w01).toBeDefined();
    expect(codesOf(out, 'W01')).not.toContain('SOURCE_GAP');

    // The originals are untouched: no new files, main db and -wal byte-identical.
    const afterSet = new Set(fs.readdirSync(world.snapshotDir));
    expect([...afterSet].sort()).toEqual([...beforeSet].sort());
    expect(shaOf(dbPath)).toBe(dbShaBefore);
    expect(fs.statSync(dbPath).mtimeMs).toBe(dbMtimeBefore);
    expect(shaOf(walPath)).toBe(walShaBefore);
    expect(fs.statSync(walPath).mtimeMs).toBe(walMtimeBefore);
    if (shmShaBefore !== null) {
      expect(shaOf(shmPath)).toBe(shmShaBefore); // probe never opened the original → no lock-page writes
    }

    const report = JSON.parse(fs.readFileSync(path.join(world.outDir, 'admission-report.json'), 'utf8'));
    expect(report.snapshot.readPlan).toBe('stage');
    expect(report.snapshot.stagedRead).toMatchObject({ used: true, copiedWal: true, cleanup: 'removed' });
    assertNoStagingLeftovers();

    writer.close();
  });
});

// ---------------------------------------------------------------------------
// r2 second-round review (9 findings relayed by the user) — verification of
// the production-semantics and fail-closed fixes. Findings R820/R856 were
// already fixed by the r2 P1-2/P2-3 work and are covered by the P1-2/P2-3
// suites above; the rest have dedicated cases here.
// ---------------------------------------------------------------------------

describe('r2 second-round findings (production semantics + fail-closed gates)', () => {
  it('R285: real-dataset shape — host_kind null is accepted and normalized to unknown attribution', () => {
    const world = buildHealthyWorld('r2-nullhost');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    dataset.samples[0].painEvent.host_kind = null; // S01/S08 in the frozen dataset carry null
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0); // no dataset_invalid_structure
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
    expect(out.report.perSample[0].hostKind).toBe(''); // unknown attribution preserved, never fabricated as openclaw
  });

  it('R455: manifest ok=false → the whole probe fails closed (snapshot_consistency_unverified)', () => {
    const world = buildHealthyWorld('r2-okfalse');
    const manifestPath = path.join(world.snapshotDir, 'blob-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.ok = false;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('snapshot_consistency_unverified');
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(false);
  });

  it('R455: PARTIAL_CONSISTENCY snapshot → fail closed, never READY verdicts', () => {
    const world = buildHealthyWorld('r2-partial');
    const manifestPath = path.join(world.snapshotDir, 'blob-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.consistencyStatus = 'PARTIAL_CONSISTENCY';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(1);
    expect(stderrReason(run).reason).toBe('snapshot_consistency_unverified');
  });

  it('R345: expectation without a declared basis → structural rejection (resolved=true cannot substitute)', () => {
    const world = buildHealthyWorld('r2-nobasis');
    const expFile = writeJson(world.root, 'exp.json', { S01: { resolved: true } });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile]);
    expect(run.status).toBe(1);
    const reason = stderrReason(run);
    expect(reason.reason).toBe('expectations_invalid_structure');
    expect(JSON.stringify(reason)).toContain('basis');
  });

  it('R695: emoji truncated preview (500 UTF-16 units, 499 code points) IS detected as preview-only', () => {
    const world = buildWorld('r2-emoji', {
      sessions: [
        {
          sessionId: 'sess-emoji',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          // Producer form: 1 astral char (2 UTF-16 units) + 495 x + '...' = exactly
          // 500 UTF-16 units, but 499 code points — SQLite length() would miss it.
          toolCalls: [{ paramsJson: '{}', resultPreview: `\u{1F600}${'x'.repeat(495)}...` }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-emoji' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    expect(codesOf(readOut(world.outDir), 'S01')).toContain('TOOL_RESULT_PREVIEW_ONLY');
  });

  it('R695: a legitimately long output that merely ends with "..." is NOT flagged (length window guard)', () => {
    const world = buildWorld('r2-longok', {
      sessions: [
        {
          sessionId: 'sess-long',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{}', resultPreview: `${'x'.repeat(600)}...` }], // >501 code points
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-long' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    expect(codesOf(readOut(world.outDir), 'S01')).not.toContain('TOOL_RESULT_PREVIEW_ONLY');
  });

  it('R570: mixed timezone offsets — normal instant order is NOT a gap (positive control)', () => {
    const world = buildWorld('r2-tz-order-ok', {
      sessions: [
        {
          sessionId: 'sess-tz',
          startedAt: T0,
          userTurns: [
            { turnIndex: 0, createdAt: '2026-09-01T10:00:00.000Z' },
            { turnIndex: 1, createdAt: '2026-09-01T09:10:00-01:00' }, // == 10:10Z — AFTER turn 0
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:01:00.000Z' }, { createdAt: '2026-09-01T10:11:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-tz', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).not.toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('R570: real instant backwards across offsets IS detected as order inconsistency (negative control)', () => {
    const world = buildWorld('r2-tz-order-bad', {
      sessions: [
        {
          // started_at == earliest turn so the retention-evidence branch
          // cannot fire — the assertion must isolate the ORDER finding.
          sessionId: 'sess-tz-bad',
          startedAt: '2026-09-01T10:05:00.000Z',
          userTurns: [
            { turnIndex: 0, createdAt: '2026-09-01T12:10:00+02:00' }, // == 10:10Z
            { turnIndex: 1, createdAt: '2026-09-01T10:05:00.000Z' }, // 10:05Z — real backwards step
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:11:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-tz-bad', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const problem = readOut(world.outDir).report.perSample[0].problems.find((p: { code: string }) => p.code === 'SOURCE_GAP');
    expect(problem).toBeDefined();
    expect(problem.impact).toContain('not monotonic');
  });

  it('R600: retention evidence survives the turn_index reversal — started_at-only evidence still yields SOURCE_RETENTION_EXPIRED', () => {
    // Session created at 10:00, only rows surviving from 10:06 (turn_index
    // contiguous from 2 — production numbering): the started_at evidence
    // alone proves earlier rows existed.
    const lateStart = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('r2-retention-only', {
      sessions: [
        {
          sessionId: 'sess-ret',
          startedAt: T0,
          userTurns: [{ turnIndex: 2, createdAt: lateStart }, { turnIndex: 3, createdAt: lateStart }],
          assistantTurns: [{ createdAt: lateStart }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-ret', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).toContain('SOURCE_RETENTION_EXPIRED');
    expect(codes).not.toContain('SOURCE_GAP');
  });

  it('R889: expectation depends on tool output + preview-only → INCOMPLETE completeness while PIPELINE_REPLAY stays READY', () => {
    const truncated = `${'x'.repeat(497)}...`;
    const world = buildWorld('r9-gap', {
      sessions: [
        {
          sessionId: 'sess-gap',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{}', resultPreview: truncated }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-gap' }],
    });
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
    });
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const sample = readOut(world.outDir).report.perSample[0];
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY'); // replay semantics independent
    expect(sample.executableForDeclaredPath.PIPELINE_REPLAY).toBe(true);
    expect(sample.completeness).toBe('INCOMPLETE'); // expectation evidence is gapped
  });

  it('R820/R856 regression anchors: bare granted+scope grant does NOT unblock; evidence-only corrupted blob IS caught', () => {
    // R820: an authorization carrying ONLY status+scope (no purpose/window)
    // must leave the case unauthorized.
    const worldA = buildHealthyWorld('r2-bareauth');
    const expA = writeJson(worldA.root, 'exp.json', healthyExpectations());
    const authA = writeJson(worldA.root, 'auth.json', { S01: { status: 'granted', scope: 'full_fidelity' } });
    const runA = runProbe(['--dataset', worldA.datasetPath, '--snapshot', worldA.snapshotDir, '--out', worldA.outDir, '--expectations', expA, '--authorizations', authA]);
    expect(runA.status).toBe(0);
    const outA = readOut(worldA.outDir);
    expect(codesOf(outA, 'S01')).toContain('AUTHORIZATION_UNVERIFIED');
    expect(outA.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');

    // R856: a blob referenced ONLY via evidenceRefs with tampered bytes is
    // caught by the evidence-path digest verification (P2-3 suite covers the
    // full matrix; this anchors the reviewer's exact example).
    const ORPHAN = `assistant-${'8'.repeat(64)}.txt`;
    const worldB = buildWorld('r2-orphan-corrupt', {
      sessions: [{ sessionId: 'sess-o', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-o', evidenceRefs: [`blob:${ORPHAN}`] }],
      blobBodies: new Map([[ORPHAN, 'correct-body']]),
    });
    fs.writeFileSync(path.join(worldB.snapshotDir, 'blobs', ORPHAN), 'corrupted-body', 'utf8');
    const runB = runProbe(['--dataset', worldB.datasetPath, '--snapshot', worldB.snapshotDir, '--out', worldB.outDir]);
    expect(runB.status).toBe(0);
    expect(codesOf(readOut(worldB.outDir), 'S01')).toContain('DIGEST_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Closed-set round-trip (ERR-146): every CONTRACT code is actually emitted by
// some case in this suite, and the probe never emits codes outside the list.
// ---------------------------------------------------------------------------

describe('problem-code closed set (CONTRACT §2.4 / ERR-146 round-trip)', () => {
  it('a world exercising every code emits exactly the CONTRACT first-batch set', () => {
    const blobA = `assistant-${'c'.repeat(64)}.txt`;
    const blobB = `assistant-${'d'.repeat(64)}.txt`;
    const world = buildWorld('allcodes', {
      sessions: [
        {
          // healthy session with a preview-only tool result
          sessionId: 'sess-ok',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{}', resultPreview: `${'z'.repeat(497)}...` }],
        },
        { sessionId: 'sess-gone', startedAt: T0, omitSessionRow: true }, // no rows → SOURCE_GAP
        {
          // retention evidence: started before the (late) surviving rows
          sessionId: 'sess-expired',
          startedAt: T0,
          userTurns: [{ turnIndex: 0, createdAt: '2026-09-01T10:06:00.000Z', blobRef: blobA }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z', blobRef: blobB }],
        },
        {
          // broken tool pairing
          sessionId: 'sess-toolbreak',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: 'oops{', resultPreview: 'ok' }],
        },
      ],
      samples: [
        { caseId: 'C01', sessionId: 'sess-ok' }, // preview-only + expectation + authorization + env
        { caseId: 'C02', sessionId: 'sess-gone' }, // SOURCE_GAP
        { caseId: 'C03', sessionId: 'sess-expired', createdAt: PAIN_AT }, // RETENTION_EXPIRED + blob issues
        { caseId: 'C04', sessionId: 'sess-toolbreak', evidenceRefs: ['session:sess-nope'] }, // REFERENCE_UNAVAILABLE ×2
        { caseId: 'C05', sessionId: '' }, // PAIN_ANCHOR_MISSING
      ],
      corruptManifestEntry: (entry: { ref: string; sha256: string }) => {
        if (entry.ref === blobB) {
          entry.sha256 = '0'.repeat(64); // DIGEST_MISMATCH for an existing file
        }
      },
      dropBlob: blobA, // manifest lists it, file removed → TURN_BLOB_MISSING
    });
    const expFile = writeJson(world.root, 'exp.json', {
      C01: { basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
      C03: { basis: 'LATER_CLARIFICATION', resolved: true, visibleAt: '2026-12-01T00:00:00.000Z' }, // FUTURE_INFORMATION
    });
    const authFile = writeJson(world.root, 'auth.json', {
      C01: { status: 'granted', scope: 'full_fidelity' },
      C02: { status: 'withdrawn', scope: 'full_fidelity' },
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);

    const out = readOut(world.outDir);
    const emitted = new Set<string>();
    for (const sample of out.report.perSample) {
      for (const problem of sample.problems) {
        emitted.add(problem.code);
      }
    }
    // Every CONTRACT first-batch code is exercised by a real case.
    for (const code of CONTRACT_PROBLEM_CODES) {
      expect(emitted.has(code), `code ${code} must be emitted by at least one case`).toBe(true);
    }
    // And nothing outside the closed set is ever emitted.
    for (const code of emitted) {
      expect(CONTRACT_PROBLEM_CODES).toContain(code);
    }
    // Spot checks binding specific cases to specific codes.
    expect(codesOf(out, 'C02')).toContain('AUTHORIZATION_UNVERIFIED'); // withdrawn tracked
    expect(codesOf(out, 'C03')).toContain('FUTURE_INFORMATION');
    expect(codesOf(out, 'C03')).toContain('SOURCE_RETENTION_EXPIRED');
    expect(codesOf(out, 'C03')).toContain('DIGEST_MISMATCH');
    expect(codesOf(out, 'C05')).toContain('PAIN_ANCHOR_MISSING');
  });
});
