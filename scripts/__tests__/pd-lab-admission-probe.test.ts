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
  stderrReason,
  runNpmLabProbe,
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

  it('turn_index starting above 0 is itself the retention evidence → SOURCE_RETENTION_EXPIRED', () => {
    const lateStart = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('ret-index', {
      sessions: [
        {
          sessionId: 'sess-idx',
          startedAt: lateStart,
          userTurns: [{ turnIndex: 4, createdAt: lateStart }, { turnIndex: 5, createdAt: lateStart }],
          assistantTurns: [{ createdAt: lateStart }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-idx', createdAt: PAIN_AT }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).toContain('SOURCE_RETENTION_EXPIRED');
    expect(codes).not.toContain('SOURCE_GAP');
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
      S01: { status: 'granted', scope: 'full_fidelity' },
      S02: { status: 'granted', scope: 'full_fidelity' },
      S03: { status: 'granted', scope: 'full_fidelity' },
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
      JSON.stringify({ schema: 'pd-lab-blob-manifest.v1', files: [], counts: { referencedDistinct: 0, referencedRows: 0, copied: 0, orphansNotCopied: 0 } }),
      'utf8',
    );
    const datasetPath = path.join(world.root, 'badtable-dataset.json');
    fs.writeFileSync(datasetPath, JSON.stringify({ samples: [{ experimentPainId: 'S01', painEvent: { session_id: 's', created_at: PAIN_AT } }] }), 'utf8');
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
