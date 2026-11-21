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
  T1,
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
  TEST_DIR,
  createFifo,
  runProbeWithTimeout,
  runProbeWithEnv,
  runRealRetentionSweep,
  runRealRetentionSweepWithHooks,
  plantSignalConfirmation,
  countSessionRows,
} from './fixtures/pd-lab-admission-probe-helpers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3'); // same resolution as the helpers fixture

// ---------------------------------------------------------------------------
// Data-integrity checks (TECH §5.2 table rows → CONTRACT §2.4 codes)
// ---------------------------------------------------------------------------

describe('pd-lab admission probe (PRI-1257 T7a-Data)', () => {
  it('healthy sample: internally continuous but prefix UNKNOWN → SOURCE_GAP, INCOMPLETE, all paths blocked (r6)', () => {
    const world = buildHealthyWorld('healthy');
    const exp = writeJson(world.root, 'exp.json', healthyExpectations());
    const auth = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', exp, '--authorizations', auth]);
    expect(run.status).toBe(0);

    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    // r7: the prefix verdict is UNKNOWN (created_at is a timestamp, not a row
    // identity; bare recordSession creations are legal, prompt.ts:659) — that
    // downgrades the sample-level completeness but does NOT block the
    // pipeline path, whose ACTUAL inputs (the session's whole turn lists the
    // production fallback reads) are fully present and blob-intact.
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
    expect(sample.pathReadiness.BEHAVIOR_BRANCH).toBe('BLOCKED');
    expect(codesOf(out, 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
    expect(sample.executableForDeclaredPath).toEqual({
      PIPELINE_REPLAY: true,
      EXPECTATION_LABELING: true,
      BEHAVIOR_BRANCH: false,
    });
  });

  it('r7 Case P1-B: a REAL pipeline-input gap still blocks READY while the prefix stays UNKNOWN', () => {
    // Same complete shape as r7 Case P1-A, minus one production-required
    // input: the assistant side of the conversation (role coverage gap) — an
    // OBSERVED input gap, not a prefix inference.
    const world = buildWorld('r7-p1b', {
      sessions: [
        {
          sessionId: 'sess-p1b',
          startedAt: T0,
          userTurns: [{ turnIndex: 2, createdAt: T0 }, { turnIndex: 3, createdAt: T1 }],
          assistantTurns: [],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-p1b', createdAt: PAIN_AT }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.prefixCompleteness).toBe('UNKNOWN'); // unchanged — the prefix is orthogonal
    expect(codesOf(out, 'S01')).toContain('SOURCE_GAP'); // REAL observed input gap
    const problem = sample.problems.find((p: { code: string }) => p.code === 'SOURCE_GAP');
    expect(problem.impact).toContain('no assistant turns');
    expect(problem.nextAction).toBeTruthy();
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED'); // the actual input is missing
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual(['SOURCE_GAP']);
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

    // Without an expectation record: preview-only is RECORDED. r6: the
    // prefix verdict is UNKNOWN for every session (no first-writer identity
    // anchor), so PIPELINE_REPLAY is honestly BLOCKED by SOURCE_GAP — the
    // "preview-only does not block replay" rule stays implemented in
    // classifySample (TOOL_RESULT_PREVIEW_ONLY is not in the replay blocking
    // set) but is masked at CLI level until producer provenance exists.
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', auth]);
    expect(run.status).toBe(0);
    let out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('TOOL_RESULT_PREVIEW_ONLY');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: prefix UNKNOWN disclosed, not blocking
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('READY'); // preview-only does NOT block replay
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED'); // EXPECTATION_UNRESOLVED present

    // Resolved expectation NOT depending on tool output: labeling READY —
    // the preview does not block it and the pipeline inputs are complete.
    const out2Dir = path.join(world.root, 'out-b');
    const exp2 = writeJson(world.root, 'exp2.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: false },
    });
    const run2 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', out2Dir, '--expectations', exp2, '--authorizations', auth]);
    expect(run2.status).toBe(0);
    out = readOut(out2Dir);
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('READY');

    // Expectation depends on tool output: preview-only blocks the labeling
    // path in its own right while replay stays READY.
    const out3Dir = path.join(world.root, 'out-c');
    const exp3 = writeJson(world.root, 'exp3.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
    });
    const run3 = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', out3Dir, '--expectations', exp3, '--authorizations', auth]);
    expect(run3.status).toBe(0);
    out = readOut(out3Dir);
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(out.report.perSample[0].pathBlockers.EXPECTATION_LABELING).toEqual(['TOOL_RESULT_PREVIEW_ONLY']);
    expect(out.report.perSample[0].pathBlockers.PIPELINE_REPLAY).toEqual([]);
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
    expect(codes).not.toContain('SOURCE_GAP'); // r7: no REAL gap observed — prefix UNKNOWN is disclosed, not blocking // inline text absent but rows exist on both sides
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
    expect(out.report.perSample[0].completeness).toBe('INCOMPLETE'); // prefix UNKNOWN is a completeness blocker (r6)
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

  it('session-LESS sample with an explicit non-openclaw host → all paths NOT_EVALUATED (first version covers OpenClaw only; no ingress host attribution involved)', () => {
    // r8 P1-01 narrowed NOT_EVALUATED to the session-less shape: a session-
    // BOUND non-openclaw host is now judged per path (see the r8 host matrix
    // suite) with PIPELINE_REPLAY blocked by INGRESS_HOST_UNRESOLVABLE.
    const world = buildWorld('host', {
      sessions: [{ sessionId: 'sess-h', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: '', hostKind: 'codex' }],
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
    expect(codes).not.toContain('SOURCE_GAP'); // r7: no REAL gap observed — prefix UNKNOWN is disclosed, not blocking
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

  it('started_at strictly before the earliest surviving turn WITHOUT positive evidence → SOURCE_GAP, never retention (r6: bare recordSession creators are legal)', () => {
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
    // r6 soundness: recordSession({sessionId}) is a legal bare creator
    // (prompt.ts:659), so an unexplained started_at diff does NOT prove a
    // sweepable trajectory row was deleted — the prefix verdict is UNKNOWN
    // (disclosed). The SOURCE_GAP here is the OBSERVED gap (every surviving
    // turn is after the pain trigger), never a retention claim.
    expect(codes).toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(out.report.perSample[0].prefixCompleteness).toBe('UNKNOWN');
    expect(out.report.perSample[0].sessionStartExplanation).toBe('UNEXPLAINED');
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
    expect(codes).not.toContain('SOURCE_GAP'); // r7: no REAL gap observed — prefix UNKNOWN is disclosed, not blocking
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('SOURCE_GAP entries from an unexplained started_at diff are remediable via the host-native session file', () => {
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
    // r6: an unexplained diff is SOURCE_GAP (bare recordSession creators are
    // legal) — remediable via the host-native session file, unlike the
    // positively-proven N1 deletions (see the Case H1 suite).
    const entry = out.queue.entries.find((e: { problemCode: string }) => e.problemCode === 'SOURCE_GAP');
    expect(entry).toBeDefined();
    expect(entry.remediable).toBe(true);
    expect(out.queue.entries.find((e: { problemCode: string }) => e.problemCode === 'SOURCE_RETENTION_EXPIRED')).toBeUndefined();
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
  it('path readiness stays per-path independent: PIPELINE_REPLAY READY does not leak into EXPECTATION_LABELING', () => {
    const world = buildHealthyWorld('indep');
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    // r7: the pipeline inputs are complete → replay READY; the labeling path
    // carries its OWN blocker (missing expectation) and stays BLOCKED — one
    // path's verdict never derives from another's, and the per-path blocker
    // lists make the reasons auditable.
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.executableForDeclaredPath.PIPELINE_REPLAY).toBe(true);
    expect(sample.executableForDeclaredPath.EXPECTATION_LABELING).toBe(false);
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
    expect(sample.pathBlockers.EXPECTATION_LABELING).toEqual(['EXPECTATION_UNRESOLVED']);
    expect(sample.problems.some((p: { code: string }) => p.code === 'EXPECTATION_UNRESOLVED')).toBe(true);
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
    // r7: prefix UNKNOWN does not block path readiness — S01's actual inputs
    // are complete (READY), S02 has an observed no-rows gap (BLOCKED); r8
    // P1-01: session-bound codex S03 is no longer NOT_EVALUATED — its
    // PIPELINE_REPLAY is BLOCKED by the structured INGRESS_HOST_UNRESOLVABLE
    // (fail-closed like the production ingress), so the NOT_EVALUATED bucket
    // is now reserved for redacted/session-less-scope samples.
    expect(counts.paths.PIPELINE_REPLAY).toEqual({ total: 3, READY: 1, BLOCKED: 2, NOT_EVALUATED: 0 });
    expect(counts.paths.BEHAVIOR_BRANCH).toEqual({ total: 3, READY: 0, BLOCKED: 3, NOT_EVALUATED: 0 });
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
    expect(codesOf(out, 'W01')).not.toContain('SOURCE_GAP'); // r7: prefix UNKNOWN disclosed, not blocking

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
    // r8 P1-01: the session-bound sample with an unknown host ALSO gets the
    // structured ingress blocker — PIPELINE_REPLAY is BLOCKED (the A/B runner
    // would refuse it with ingress_host_unresolvable before any CLI call),
    // while the healthy expectation evidence keeps EXPECTATION_LABELING READY
    // on its own merits.
    expect(codesOf(out, 'S01')).toEqual(['INGRESS_HOST_UNRESOLVABLE', 'ENVIRONMENT_UNAVAILABLE']);
    expect(out.report.perSample[0].hostKind).toBe(''); // unknown attribution preserved, never fabricated as openclaw
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    expect(out.report.perSample[0].pathBlockers.PIPELINE_REPLAY).toEqual(['INGRESS_HOST_UNRESOLVABLE']);
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('READY');
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
    expect(codes).not.toContain('SOURCE_GAP'); // r7: no REAL gap observed — prefix UNKNOWN is disclosed, not blocking
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

  it('R600 (r6 revision): started_at-only evidence yields SOURCE_GAP with UNEXPLAINED origin — bare recordSession creators are legal', () => {
    // Session created at 10:00, only rows surviving from 10:06 (turn_index
    // contiguous from 2 — production numbering). r6 soundness: an unexplained
    // started_at diff does not prove a sweepable trajectory row was deleted,
    // because a bare recordSession({sessionId}) creation (prompt.ts:659) is a
    // legal state with no trajectory rows at all.
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
    const out = readOut(world.outDir);
    const codes = codesOf(out, 'S01');
    expect(codes).toContain('SOURCE_GAP'); // OBSERVED gap: every surviving turn is after the pain trigger
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED'); // r6/r7: no positive evidence → never retention
    expect(out.report.perSample[0].sessionStartExplanation).toBe('UNEXPLAINED');
    expect(out.report.perSample[0].prefixCompleteness).toBe('UNKNOWN');
  });

  it('R889 (r6 revision): expectation depends on tool output + preview-only → INCOMPLETE completeness; the replay path stays free of the preview blocker', () => {
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
    // The preview does not block the replay path (the production entry reads
    // the same preview) — its blocker list stays empty while the labeling
    // path carries the preview-only blocker.
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
    expect(sample.problems.filter((p: { code: string }) => p.code === 'TOOL_RESULT_PREVIEW_ONLY').length).toBe(1);
    expect(sample.executableForDeclaredPath.PIPELINE_REPLAY).toBe(true);
    expect(sample.completeness).toBe('INCOMPLETE'); // expectation evidence is gapped AND prefix unproven
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
// r3 final remediation — started_at-only retention evidence, FIFO
// non-blocking refusal, fd lifecycle fault injection.
// ---------------------------------------------------------------------------

describe('r3 P1-01: started_at-only retention evidence stands alone (real CLI subprocess)', () => {
  it('Case A (r6 revision): started_at-only diff with NO other gap and NO positive evidence → SOURCE_GAP, INCOMPLETE, paths blocked', () => {
    const world = buildWorld('r3-ret-only', {
      sessions: [
        {
          sessionId: 'sess-ret-a',
          startedAt: T0, // 10:00
          userTurns: [
            { turnIndex: 2, createdAt: '2026-09-01T10:06:00.000Z' },
            { turnIndex: 3, createdAt: '2026-09-01T10:07:00.000Z' },
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }, { createdAt: '2026-09-01T10:07:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-ret-a', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    // The prefix is UNKNOWN (disclosed on the sample, not a blocking
    // problem). No gapReason fires — the pain trigger is AFTER the surviving
    // turns, the window is contiguous and role-complete — so the code list
    // carries no SOURCE_GAP and the replay path is READY (r7 Case P1-A).
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(sample.sessionStartExplanation).toBe('UNEXPLAINED');
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
    // r7: the prefix verdict is carried on the per-sample record, not as a
    // fabricated path problem.
    expect(sample.problems.find((p: { code: string }) => p.code === 'SOURCE_GAP')).toBeUndefined();
  });

  it('Case B: started_at EQUAL to the earliest surviving turn is NOT positive evidence', () => {
    const world = buildWorld('r3-ret-eq', {
      sessions: [
        {
          sessionId: 'sess-ret-b',
          startedAt: '2026-09-01T10:06:00.000Z', // == earliest surviving turn
          userTurns: [{ turnIndex: 0, createdAt: '2026-09-01T10:06:00.000Z' }, { turnIndex: 1, createdAt: '2026-09-01T10:07:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-ret-b', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(codes).not.toContain('SOURCE_GAP'); // r7: no REAL gap observed — prefix UNKNOWN is disclosed, not blocking
  });

  it('Case C: unparseable started_at is never positive evidence; a real gap keeps SOURCE_GAP semantics', () => {
    const world = buildWorld('r3-ret-badts', {
      sessions: [
        {
          sessionId: 'sess-ret-c',
          startedAt: 'not-a-timestamp',
          userTurns: [{ turnIndex: 0, createdAt: '2026-09-01T10:06:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-ret-c', createdAt: PAIN_AT }], // pain BEFORE the only surviving turn → real gap
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const codes = codesOf(out, 'S01');
    expect(codes).toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('Case D: production turn_index (from 2, contiguous) with started_at == earliest turn → no retention claim', () => {
    const first = '2026-09-01T10:06:00.000Z';
    const world = buildWorld('r3-ret-prod', {
      sessions: [
        {
          sessionId: 'sess-ret-d',
          startedAt: first, // == earliest surviving turn (nextUserTurnIndex semantics)
          userTurns: [{ turnIndex: 2, createdAt: first }, { turnIndex: 3, createdAt: first }],
          assistantTurns: [{ createdAt: first }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-ret-d', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const codes = codesOf(readOut(world.outDir), 'S01');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(codes).not.toContain('SOURCE_GAP'); // r7: no REAL gap observed — prefix UNKNOWN is disclosed, not blocking
  });

  it('Case E (r5): /pd-pain before the first turn explains the START but cannot prove the PREFIX — SOURCE_GAP, blocked', () => {
    // Owner submits /pd-pain at 10:00 (pain row + session start at 10:00),
    // then two complete contiguous turn pairs 10:01–10:04, then the dataset
    // pain at 10:05. The pain row EXPLAINS the start (dimension A), but no
    // persisted evidence proves whether trajectory rows existed between the
    // pain and the first surviving turn — a complete pain-first session and a
    // swept one are observationally identical (dimension B = UNKNOWN), so the
    // sample must NOT be treated as prefix-complete (r5: 已解释+UNKNOWN →
    // INCOMPLETE; never upgraded).
    const world = buildWorld('r5-pdpain', {
      sessions: [
        {
          sessionId: 'sess-pain-first',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [
            { turnIndex: 2, createdAt: '2026-09-01T10:01:00.000Z' },
            { turnIndex: 3, createdAt: '2026-09-01T10:02:00.000Z' },
            { turnIndex: 4, createdAt: '2026-09-01T10:03:00.000Z' },
            { turnIndex: 5, createdAt: '2026-09-01T10:04:00.000Z' },
          ],
          assistantTurns: [
            { createdAt: '2026-09-01T10:01:30.000Z' },
            { createdAt: '2026-09-01T10:02:30.000Z' },
            { createdAt: '2026-09-01T10:03:30.000Z' },
            { createdAt: '2026-09-01T10:04:30.000Z' },
          ],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-pain-first', createdAt: '2026-09-01T10:05:00.000Z' }],
      extraPainRows: [{ id: 900, sessionId: 'sess-pain-first', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.sessionStartExplanation).toBe('EXPLAINED_BY_MANUAL_PAIN');
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: prefix UNKNOWN disclosed, not blocking
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED'); // no positive sweep evidence — never claimed
    expect(sample.completeness).toBe('INCOMPLETE'); // prefix drives completeness, not path readiness
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY'); // actual pipeline inputs are complete (r7 Case P1-A shape)
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
  });

  it('Case I (r6 revision): turn-created session with started_at == earliest surviving row — still UNKNOWN without an identity anchor', () => {
    // The first writer "is" the surviving first turn — but created_at is a
    // timestamp, not a row identity: equal timestamps collide across writers,
    // and a bare recordSession creation could share the instant. Without a
    // persisted first-writer identity anchor (not in the current schema) the
    // completeness verdict is honestly UNKNOWN — Case I cannot reach READY
    // until producer-side provenance exists (r6 audit; disclosed in the
    // report and flagged as an Owner decision).
    const world = buildWorld('r5-case-i', {
      sessions: [
        {
          sessionId: 'sess-turn-created',
          startedAt: '2026-09-01T10:01:00.000Z', // == the first turn's instant
          userTurns: [{ turnIndex: 1, createdAt: '2026-09-01T10:01:00.000Z' }, { turnIndex: 2, createdAt: '2026-09-01T10:02:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:01:30.000Z' }, { createdAt: '2026-09-01T10:02:30.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-turn-created', createdAt: '2026-09-01T10:05:00.000Z' }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.sessionStartExplanation).toBe('EXPLAINED_BY_TURN_WRITER');
    expect(sample.prefixCompleteness).toBe('UNKNOWN'); // no identity anchor → never PROVEN_COMPLETE
    expect(codesOf(out, 'S01')).toEqual(['ENVIRONMENT_UNAVAILABLE']);
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY'); // r7: actual inputs complete
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
  });

  it('Case J (r5): only a pain explanation, no prefix proof → UNKNOWN → SOURCE_GAP + INCOMPLETE + BLOCKED', () => {
    const world = buildWorld('r5-case-j', {
      sessions: [
        {
          sessionId: 'sess-j',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [{ turnIndex: 2, createdAt: '2026-09-01T10:06:00.000Z' }, { turnIndex: 3, createdAt: '2026-09-01T10:07:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }, { createdAt: '2026-09-01T10:07:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-j', createdAt: '2026-09-01T10:08:00.000Z' }],
      extraPainRows: [{ id: 900, sessionId: 'sess-j', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.sessionStartExplanation).toBe('EXPLAINED_BY_MANUAL_PAIN');
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: disclosed, not blocking
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('Case K (r5): non-zero turn_index alone is neither retention evidence nor completeness proof', () => {
    // Pain-explained start + contiguous turns starting at index 5: the
    // non-zero index triggers neither SOURCE_RETENTION_EXPIRED (r2 R600) nor
    // PROVEN_COMPLETE — the prefix verdict is UNKNOWN.
    const world = buildWorld('r5-case-k', {
      sessions: [
        {
          sessionId: 'sess-k',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [{ turnIndex: 5, createdAt: '2026-09-01T10:06:00.000Z' }, { turnIndex: 6, createdAt: '2026-09-01T10:07:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-k', createdAt: '2026-09-01T10:08:00.000Z' }],
      extraPainRows: [{ id: 900, sessionId: 'sess-k', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: disclosed, not blocking
  });

  it('Case L (r5): an explained start does NOT mask an independent dangling-reference gap', () => {
    // Pain-explained start + a surviving user turn referencing an assistant
    // turn that a REAL sweep removed — the positive vanished-row evidence
    // must surface as SOURCE_RETENTION_EXPIRED despite the explanation.
    const EARLY_ASSISTANT_BODY_MARKER = 'r5-case-l-early';
    const world = buildWorld('r5-case-l', {
      sessions: [
        {
          sessionId: 'sess-l',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [
            { turnIndex: 2, createdAt: '2026-09-01T10:01:00.000Z' },
            { turnIndex: 3, createdAt: '2026-09-01T10:06:00.000Z' },
          ],
          assistantTurns: [
            { createdAt: '2026-09-01T10:01:30.000Z' },
            { createdAt: '2026-09-01T10:06:30.000Z' },
          ],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-l', createdAt: '2026-09-01T10:08:00.000Z' }],
      extraPainRows: [{ id: 900, sessionId: 'sess-l', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    // The early user turn (rowid via query) references the early assistant
    // turn; both early rows are then aged and removed by the REAL sweeper.
    const db = new Database(path.join(world.snapshotDir, 'trajectory.db'));
    const earlyUser = db.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-l' AND created_at = '2026-09-01T10:01:00.000Z'").get();
    const earlyAssistant = db.prepare("SELECT id FROM assistant_turns WHERE session_id = 'sess-l' AND created_at = '2026-09-01T10:01:30.000Z'").get();
    db.prepare('UPDATE user_turns SET references_assistant_turn_id = ? WHERE id = ?').run(earlyAssistant.id, earlyUser.id);
    db.prepare("UPDATE user_turns SET created_at = '2026-05-01T10:01:00.000Z' WHERE id = ?").run(earlyUser.id);
    db.prepare("UPDATE assistant_turns SET created_at = '2026-05-01T10:01:30.000Z' WHERE id = ?").run(earlyAssistant.id);
    db.close();
    plantSignalConfirmation(path.join(world.snapshotDir, 'trajectory.db'), {
      id: 'sc-l',
      sessionId: 'sess-l',
      userTurnRowid: earlyUser.id,
      referencesAssistantTurnId: earlyAssistant.id,
      createdAt: '2026-09-01T10:02:00.000Z',
    });
    const sweep = runRealRetentionSweep(path.join(world.snapshotDir, 'trajectory.db'), '2026-09-01T00:00:00.000Z');
    expect(sweep.outcome).toBe('completed');
    expect(countSessionRows(path.join(world.snapshotDir, 'trajectory.db'), 'user_turns', 'sess-l')).toBe(1);
    expect(countSessionRows(path.join(world.snapshotDir, 'trajectory.db'), 'assistant_turns', 'sess-l')).toBe(1);

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.sessionStartExplanation).toBe('EXPLAINED_BY_MANUAL_PAIN'); // start still explained
    expect(sample.prefixCompleteness).toBe('PROVEN_INCOMPLETE'); // the independent gap is NOT masked
    expect(codesOf(out, 'S01')).toContain('SOURCE_RETENTION_EXPIRED');
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    const problem = sample.problems.find((p: { code: string }) => p.code === 'SOURCE_RETENTION_EXPIRED');
    expect(problem.impact).toContain('reference turn rows that no longer exist');
  });

  it('Case F (r4): an explained started_at diff does NOT mask an independent continuity gap', () => {
    // The pain row explains the start, but the surviving turns still begin
    // AFTER the pain trigger — the real gap stays SOURCE_GAP, never upgraded
    // or downgraded by the explanation.
    const world = buildWorld('r4-explained-gap', {
      sessions: [
        {
          sessionId: 'sess-expl-gap',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [{ turnIndex: 2, createdAt: '2026-09-01T10:06:00.000Z' }, { turnIndex: 3, createdAt: '2026-09-01T10:07:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-expl-gap', createdAt: PAIN_AT }],
      extraPainRows: [{ id: 900, sessionId: 'sess-expl-gap', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const codes = codesOf(out, 'S01');
    expect(codes).toContain('SOURCE_GAP');
    expect(codes).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('Case G (r6 revision): started_at diff with NO explaining pain row → UNEXPLAINED origin, UNKNOWN prefix, SOURCE_GAP', () => {
    // Same shape as the reviewer example but WITHOUT the 10:00 pain row:
    // nothing explains the start — but an unexplained diff does not prove a
    // sweepable trajectory row was deleted (bare recordSession creations are
    // legal, prompt.ts:659), so the verdict is SOURCE_GAP, not retention.
    const world = buildWorld('r4-unexplained', {
      sessions: [
        {
          sessionId: 'sess-unexpl',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [{ turnIndex: 2, createdAt: '2026-09-01T10:06:00.000Z' }, { turnIndex: 3, createdAt: '2026-09-01T10:07:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }, { createdAt: '2026-09-01T10:07:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-unexpl', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.sessionStartExplanation).toBe('UNEXPLAINED');
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: disclosed, not blocking
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });
});

describe('r3 P1-02: FIFO at a blob path is refused without blocking (real CLI subprocess, POSIX)', () => {
  const BLOB = `assistant-${'b'.repeat(64)}.txt`;

  function fifoWorld() {
    return buildWorld('r3-fifo', {
      sessions: [{ sessionId: 'sess-fifo', startedAt: T0, userTurns: [{ turnIndex: 0, blobRef: BLOB }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-fifo' }],
    });
  }

  it('a writer-less FIFO at the manifest blob path is refused within the timeout, never read', (ctx) => {
    if (process.platform === 'win32') {
      ctx.skip(); // FIFOs are a POSIX special-file type; Windows keeps its junction/symlink/dir refusals
      return;
    }
    const world = fifoWorld();
    const fifoPath = path.join(world.snapshotDir, 'blobs', BLOB);
    fs.rmSync(fifoPath); // replace the real blob file
    if (!createFifo(fifoPath)) {
      ctx.skip(); // mkfifo unavailable on this image — POSIX CI carries the case
      return;
    }
    const before = fingerprintTree(world.root);
    // lstat identity BEFORE the run — fingerprintTree only records regular
    // files, so the reconciliation below cannot see a deleted/replaced pipe;
    // lstat (never opening it) closes that blind spot (r4 review).
    const fifoBefore = fs.lstatSync(fifoPath);
    expect(fifoBefore.isFIFO()).toBe(true);
    // 3s bound: the pre-fix probe would block forever on open(O_RDONLY) of a
    // writer-less FIFO and be killed with signal SIGTERM (status null).
    const run = runProbeWithTimeout(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir], 3_000);
    expect(run.signal).toBeNull(); // completed, not killed
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'TURN_BLOB_MISSING');
    expect(problem).toBeDefined();
    expect(problem.impact).toContain('not a regular file'); // FIFO classified via fstat, never read
    expect(codesOf(out, 'S01')).not.toContain('DIGEST_MISMATCH'); // FIFO content was never consumed
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED'); // no READY from an unreadable blob
    // The FIFO is still IN PLACE, still a FIFO, with unchanged file identity.
    const fifoAfter = fs.lstatSync(fifoPath);
    expect(fifoAfter.isFIFO()).toBe(true);
    expect(fifoAfter.dev).toBe(fifoBefore.dev);
    expect(fifoAfter.ino).toBe(fifoBefore.ino);
    // Nothing else touched, nothing new outside --out, temp state clean.
    const after = fingerprintTree(world.root);
    const stripOut = (tree: Map<string, { sha256: string; mtimeMs: number }>) =>
      new Map([...tree].filter(([rel]) => !rel.startsWith('probe-out/')));
    expect([...stripOut(before).keys()].sort()).toEqual([...stripOut(after).keys()].sort());
    for (const [rel, meta] of stripOut(before)) {
      expect(after.get(rel), `source file ${rel} unchanged`).toEqual(meta);
    }
  });
});

describe('r3 P2-01: fstat failure closes the opened fd exactly once (fault injection through the real CLI)', () => {
  const BLOB = `assistant-${'a'.repeat(64)}.txt`;
  // TEST_DIR already IS the fixtures dir (dirname of the helpers module).
  const PRELOAD = path.resolve(TEST_DIR, 'pd-lab-probe-fault-inject.cjs').replace(/\\/g, '/');

  function fdWorld() {
    return buildWorld('r3-fd', {
      sessions: [{ sessionId: 'sess-fd', startedAt: T0, userTurns: [{ turnIndex: 0, blobRef: BLOB }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-fd' }],
    });
  }

  it('open-success → fstat-throw → structured refusal, and closeSync called exactly once for the faulted fd', () => {
    const world = fdWorld();
    const logPath = path.join(world.root, 'close-log.txt');
    // The preload goes through CHILD ARGV (`--require <path>`), not
    // NODE_OPTIONS: Node splits NODE_OPTIONS on whitespace, so a preload
    // path containing a space would end the CLI before it starts (r4 review).
    const run = runProbeWithEnv(
      ['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir],
      {
        PRI1257_FAULT: 'fstat',
        PRI1257_FAULT_LOG: logPath,
      },
      ['--require', PRELOAD],
    );
    expect(run.status).toBe(0); // structured refusal — not a crash, not a hang
    const out = readOut(world.outDir);
    const problem = out.report.perSample[0].problems.find((p: { code: string }) => p.code === 'TURN_BLOB_MISSING');
    expect(problem).toBeDefined();
    expect(problem.impact).toContain('could not be verified/read'); // unreadable classification preserved
    expect(codesOf(out, 'S01')).not.toContain('DIGEST_MISMATCH'); // no content was consumed
    // The faulted descriptor was closed EXACTLY once (no leak, no double close).
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(log).toEqual(['FAULT_FD_CLOSE=1']);
  });

  it('the preload path itself may contain spaces — the argv form keeps the CLI startable (regression)', () => {
    // Reproduce the space-in-path condition: copy the preload and the probe
    // dependencies under a directory WITH a space, point --require there,
    // and verify the CLI still starts and completes (pre-fix: NODE_OPTIONS
    // splitting would kill it before main()).
    const world = fdWorld();
    const logPath = path.join(world.root, 'close-log.txt');
    const spacedDir = path.join(world.root, 'preload dir with spaces');
    fs.mkdirSync(spacedDir);
    const spacedPreload = path.join(spacedDir, 'pd-lab-probe-fault-inject.cjs');
    fs.copyFileSync(PRELOAD, spacedPreload);
    const run = runProbeWithEnv(
      ['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir],
      {
        PRI1257_FAULT: 'fstat',
        PRI1257_FAULT_LOG: logPath,
      },
      ['--require', spacedPreload], // path WITH spaces, single argv element
    );
    expect(run.status).toBe(0); // started and completed — space did not split the argv
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(log).toEqual(['FAULT_FD_CLOSE=1']);
  });
});

// ---------------------------------------------------------------------------
// r5 Case H — early turns removed by the REAL production retention sweeper
// (runTrajectoryRetentionBatches from @principles/core/runtime). The fixture
// only AGES the early rows (mirroring the passage of time); the deletion is
// always performed by the production logic, never by test-side DELETEs.
// ---------------------------------------------------------------------------

describe('r5 Case H: real retention sweep of early turns (real CLI subprocess)', () => {
  const CUTOFF = '2026-09-01T00:00:00.000Z'; // Sep rows survive, aged May rows are swept

  /**
   * Pain-first session: pain at 10:00 (creator), EARLY turn pair at
   * 10:01/10:01:30 (later aged + swept), LATER complete pair at
   * 10:06/10:06:30 (survive, contiguous), dataset pain at 10:08.
   */
  function sweepWorld(label: string) {
    const world = buildWorld(label, {
      sessions: [
        {
          sessionId: 'sess-swept',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [
            { turnIndex: 2, createdAt: '2026-09-01T10:01:00.000Z' },
            { turnIndex: 3, createdAt: '2026-09-01T10:06:00.000Z' },
          ],
          assistantTurns: [
            { createdAt: '2026-09-01T10:01:30.000Z' },
            { createdAt: '2026-09-01T10:06:30.000Z' },
          ],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-swept', createdAt: '2026-09-01T10:08:00.000Z' }],
      extraPainRows: [{ id: 900, sessionId: 'sess-swept', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    const db = new Database(path.join(world.snapshotDir, 'trajectory.db'));
    const earlyUser = db.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-swept' AND created_at = '2026-09-01T10:01:00.000Z'").get();
    const earlyAssistant = db.prepare("SELECT id FROM assistant_turns WHERE session_id = 'sess-swept' AND created_at = '2026-09-01T10:01:30.000Z'").get();
    db.close();
    return { world, earlyUser, earlyAssistant };
  }

  function ageAndSweep(world: { snapshotDir: string }, earlyUser: { id: number }, earlyAssistant: { id: number }) {
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    db.prepare('UPDATE user_turns SET created_at = ? WHERE id = ?').run('2026-05-01T10:01:00.000Z', earlyUser.id);
    db.prepare('UPDATE assistant_turns SET created_at = ? WHERE id = ?').run('2026-05-01T10:01:30.000Z', earlyAssistant.id);
    db.pragma('journal_mode = DELETE');
    db.close();
    const sweep = runRealRetentionSweep(dbPath, CUTOFF);
    expect(sweep.outcome).toBe('completed');
    expect(countSessionRows(dbPath, 'user_turns', 'sess-swept')).toBe(1);
    expect(countSessionRows(dbPath, 'assistant_turns', 'sess-swept')).toBe(1);
  }

  it('H1: a surviving immortal reference into the swept range → SOURCE_RETENTION_EXPIRED (positive evidence)', () => {
    const { world, earlyUser, earlyAssistant } = sweepWorld('r5-h1');
    // Production wrote this confirmation while the early turns existed; the
    // table is NOT swept, so the reference outlives them.
    plantSignalConfirmation(path.join(world.snapshotDir, 'trajectory.db'), {
      id: 'sc-h1',
      sessionId: 'sess-swept',
      userTurnRowid: earlyUser.id,
      referencesAssistantTurnId: earlyAssistant.id,
      createdAt: '2026-09-01T10:02:00.000Z',
    });
    ageAndSweep(world, earlyUser, earlyAssistant);

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.prefixCompleteness).toBe('PROVEN_INCOMPLETE');
    expect(codesOf(out, 'S01')).toContain('SOURCE_RETENTION_EXPIRED');
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    const problem = sample.problems.find((p: { code: string }) => p.code === 'SOURCE_RETENTION_EXPIRED');
    expect(problem.impact).toContain('reference turn rows that no longer exist');
  });

  it('H2: swept early turns with NO surviving reference → prefix UNKNOWN → SOURCE_GAP (never PROVEN_COMPLETE)', () => {
    const { world, earlyUser, earlyAssistant } = sweepWorld('r5-h2');
    ageAndSweep(world, earlyUser, earlyAssistant);

    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    // The pain row explains the start; the surviving window is internally
    // continuous — yet nothing distinguishes this snapshot from a complete
    // pain-first session, so the prefix verdict MUST be UNKNOWN and the
    // sample must NOT reach READY.
    expect(sample.sessionStartExplanation).toBe('EXPLAINED_BY_MANUAL_PAIN');
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED');
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: swept-but-unprovable prefix is disclosed, not blocking
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY'); // actual inputs (surviving rows + blobs) complete
  });
});

// ---------------------------------------------------------------------------
// r6 — proof hardening: evidence priority, timestamp-identity audit,
// recordSession-only states, legacy evidence-source coverage.
// ---------------------------------------------------------------------------

describe('r6 P1-a: dangling references outrank started_at equality (real sweeper, deterministic budget hook)', () => {
  it('assistant turn swept mid-run while the started_at-instant user turn survives → PROVEN_INCOMPLETE, never PROVEN_COMPLETE', () => {
    // Shape: user turn 1 AT the started_at instant (the equality branch's
    // exact precondition), assistant turn 1 (aged, swept), user turn 2
    // referencing assistant turn 1. The scripted clock lets the production
    // sweeper commit the assistant_turns batch and then exhaust the run
    // budget BEFORE the user_turns batch — the mid-sweep state the old
    // equality-first branch wrongly upgraded to PROVEN_COMPLETE.
    const world = buildWorld('r6-priority', {
      sessions: [
        {
          sessionId: 'sess-prio',
          startedAt: T0, // == user turn 1's instant
          userTurns: [
            { turnIndex: 2, createdAt: T0 },
            { turnIndex: 3, createdAt: '2026-09-01T10:06:00.000Z' },
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:00:30.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-prio', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    const assistant1 = db.prepare("SELECT id FROM assistant_turns WHERE session_id = 'sess-prio' AND created_at = '2026-09-01T10:00:30.000Z'").get();
    const user2 = db.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-prio' AND created_at = '2026-09-01T10:06:00.000Z'").get();
    db.prepare('UPDATE user_turns SET references_assistant_turn_id = ? WHERE id = ?').run(assistant1.id, user2.id);
    db.prepare("UPDATE assistant_turns SET created_at = '2026-05-01T10:00:30.000Z' WHERE id = ?").run(assistant1.id);
    db.close();

    // Scripted clock: calls 1-6 return 0 (start, tool batch, assistant batch
    // through its commit), call 7+ jumps past the budget — the user_turns
    // batch is never started. Deleted rows come ONLY from the production
    // sweeper.
    const sweep = runRealRetentionSweepWithHooks(dbPath, '2026-09-01T00:00:00.000Z', [0, 0, 0, 0, 0, 0, 1_000_000]);
    expect(sweep.deletedByTable.assistant_turns).toBe(1); // production sweeper removed the assistant row
    expect(countSessionRows(dbPath, 'assistant_turns', 'sess-prio')).toBe(0);
    expect(countSessionRows(dbPath, 'user_turns', 'sess-prio')).toBe(2); // budget exhausted first — both user turns survive

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    // started_at == the earliest surviving trajectory row (user turn 1) —
    // yet the dangling reference is the higher-priority evidence.
    expect(sample.prefixCompleteness).toBe('PROVEN_INCOMPLETE');
    expect(codesOf(out, 'S01')).toContain('SOURCE_RETENTION_EXPIRED');
    expect(sample.completeness).toBe('INCOMPLETE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    const problem = sample.problems.find((p: { code: string }) => p.code === 'SOURCE_RETENTION_EXPIRED');
    expect(problem.impact).toContain('reference turn rows that no longer exist');
  });
});

describe('r6 P1-b: timestamp equality and recordSession-only states are honestly UNKNOWN (real CLI subprocess)', () => {
  it('a deleted first-writer row sharing its timestamp with a survivor cannot be distinguished → UNKNOWN, no dangling refs', () => {
    // user turn 1 at 10:00 (the first writer) is aged and removed by the REAL
    // sweeper; user turn 2 keeps the SAME original instant 10:00 and
    // survives; there are no references. Timestamp equality with the earliest
    // surviving row holds — and must still be UNKNOWN (collisions).
    const world = buildWorld('r6-collision', {
      sessions: [
        {
          sessionId: 'sess-coll',
          startedAt: T0,
          userTurns: [{ turnIndex: 2, createdAt: T0 }, { turnIndex: 3, createdAt: T0 }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-coll', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    const first = db.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-coll' AND turn_index = 2").get();
    db.close();
    // Age ONLY the first writer; turn 2 keeps created_at == started_at.
    const aged = new Database(dbPath);
    aged.prepare('UPDATE user_turns SET created_at = ? WHERE id = ?').run('2026-05-01T10:00:00.000Z', first.id);
    aged.pragma('journal_mode = DELETE');
    aged.close();
    const sweep = runRealRetentionSweep(dbPath, '2026-09-01T00:00:00.000Z');
    expect(sweep.outcome).toBe('completed');
    expect(sweep.deletedByTable.user_turns).toBe(1);
    expect(countSessionRows(dbPath, 'user_turns', 'sess-coll')).toBe(1);

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const sample = readOut(world.outDir).report.perSample[0];
    // The survivor's created_at EQUALS started_at and equals the deleted
    // row's original instant — timestamp equality cannot identify the first
    // writer, so the verdict stays UNKNOWN even though a row WAS deleted.
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(codesOf(readOut(world.outDir), 'S01')).not.toContain('SOURCE_GAP'); // r7: disclosed, not blocking
    expect(codesOf(readOut(world.outDir), 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED');
  });

  it('a bare recordSession-style session start (no trajectory row at the start instant) is a legal state — UNEXPLAINED diff stays UNKNOWN', () => {
    // The prompt hook (prompt.ts:659) creates sessions via
    // recordSession({sessionId}) with no trajectory rows; the first turn
    // arrives later. The started_at diff therefore does NOT prove a swept
    // row — no dangling references exist here, so the verdict is UNKNOWN.
    const world = buildWorld('r6-bare', {
      sessions: [
        {
          sessionId: 'sess-bare',
          startedAt: '2026-09-01T10:00:00.000Z', // bare recordSession instant
          userTurns: [{ turnIndex: 2, createdAt: '2026-09-01T10:06:00.000Z' }, { turnIndex: 3, createdAt: '2026-09-01T10:07:00.000Z' }],
          assistantTurns: [{ createdAt: '2026-09-01T10:06:00.000Z' }, { createdAt: '2026-09-01T10:07:00.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-bare', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const sample = readOut(world.outDir).report.perSample[0];
    expect(sample.sessionStartExplanation).toBe('UNEXPLAINED');
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(codesOf(readOut(world.outDir), 'S01')).not.toContain('SOURCE_GAP'); // r7: disclosed, not blocking
    expect(codesOf(readOut(world.outDir), 'S01')).not.toContain('SOURCE_RETENTION_EXPIRED');
  });
});

describe('r6 P2: legacy snapshots missing optional evidence sources (real CLI subprocess)', () => {
  function healthyWorldWithOptionalDrops(label: string, drop: string[]) {
    const world = buildHealthyWorld(label);
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    for (const table of drop) {
      db.exec(`DROP TABLE ${table}`); // legacy snapshot shape
    }
    db.pragma('journal_mode = DELETE');
    db.close();
    return world;
  }

  it('A. snapshot without signal_confirmations completes; the source is disclosed and never read as zero', () => {
    const world = healthyWorldWithOptionalDrops('r6-nosc', ['signal_confirmations']);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0); // no batch crash
    const out = readOut(world.outDir);
    const scSource = out.report.snapshot.prefixEvidence.sources.find((s: { source: string }) => s.source.startsWith('signal_confirmations'));
    expect(scSource.available).toBe(false);
    expect(out.report.snapshot.prefixEvidence.coverageComplete).toBe(false);
    expect(out.report.perSample[0].prefixCompleteness).toBe('UNKNOWN'); // reduced coverage is never upgraded
    expect(codesOf(out, 'S01')).not.toContain('SOURCE_GAP'); // r7: coverage gap disclosed, not blocking
  });

  it('B. snapshot without correction_samples completes; the source is disclosed', () => {
    const world = healthyWorldWithOptionalDrops('r6-nocs', ['correction_samples']);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const csSource = out.report.snapshot.prefixEvidence.sources.find((s: { source: string }) => s.source.startsWith('correction_samples'));
    expect(csSource.available).toBe(false);
    expect(out.report.snapshot.prefixEvidence.coverageComplete).toBe(false);
    expect(out.report.perSample[0].prefixCompleteness).toBe('UNKNOWN');
  });

  it('C. both optional evidence tables missing → completes with both sources disclosed', () => {
    const world = healthyWorldWithOptionalDrops('r6-both', ['signal_confirmations', 'correction_samples']);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(out.report.snapshot.prefixEvidence.sources.filter((s: { available: boolean }) => !s.available).length).toBe(4);
    expect(out.report.snapshot.prefixEvidence.coverageComplete).toBe(false);
    expect(out.report.perSample[0].prefixCompleteness).toBe('UNKNOWN');
  });

  it('D. evidence table present but required column missing → source unavailable (legacy migration shape), no crash', () => {
    const world = buildHealthyWorld('r6-nocol');
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    // Recreate signal_confirmations WITHOUT the references column (legacy shape).
    db.exec('ALTER TABLE signal_confirmations RENAME TO signal_confirmations_legacy');
    db.exec(`CREATE TABLE signal_confirmations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_turn_rowid INTEGER NOT NULL UNIQUE,
      occurrence_id TEXT NOT NULL, excerpt TEXT NOT NULL, terms_json TEXT NOT NULL,
      suggested_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`);
    db.exec('DROP TABLE signal_confirmations_legacy');
    db.pragma('journal_mode = DELETE');
    db.close();
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const refSource = out.report.snapshot.prefixEvidence.sources.find((s: { source: string }) => s.source === 'signal_confirmations.references_assistant_turn_id');
    expect(refSource.available).toBe(false);
    expect(refSource.tableExists).toBe(true);
    expect(refSource.columnsPresent).toBe(false);
    const rowidSource = out.report.snapshot.prefixEvidence.sources.find((s: { source: string }) => s.source === 'signal_confirmations.user_turn_rowid');
    expect(rowidSource.available).toBe(true); // that column survived the legacy shape
    expect(out.report.perSample[0].prefixCompleteness).toBe('UNKNOWN');
  });

  it('E. partial coverage still catches a real dangling reference from an AVAILABLE source → PROVEN_INCOMPLETE', () => {
    const blobName = `assistant-${'7'.repeat(64)}.txt`;
    const world = buildWorld('r6-partial-e', {
      sessions: [
        {
          sessionId: 'sess-part',
          startedAt: T0,
          userTurns: [
            { turnIndex: 2, createdAt: T0 },
            { turnIndex: 3, createdAt: '2026-09-01T10:06:00.000Z', blobRef: blobName },
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:00:30.000Z' }],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-part', createdAt: '2026-09-01T10:08:00.000Z' }],
    });
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    const assistant1 = db.prepare("SELECT id FROM assistant_turns WHERE session_id = 'sess-part' AND created_at = '2026-09-01T10:00:30.000Z'").get();
    const user2 = db.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-part' AND created_at = '2026-09-01T10:06:00.000Z'").get();
    db.prepare('UPDATE user_turns SET references_assistant_turn_id = ? WHERE id = ?').run(assistant1.id, user2.id);
    db.prepare("UPDATE assistant_turns SET created_at = '2026-05-01T10:00:30.000Z' WHERE id = ?").run(assistant1.id);
    db.close();
    // Disable a DIFFERENT source (signal_confirmations dropped) — the
    // available user_turns source must still catch the dangling reference.
    const dropDb = new Database(dbPath);
    dropDb.exec('DROP TABLE signal_confirmations');
    dropDb.pragma('journal_mode = DELETE');
    dropDb.close();
    const sweep = runRealRetentionSweep(dbPath, '2026-09-01T00:00:00.000Z');
    expect(sweep.deletedByTable.assistant_turns).toBe(1);
    expect(countSessionRows(dbPath, 'user_turns', 'sess-part')).toBe(2);

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(out.report.snapshot.prefixEvidence.coverageComplete).toBe(false); // sc source missing
    expect(sample.prefixCompleteness).toBe('PROVEN_INCOMPLETE'); // positive evidence from the available source
    expect(codesOf(out, 'S01')).toContain('SOURCE_RETENTION_EXPIRED');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// r8 Final Closure — four targeted real-CLI matrices:
//   P1-01 session-bound host matrix (ingress fail-closed, ab-lib parity),
//   P1-02 tool-return evidence matrix (call ≠ output),
//   P1-03 EXPLICIT_AT_TIME visibility matrix,
//   P2   prefixCompletenessReason ↔ state/count consistency.
// ---------------------------------------------------------------------------

describe('r8 P1-01: session-bound host matrix — ingress fail-closed', () => {
  // One healthy session + one healthy expectation record (resolved,
  // historical visibleAt, NOT tool-dependent) + a full grant: the ONLY
  // variable across the matrix is host_kind.
  function hostWorld(label: string, hostKind: string) {
    const world = buildWorld(label, {
      sessions: [{ sessionId: 'sess-hostm', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-hostm', hostKind }],
    });
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', { S01: fullGrant('S01') });
    return { world, expFile, authFile };
  }

  it('host_kind=openclaw → the healthy path is unchanged (PIPELINE_REPLAY READY)', () => {
    const { world, expFile, authFile } = hostWorld('r8-host-openclaw', 'openclaw');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const sample = readOut(world.outDir).report.perSample[0];
    expect(codesOf(readOut(world.outDir), 'S01')).not.toContain('INGRESS_HOST_UNRESOLVABLE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
  });

  it('host_kind=null → PIPELINE_REPLAY BLOCKED with the structured ingress blocker; labeling stays READY on its own evidence', () => {
    const { world, expFile, authFile } = hostWorld('r8-host-null', 'openclaw');
    const dataset = JSON.parse(fs.readFileSync(world.datasetPath, 'utf8'));
    dataset.samples[0].painEvent.host_kind = null; // the real-dataset S01/S08 shape
    fs.writeFileSync(world.datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(sample.hostKind).toBe(''); // unknown attribution preserved — never converted to openclaw
    expect(codesOf(out, 'S01')).toContain('INGRESS_HOST_UNRESOLVABLE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual(['INGRESS_HOST_UNRESOLVABLE']);
    expect(sample.executableForDeclaredPath.PIPELINE_REPLAY).toBe(false);
    // The labeling path never goes through the CLI ingress — its verdict is
    // derived from its own (complete) evidence, NOT unconditionally blocked.
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
    expect(sample.pathBlockers.EXPECTATION_LABELING).toEqual([]);
    expect(sample.pathReadiness.BEHAVIOR_BRANCH).toBe('BLOCKED'); // ENVIRONMENT_UNAVAILABLE, its own reason
  });

  it('host_kind="" (empty string) → PIPELINE_REPLAY BLOCKED', () => {
    const { world, expFile, authFile } = hostWorld('r8-host-empty', '');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).toContain('INGRESS_HOST_UNRESOLVABLE');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    expect(out.report.perSample[0].pathBlockers.PIPELINE_REPLAY).toEqual(['INGRESS_HOST_UNRESOLVABLE']);
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('READY');
  });

  it('host_kind=codex (explicit non-openclaw) → PIPELINE_REPLAY BLOCKED, not NOT_EVALUATED', () => {
    const { world, expFile, authFile } = hostWorld('r8-host-codex', 'codex');
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).toContain('INGRESS_HOST_UNRESOLVABLE');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('BLOCKED');
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual(['INGRESS_HOST_UNRESOLVABLE']);
    expect(sample.notEvaluatedReason).toBeNull(); // judged, not skipped
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
  });

  it('negative controls cause no experiment-execution side effects: every source file stays byte-identical', () => {
    const { world, expFile, authFile } = hostWorld('r8-host-noeffects', 'codex');
    const before = fingerprintTree(world.root);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const after = fingerprintTree(world.root);
    // The only delta anywhere under the world root is the probe's own out dir
    // (fingerprintTree keys are root-relative with forward slashes).
    const outPrefix = 'probe-out/';
    const added = [...after.keys()].filter((p) => !before.has(p));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((p) => p.startsWith(outPrefix))).toBe(true);
    for (const [p, info] of before) {
      expect(after.get(p)).toEqual(info); // hash + mtime unchanged
    }
  });
});

describe('r8 P1-02: tool-return evidence matrix — a call is not an output', () => {
  function toolWorld(label: string, toolCalls: Array<{ paramsJson?: string; resultPreview?: string | null }>) {
    const world = buildWorld(label, {
      sessions: [{ sessionId: 'sess-tool', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }], toolCalls }],
      samples: [{ caseId: 'S01', sessionId: 'sess-tool' }],
    });
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
    });
    const authFile = writeJson(world.root, 'auth.json', { S01: fullGrant('S01') });
    return { world, expFile, authFile };
  }

  it('no tool calls at all → TOOL_RESULT_MISSING blocks labeling; replay keeps its independent verdict', () => {
    const { world, expFile, authFile } = toolWorld('r8-tool-nocalls', []);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).toContain('TOOL_RESULT_MISSING');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.pathBlockers.EXPECTATION_LABELING).toEqual(['TOOL_RESULT_MISSING']);
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY'); // replay does not depend on that expectation's tool output
    expect(sample.pathBlockers.PIPELINE_REPLAY).toEqual([]);
  });

  it('call with legal params but NO return (result_preview NULL) → TOOL_RESULT_MISSING blocks labeling; replay READY', () => {
    const { world, expFile, authFile } = toolWorld('r8-tool-noreturn', [{ paramsJson: '{}', resultPreview: null }]);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).toContain('TOOL_RESULT_MISSING');
    expect(codesOf(out, 'S01')).not.toContain('TOOL_RESULT_PREVIEW_ONLY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('only the 500-unit truncated preview → TOOL_RESULT_PREVIEW_ONLY keeps blocking (never misreported as MISSING)', () => {
    const truncated = `${'z'.repeat(497)}...`;
    const { world, expFile, authFile } = toolWorld('r8-tool-preview', [{ paramsJson: '{}', resultPreview: truncated }]);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).toContain('TOOL_RESULT_PREVIEW_ONLY');
    expect(codesOf(out, 'S01')).not.toContain('TOOL_RESULT_MISSING');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.pathBlockers.EXPECTATION_LABELING).toEqual(['TOOL_RESULT_PREVIEW_ONLY']);
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('a complete readable return (short non-truncated preview IS the full output) → normal evaluation, labeling READY', () => {
    const { world, expFile, authFile } = toolWorld('r8-tool-complete', [{ paramsJson: '{}', resultPreview: 'ok' }]);
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).not.toContain('TOOL_RESULT_MISSING');
    expect(codesOf(out, 'S01')).not.toContain('TOOL_RESULT_PREVIEW_ONLY');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('an expectation NOT depending on tool output is never blocked by any of the above shapes', () => {
    const world = buildWorld('r8-tool-independent', {
      sessions: [{ sessionId: 'sess-tool2', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }], toolCalls: [{ paramsJson: '{}', resultPreview: null }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-tool2' }],
    });
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: false },
    });
    const authFile = writeJson(world.root, 'auth.json', { S01: fullGrant('S01') });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).not.toContain('TOOL_RESULT_MISSING'); // not a global gap — expectation-scoped only
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('READY');
    expect(out.report.perSample[0].pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });
});

describe('r8 P1-03: EXPLICIT_AT_TIME visibility matrix', () => {
  function visWorld(label: string) {
    const world = buildWorld(label, {
      sessions: [{ sessionId: 'sess-vis', startedAt: T0, userTurns: [{ turnIndex: 0 }], assistantTurns: [{ createdAt: T0 }] }],
      samples: [{ caseId: 'S01', sessionId: 'sess-vis' }],
    });
    const authFile = writeJson(world.root, 'auth.json', { S01: fullGrant('S01') });
    return { world, authFile };
  }

  it('EXPLICIT_AT_TIME without visibleAt → EXPECTATION_VISIBILITY_UNPROVEN blocks labeling; replay unaffected', () => {
    const { world, authFile } = visWorld('r8-vis-missing');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true }, // no visibleAt
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).toContain('EXPECTATION_VISIBILITY_UNPROVEN');
    expect(codesOf(out, 'S01')).not.toContain('FUTURE_INFORMATION'); // unproven ≠ proven-future — the codes stay precise
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.pathBlockers.EXPECTATION_LABELING).toEqual(['EXPECTATION_VISIBILITY_UNPROVEN']);
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY'); // visibility only matters to labeling
  });

  it('EXPLICIT_AT_TIME with a FUTURE visibleAt → FUTURE_INFORMATION blocks labeling', () => {
    const { world, authFile } = visWorld('r8-vis-future');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: '2026-12-01T00:00:00.000Z' },
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).toContain('FUTURE_INFORMATION');
    expect(codesOf(out, 'S01')).not.toContain('EXPECTATION_VISIBILITY_UNPROVEN');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('BLOCKED');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('EXPLICIT_AT_TIME with an unparsable visibleAt → the whole run fails closed at load (the record is never evaluated)', () => {
    const { world, authFile } = visWorld('r8-vis-invalid');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: 'not-a-timestamp' },
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(1); // structural rejection — stronger than a per-sample verdict
    expect(stderrReason(run).reason).toBe('expectations_invalid_structure');
    expect(fs.existsSync(path.join(world.outDir, 'admission-report.json'))).toBe(false);
  });

  it('EXPLICIT_AT_TIME with a valid historical visibleAt → normal evaluation, labeling READY', () => {
    const { world, authFile } = visWorld('r8-vis-valid');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0 }, // at/before the trigger
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    const sample = out.report.perSample[0];
    expect(codesOf(out, 'S01')).not.toContain('EXPECTATION_VISIBILITY_UNPROVEN');
    expect(codesOf(out, 'S01')).not.toContain('FUTURE_INFORMATION');
    expect(sample.pathReadiness.EXPECTATION_LABELING).toBe('READY');
    expect(sample.pathReadiness.PIPELINE_REPLAY).toBe('READY');
  });

  it('RESEARCH_INFERENCE is never auto-upgraded or held to the visibility rule', () => {
    const { world, authFile } = visWorld('r8-vis-inference');
    const expFile = writeJson(world.root, 'exp.json', {
      S01: { expectationId: 'e', basis: 'RESEARCH_INFERENCE', resolved: true }, // no visibleAt by design
    });
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const out = readOut(world.outDir);
    expect(codesOf(out, 'S01')).not.toContain('EXPECTATION_VISIBILITY_UNPROVEN');
    expect(codesOf(out, 'S01')).not.toContain('FUTURE_INFORMATION');
    expect(out.report.perSample[0].expectationBasis).toBe('RESEARCH_INFERENCE');
    expect(out.report.perSample[0].pathReadiness.EXPECTATION_LABELING).toBe('READY');
  });
});

describe('r8 P2: prefixCompletenessReason matches the proven state and the reference counts', () => {
  it('PROVEN_INCOMPLETE → the reason discloses the positive dangling-reference evidence (sources × counts), never "no evidence found"', () => {
    // Minimal N1 shape: an immortal signal_confirmation pointing at an early
    // assistant turn that the REAL production sweeper then removes.
    const world = buildWorld('r8-reason-proven', {
      sessions: [
        {
          sessionId: 'sess-reason',
          startedAt: '2026-09-01T10:00:00.000Z',
          userTurns: [
            { turnIndex: 2, createdAt: '2026-09-01T10:01:00.000Z' },
            { turnIndex: 3, createdAt: '2026-09-01T10:06:00.000Z' },
          ],
          assistantTurns: [
            { createdAt: '2026-09-01T10:01:30.000Z' },
            { createdAt: '2026-09-01T10:06:30.000Z' },
          ],
        },
      ],
      samples: [{ caseId: 'S01', sessionId: 'sess-reason', createdAt: '2026-09-01T10:08:00.000Z' }],
      extraPainRows: [{ id: 900, sessionId: 'sess-reason', createdAt: '2026-09-01T10:00:00.000Z' }],
    });
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const db = new Database(dbPath);
    const earlyUser = db.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-reason' AND created_at = '2026-09-01T10:01:00.000Z'").get();
    const earlyAssistant = db.prepare("SELECT id FROM assistant_turns WHERE session_id = 'sess-reason' AND created_at = '2026-09-01T10:01:30.000Z'").get();
    db.close();
    plantSignalConfirmation(dbPath, {
      id: 'sc-reason',
      sessionId: 'sess-reason',
      userTurnRowid: earlyUser.id,
      referencesAssistantTurnId: earlyAssistant.id,
      createdAt: '2026-09-01T10:02:00.000Z',
    });
    const ageDb = new Database(dbPath);
    ageDb.prepare('UPDATE user_turns SET created_at = ? WHERE id = ?').run('2026-05-01T10:01:00.000Z', earlyUser.id);
    ageDb.prepare('UPDATE assistant_turns SET created_at = ? WHERE id = ?').run('2026-05-01T10:01:30.000Z', earlyAssistant.id);
    ageDb.pragma('journal_mode = DELETE');
    ageDb.close();
    const sweep = runRealRetentionSweep(dbPath, '2026-09-01T00:00:00.000Z');
    expect(sweep.outcome).toBe('completed');
    expect(countSessionRows(dbPath, 'assistant_turns', 'sess-reason')).toBe(1);

    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir]);
    expect(run.status).toBe(0);
    const sample = readOut(world.outDir).report.perSample[0];
    expect(sample.prefixCompleteness).toBe('PROVEN_INCOMPLETE');
    expect(sample.prefixCompletenessReason).toContain('positive vanished-row evidence found');
    expect(sample.prefixCompletenessReason).toContain('signal_confirmations.references_assistant_turn_id×1');
    expect(sample.prefixCompletenessReason).not.toContain('no positive vanished-row evidence was found'); // the P2 bug text
    // State, reason and count must agree.
    expect(sample.prefixMissingReferenceCount).toBeGreaterThanOrEqual(1);
    expect(sample.prefixCompletenessReason).toContain(`${sample.prefixMissingReferenceCount} dangling reference(s)`);
  });

  it('UNKNOWN → the reason names the missing identity anchor AND the absence of positive evidence; count is 0', () => {
    const world = buildHealthyWorld('r8-reason-unknown');
    const expFile = writeJson(world.root, 'exp.json', healthyExpectations());
    const authFile = writeJson(world.root, 'auth.json', healthyAuthorizations());
    const run = runProbe(['--dataset', world.datasetPath, '--snapshot', world.snapshotDir, '--out', world.outDir, '--expectations', expFile, '--authorizations', authFile]);
    expect(run.status).toBe(0);
    const sample = readOut(world.outDir).report.perSample[0];
    expect(sample.prefixCompleteness).toBe('UNKNOWN');
    expect(sample.prefixCompletenessReason).toContain('no first-writer identity anchor');
    expect(sample.prefixCompletenessReason).toContain('no positive vanished-row evidence was found');
    expect(sample.prefixCompletenessReason).not.toContain('positive vanished-row evidence found:');
    expect(sample.prefixMissingReferenceCount).toBe(0);
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
          // r6: this session's early assistant turn is removed by the REAL
          // production sweeper below, leaving a dangling immortal reference →
          // SOURCE_RETENTION_EXPIRED via positive identity evidence
          sessionId: 'sess-expired',
          startedAt: T0,
          userTurns: [
            { turnIndex: 0, createdAt: '2026-09-01T10:01:00.000Z', blobRef: blobA },
            { turnIndex: 1, createdAt: '2026-09-01T10:06:00.000Z', blobRef: blobB },
          ],
          assistantTurns: [{ createdAt: '2026-09-01T10:01:30.000Z' }],
        },
        {
          // broken tool pairing
          sessionId: 'sess-toolbreak',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: 'oops{', resultPreview: 'ok' }],
        },
        {
          // r8 P1-01: healthy session, but the sample below binds to it with
          // an EMPTY host_kind → the session-bound ingress is unresolvable
          sessionId: 'sess-nohost',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
        },
        {
          // r8 P1-02: a tool call with legal params but NO result — the
          // producer writes result_preview = NULL when there is no result
          sessionId: 'sess-noreturn',
          startedAt: T0,
          userTurns: [{ turnIndex: 0 }],
          assistantTurns: [{ createdAt: T0 }],
          toolCalls: [{ paramsJson: '{}', resultPreview: null }],
        },
      ],
      samples: [
        { caseId: 'C01', sessionId: 'sess-ok' }, // preview-only + expectation + authorization + env
        { caseId: 'C02', sessionId: 'sess-gone' }, // SOURCE_GAP
        { caseId: 'C03', sessionId: 'sess-expired', createdAt: PAIN_AT }, // RETENTION_EXPIRED (N1) + blob issues
        { caseId: 'C04', sessionId: 'sess-toolbreak', evidenceRefs: ['session:sess-nope'] }, // REFERENCE_UNAVAILABLE ×2
        { caseId: 'C05', sessionId: '' }, // PAIN_ANCHOR_MISSING
        { caseId: 'C06', sessionId: 'sess-nohost', hostKind: '' }, // r8 P1-01: INGRESS_HOST_UNRESOLVABLE
        { caseId: 'C07', sessionId: 'sess-noreturn' }, // r8 P1-02: TOOL_RESULT_MISSING (call without return)
      ],
      corruptManifestEntry: (entry: { ref: string; sha256: string }) => {
        if (entry.ref === blobB) {
          entry.sha256 = '0'.repeat(64); // DIGEST_MISMATCH for an existing file
        }
      },
      dropBlob: blobA, // manifest lists it, file removed → TURN_BLOB_MISSING
    });
    // Plant the immortal reference while the early assistant turn still
    // exists, then age that turn and remove it with the REAL production
    // sweeper — the reference dangles afterwards (N1 evidence).
    const dbPath = path.join(world.snapshotDir, 'trajectory.db');
    const refDb = new Database(dbPath);
    const earlyUser = refDb.prepare("SELECT id FROM user_turns WHERE session_id = 'sess-expired' AND created_at = '2026-09-01T10:01:00.000Z'").get();
    const earlyAssistant = refDb.prepare("SELECT id FROM assistant_turns WHERE session_id = 'sess-expired' AND created_at = '2026-09-01T10:01:30.000Z'").get();
    refDb.close();
    plantSignalConfirmation(dbPath, {
      id: 'sc-allcodes',
      sessionId: 'sess-expired',
      userTurnRowid: earlyUser.id,
      referencesAssistantTurnId: earlyAssistant.id,
      createdAt: '2026-09-01T10:02:00.000Z',
    });
    const ageDb = new Database(dbPath);
    ageDb.prepare("UPDATE assistant_turns SET created_at = '2026-05-01T10:01:30.000Z' WHERE id = ?").run(earlyAssistant.id);
    ageDb.close();
    const sweep = runRealRetentionSweep(dbPath, '2026-09-01T00:00:00.000Z');
    expect(sweep.outcome).toBe('completed');
    expect(sweep.deletedByTable.assistant_turns).toBe(1);

    const expFile = writeJson(world.root, 'exp.json', {
      C01: { basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
      C03: { basis: 'LATER_CLARIFICATION', resolved: true, visibleAt: '2026-12-01T00:00:00.000Z' }, // FUTURE_INFORMATION
      // r8 P1-03: EXPLICIT_AT_TIME without visibleAt — the claim is not
      // evidence → EXPECTATION_VISIBILITY_UNPROVEN
      C06: { basis: 'EXPLICIT_AT_TIME', resolved: true },
      // r8 P1-02: depends on tool output, but the only call has no return
      C07: { basis: 'EXPLICIT_AT_TIME', resolved: true, visibleAt: T0, dependsOnToolOutput: true },
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
    expect(codesOf(out, 'C03')).toContain('SOURCE_RETENTION_EXPIRED'); // N1: dangling immortal reference
    expect(codesOf(out, 'C03')).toContain('DIGEST_MISMATCH');
    expect(codesOf(out, 'C05')).toContain('PAIN_ANCHOR_MISSING');
    // r8 additions.
    expect(codesOf(out, 'C06')).toContain('INGRESS_HOST_UNRESOLVABLE'); // session-bound empty host
    expect(codesOf(out, 'C06')).toContain('EXPECTATION_VISIBILITY_UNPROVEN'); // EXPLICIT_AT_TIME without visibleAt
    expect(codesOf(out, 'C07')).toContain('TOOL_RESULT_MISSING'); // call present, return absent
  });
});
