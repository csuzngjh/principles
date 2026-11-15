/**
 * PD-SPEC-001 Phase 5 — blind packager quality gate tests.
 *
 * Fixtures are synthetic CANARY records + a synthetic full-fidelity dataset
 * (no real pain text anywhere). They verify the Phase 5 remediation contract:
 *  - ALL succeeded artifacts of a stage are collected (not just the last one),
 *    with per-attempt annotation;
 *  - dreamer candidate-set completeness is asserted from the candidates array
 *    length INSIDE each dreamer artifact;
 *  - sample metadata carries the FULL evidence note text from the
 *    full-fidelity dataset (redacted copies are refused);
 *  - blinding hardening: leaky fields are scrubbed, the recursive self-check
 *    detects arm/prompt-version/receipt/worktree material, the pack and the
 *    blind map are separate files, and a failed self-check writes nothing;
 *  - pairing is keyed by (sample, stage, rep): repeat rounds and missing
 *    sides are reported, never silently dropped.
 *
 * Run: cd experiment/prompt-v2/scripts && npx vitest run __tests__/pdspec001-blindpack.test.ts
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertFullFidelityDataset,
  buildBlindPack,
  buildSampleMeta,
  collectStageArtifacts,
  findBlindViolations,
  parsePerAgentFileName,
  parseRecordFileName,
  readRecordsDir,
  scrubLeakyFields,
  writeBlindPackFiles,
} from '../ab/ab-blindpack.mjs';

// ---------------------------------------------------------------------------
// CANARY fixtures (synthetic; no real pain text)
// ---------------------------------------------------------------------------

const STAGES = ['rootcause', 'distiller', 'router', 'dreamer', 'philosopher', 'scribe'] as const;
const FORMATION_STAGES = ['dreamer', 'philosopher', 'scribe'];

type Stage = (typeof STAGES)[number];

/** Production task-id shape: diag stages use `diag_<stage>-`, formation agents use `<agent>-`. */
function stageTaskId(sid: string, arm: string, rep: number, stage: Stage): string {
  return FORMATION_STAGES.includes(stage)
    ? `${stage}-task-${sid}-${arm}-r${rep}-prompt`
    : `diag_${stage}-task-${sid}-${arm}-r${rep}`;
}

function artifact(stage: Stage, sid: string, arm: string, rep: number, content: unknown, seq = 1) {
  const src = stageTaskId(sid, arm, rep, stage) + (seq > 1 ? `x${seq}` : '');
  return {
    artifact_id: `pi-art-${src}-${seq}`,
    artifact_kind: 'principle',
    source_task_id: src,
    content_json: typeof content === 'string' ? content : JSON.stringify(content),
    created_at: `2026-11-15T00:00:0${seq}Z`,
  };
}

function dreamerContent(candidates: unknown[]): string {
  return JSON.stringify({ candidates, contextRefs: ['CANARY-REF'], generatedAt: '2026-11-15T00:00:00Z' });
}

function fakeRecord(sid: string, arm: string, rep: number, opts: {
  stageArts?: Array<Stage>;
  dreamers?: Array<unknown[]>;
  runs?: Array<{ task_id: string; execution_status: string; attempt_number: number }>;
  armField?: string;
} = {}) {
  const taskId = `task-${sid}-${arm}-r${rep}`;
  const runs = opts.runs ?? [
    ...STAGES.map((stage) => ({ task_id: stageTaskId(sid, arm, rep, stage), execution_status: 'succeeded', attempt_number: 1 })),
    { task_id: taskId, execution_status: 'succeeded', attempt_number: 1 },
  ];
  const rec: Record<string, unknown> = {
    experimentPainId: sid,
    arm: opts.armField ?? arm,
    rep,
    status: 'incomplete',
    ingressMode: 'bound',
    newTaskId: taskId,
    artifacts: {
      runs,
      stageArtifacts: (opts.stageArts ?? []).map((stage) => artifact(stage, sid, arm, rep, { CANARY_MARKER: `${stage}-${arm}-r${rep}` })),
      formationArtifacts: (opts.dreamers ?? []).map((candidates, i) => artifact('dreamer', sid, arm, rep, dreamerContent(candidates), i + 1)),
      candidates: [],
    },
  };
  return rec;
}

function canarySample(id: string, overrides: Record<string, unknown> = {}) {
  return {
    experimentPainId: id,
    originalPainId: `orig-${id}`,
    sampleCategory: 'canary',
    painEvent: {
      id: `pain-${id}`,
      source: 'test_harness',
      severity: 'mild',
      reason: `CANARY-REASON-${id}`,
      text: `CANARY-PAIN-TEXT-${id}`,
    },
    diagnosisTarget: {
      sourcePainId: `orig-${id}`,
      evidence: [{ kind: 'behavior_trace', sourceRef: 'owner_reported:test', note: `CANARY-EVIDENCE-NOTE-${id} full untruncated fixture note` }],
      correctionEvidence: { text: `CANARY-CORRECTION-${id}` },
    },
    hasCorrectionEvidence: true,
    candidates: [{ candidate_id: `cand-${id}-1` }, { candidate_id: `cand-${id}-2` }],
    formation: [],
    evidenceRefs: ['owner_reported:test'],
    inclusionReason: 'canary',
    ...overrides,
  };
}

function canaryDataset(samples: Array<Record<string, unknown>>) {
  return { spec: 'PD-SPEC-001-canary', frozenAt: '2026-11-15T00:00:00Z', samples };
}

function entry(fileName: string, sid: string, arm: string, rep: number, rec: unknown, error: string | null = null) {
  return { fileName, sid, arm, rep, rec, error };
}

// ---------------------------------------------------------------------------
// Filename grammar
// ---------------------------------------------------------------------------

describe('record filename grammar', () => {
  it('parses rep0 and repeat rounds', () => {
    expect(parseRecordFileName('S01.v1.json')).toEqual({ sid: 'S01', arm: 'v1', rep: 0 });
    expect(parseRecordFileName('S02.v2.rep1.json')).toEqual({ sid: 'S02', arm: 'v2', rep: 1 });
    expect(parseRecordFileName('S14.v1.rep2.json')).toEqual({ sid: 'S14', arm: 'v1', rep: 2 });
  });

  it('rejects non-record files (run manifests, unknown arms, stage files)', () => {
    expect(parseRecordFileName('run-manifest.1db0368a.json')).toBeNull();
    expect(parseRecordFileName('S01.v3.json')).toBeNull();
    expect(parseRecordFileName('S01.distiller.v1.json')).toBeNull();
    expect(parseRecordFileName('S01.v1.json.bak')).toBeNull();
  });

  it('parses per-agent stage files including repeats', () => {
    expect(parsePerAgentFileName('S01.distiller.v1.json')).toEqual({ sid: 'S01', stage: 'distiller', arm: 'v1', rep: 0 });
    expect(parsePerAgentFileName('S07.router.v2.rep1.json')).toEqual({ sid: 'S07', stage: 'router', arm: 'v2', rep: 1 });
    expect(parsePerAgentFileName('S01.rootcause.v1.json')).toBeNull();
    expect(parsePerAgentFileName('S01.v1.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-stage artifact collection
// ---------------------------------------------------------------------------

describe('collectStageArtifacts', () => {
  it('collects ALL succeeded artifacts of the stage, not just the last one', () => {
    const rec = fakeRecord('S1', 'v1', 0, { stageArts: ['rootcause'] });
    rec.artifacts.stageArtifacts.push(artifact('rootcause', 'S1', 'v1', 0, { CANARY_MARKER: 'attempt-2' }, 2));
    rec.artifacts.stageArtifacts.push(artifact('distiller', 'S1', 'v1', 0, { CANARY_MARKER: 'distiller' }));
    const c = collectStageArtifacts(rec as never, 'rootcause');
    expect(c.attempts).toHaveLength(2);
    expect(c.attempts.map((a) => a.index)).toEqual([0, 1]);
    expect(c.attempts[0].content).toContain('r0');
    expect(c.attempts[1].content).toContain('attempt-2');
    expect(c.complete).toBe(true);
    // stage filter: distiller artifact not collected for rootcause
    const d = collectStageArtifacts(rec as never, 'distiller');
    expect(d.attempts).toHaveLength(1);
  });

  it('excludes artifacts whose source task has only failed runs (observable reason)', () => {
    const rec = fakeRecord('S1', 'v1', 0, {
      stageArts: ['router'],
      runs: [
        { task_id: stageTaskId('S1', 'v1', 0, 'router'), execution_status: 'failed', attempt_number: 1 },
        { task_id: stageTaskId('S1', 'v1', 0, 'router'), execution_status: 'failed', attempt_number: 2 },
        { task_id: 'task-S1-v1-r0', execution_status: 'succeeded', attempt_number: 1 },
      ],
    });
    const c = collectStageArtifacts(rec as never, 'router');
    expect(c.attempts).toHaveLength(0);
    expect(c.complete).toBe(false);
    expect(c.reasons.some((r) => r.includes('no succeeded run'))).toBe(true);
  });

  it('asserts dreamer candidate-set completeness from the candidates array INSIDE each artifact', () => {
    const rec = fakeRecord('S1', 'v2', 0, { dreamers: [[{ badDecision: 'A' }, { badDecision: 'B' }, { badDecision: 'C' }], [{ badDecision: 'D' }]] });
    const c = collectStageArtifacts(rec as never, 'dreamer');
    expect(c.attempts).toHaveLength(2);
    expect(c.attempts[0].candidateCount).toBe(3);
    expect(c.attempts[1].candidateCount).toBe(1);
    expect(c.candidateTotal).toBe(4);
    expect(c.complete).toBe(true);
  });

  it('marks dreamer artifacts with missing/empty inner candidates arrays incomplete (never silently dropped)', () => {
    const rec = fakeRecord('S1', 'v2', 0, { dreamers: [[{ badDecision: 'A' }]] });
    rec.artifacts.formationArtifacts.push(artifact('dreamer', 'S1', 'v2', 0, JSON.stringify({ noCandidates: true }), 2));
    const c = collectStageArtifacts(rec as never, 'dreamer');
    expect(c.attempts).toHaveLength(2);
    expect(c.attempts[1].candidateCount).toBeNull();
    expect(c.complete).toBe(false);
    expect(c.reasons.some((r) => r.includes('candidates array'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sample metadata + full-fidelity dataset guard
// ---------------------------------------------------------------------------

describe('sample metadata and full-fidelity guard', () => {
  it('carries the FULL evidence note text (no truncation) plus owner correction', () => {
    const s = canarySample('S9');
    const meta = buildSampleMeta(s);
    expect(meta.evidence).toHaveLength(1);
    expect(meta.evidence[0].note).toBe('CANARY-EVIDENCE-NOTE-S9 full untruncated fixture note');
    expect(meta.ownerCorrection).toBe('CANARY-CORRECTION-S9');
    expect(meta.painTextHead).toBe('CANARY-PAIN-TEXT-S9');
    expect(meta.evidenceRefs).toEqual(['owner_reported:test']);
  });

  it('refuses a redacted dataset copy (fail loud, not silent placeholder packing)', () => {
    const redacted = canaryDataset([canarySample('S1', {
      diagnosisTarget: {
        sourcePainId: 'orig-S1',
        evidence: [{ kind: 'behavior_trace', sourceRef: 'owner_reported:test', note: '«redacted sha256:b41ecc248005f855 len:28»' }],
        correctionEvidence: { text: '«redacted sha256:ac8a071a3f5ff649 len:28»' },
      },
    })]);
    expect(() => assertFullFidelityDataset(redacted as never)).toThrow(/REDACTED/);
    expect(() => buildBlindPack({ runId: 'run-1', dataset: redacted as never, fullRecords: [] })).toThrow(/REDACTED/);
  });
});

// ---------------------------------------------------------------------------
// Blinding hardening
// ---------------------------------------------------------------------------

describe('blinding hardening', () => {
  it('scrubs receipt/contract-version/prompt-version keys out of artifact content', () => {
    const content = JSON.stringify({
      schemaVersion: 'diagnostician-output-v2',
      summary: 'CANARY-SUMMARY',
      trustedContextReceipt: { schemaVersion: 'router-context-v2', taskId: 'CANARY' },
      pipelineContractVersion: '9.9.9-canary',
      nested: { promptVersion: 'v1', keep: 'CANARY-KEEP' },
    });
    const scrubbed = scrubLeakyFields(JSON.parse(content));
    expect(scrubbed.removed).toBe(3);
    expect(JSON.stringify(scrubbed.value)).not.toContain('Receipt');
    expect(JSON.stringify(scrubbed.value)).not.toContain('pipelineContractVersion');
    expect((scrubbed.value as Record<string, unknown>).nested).toEqual({ keep: 'CANARY-KEEP' });
    expect((scrubbed.value as Record<string, unknown>).summary).toBe('CANARY-SUMMARY');
  });

  it('detects arm-identity values, prompt-version tokens and leaky keys', () => {
    expect(findBlindViolations({ arm: 'v1' }, '$')).toHaveLength(2); // leaky key + arm value
    expect(findBlindViolations({ note: 'template: prompt.v1 changed' }, '$')).toHaveLength(1);
    expect(findBlindViolations({ meta: { trustedContextReceipt: { a: 1 } } }, '$')).toHaveLength(1);
    expect(findBlindViolations({ p: 'D:/Code/_worktrees/principles/adhoc-20261115-prompt-v2-k4wz9t' }, '$')).toHaveLength(1);
    expect(findBlindViolations({ v: 'pipelineContractVersion' }, '$')).toHaveLength(1);
  });

  it('does NOT flag domain content that merely discusses a v1/v2 subject', () => {
    expect(findBlindViolations({ note: 'CANARY: v1 失败的真实原因是参考图接线错误' }, '$')).toHaveLength(0);
    expect(findBlindViolations({ note: 'CANARY schemaVersion diagnostician-output-v2 is identical across arms' }, '$')).toHaveLength(0);
  });

  it('fails the build BEFORE writing when group-revealing material survives the scrub', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdspec001-blindfail-'));
    const outDir = path.join(tmp, 'blindpack');
    const tampered = {
      packages: [{ evalId: 'canary', stage: 'router', sample: { experimentPainId: 'S1', arm: 'v1' } }],
      blindMap: {}, missing: [], missingArmAware: [], missingCount: 0, byStage: {}, warnings: [],
    };
    expect(() => writeBlindPackFiles(outDir, tampered as never, { runId: 'run-1', paRunId: null })).toThrow(/self-check/);
    expect(fs.existsSync(outDir)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Pair assembly: (sample, stage, rep) keys, missing sides, blind map separation
// ---------------------------------------------------------------------------

describe('buildBlindPack pairing', () => {
  const dataset = canaryDataset([canarySample('S1'), canarySample('S2')]);

  it('packages rep0 pairs and reports missing rep1 sides instead of dropping them', () => {
    const fullRecords = [
      entry('S1.v1.json', 'S1', 'v1', 0, fakeRecord('S1', 'v1', 0, { stageArts: ['rootcause', 'router'] })),
      entry('S1.v2.json', 'S1', 'v2', 0, fakeRecord('S1', 'v2', 0, { stageArts: ['rootcause', 'router'] })),
      entry('S1.v1.rep1.json', 'S1', 'v1', 1, fakeRecord('S1', 'v1', 1, { stageArts: ['rootcause'] })),
      entry('S2.v2.json', 'S2', 'v2', 0, fakeRecord('S2', 'v2', 0, { stageArts: ['router'] })),
    ];
    const result = buildBlindPack({ runId: 'run-1', dataset, fullRecords });

    // rep0 pairs exist for S1 (rootcause, router)
    const s1Rootcause = result.packages.filter((p) => p.sid === 'S1' && p.stage === 'rootcause' && p.rep === 0);
    expect(s1Rootcause).toHaveLength(1);
    expect(s1Rootcause[0].source).toBe('full-chain');
    // S2 has only a v2 record → no package, missing reported
    expect(result.packages.some((p) => p.sid === 'S2')).toBe(false);
    const s2Missing = result.missing.filter((m) => m.sid === 'S2');
    expect(s2Missing.length).toBeGreaterThanOrEqual(1);
    // rep1: v1 record exists, v2 missing → missing reported, never a silent drop
    const rep1Missing = result.missing.filter((m) => m.rep === 1);
    expect(rep1Missing).toHaveLength(6); // all six stages
    // neutral missing list ships in packages.json WITHOUT arm names
    expect(JSON.stringify(result.missing)).not.toMatch(/"missingArm"/);
    // arm-aware detail ships only in the operator-side structure
    expect(result.missingArmAware.some((m) => m.rep === 1 && m.missingArm === 'v2')).toBe(true);
    // every package has exactly one blind-map entry (separate authority)
    expect(Object.keys(result.blindMap)).toHaveLength(result.packages.length);
  });

  it('keeps repeat-round pairs distinct (rep is part of the pair key and evalId)', () => {
    const fullRecords = [
      entry('S1.v1.json', 'S1', 'v1', 0, fakeRecord('S1', 'v1', 0, { stageArts: ['router'] })),
      entry('S1.v2.json', 'S1', 'v2', 0, fakeRecord('S1', 'v2', 0, { stageArts: ['router'] })),
      entry('S1.v1.rep1.json', 'S1', 'v1', 1, fakeRecord('S1', 'v1', 1, { stageArts: ['router'] })),
      entry('S1.v2.rep1.json', 'S1', 'v2', 1, fakeRecord('S1', 'v2', 1, { stageArts: ['router'] })),
    ];
    const result = buildBlindPack({ runId: 'run-1', dataset, fullRecords });
    const routerPkgs = result.packages.filter((p) => p.stage === 'router');
    expect(routerPkgs).toHaveLength(2);
    expect(new Set(routerPkgs.map((p) => p.rep))).toEqual(new Set([0, 1]));
    expect(new Set(routerPkgs.map((p) => p.evalId))).toHaveLength(2);
  });

  it('annotates multi-attempt stage outputs and keeps the primary representative', () => {
    const rec = fakeRecord('S1', 'v1', 0, { stageArts: ['rootcause'] });
    rec.artifacts.stageArtifacts.push(artifact('rootcause', 'S1', 'v1', 0, { CANARY_MARKER: 'attempt-2' }, 2));
    const fullRecords = [
      entry('S1.v1.json', 'S1', 'v1', 0, rec),
      entry('S1.v2.json', 'S1', 'v2', 0, fakeRecord('S1', 'v2', 0, { stageArts: ['rootcause'] })),
    ];
    const result = buildBlindPack({ runId: 'run-1', dataset, fullRecords });
    const pkg = result.packages.find((p) => p.stage === 'rootcause')!;
    expect([pkg.attemptsA.length, pkg.attemptsB.length].sort()).toEqual([1, 2]);
    const twoSide = pkg.attemptsA.length === 2 ? pkg.attemptsA : pkg.attemptsB;
    expect(twoSide.map((a) => a.index)).toEqual([0, 1]);
    expect(String(twoSide[1].content)).toContain('attempt-2');
    // primary output for a multi-artifact stage is the annotated collection
    const primary = pkg.attemptsA.length === 2 ? pkg.outputA : pkg.outputB;
    const parsed = JSON.parse(String(primary));
    expect(parsed.artifactCount).toBe(2);
    expect(parsed.artifacts).toHaveLength(2);
  });

  it('carries dreamer candidate counts through to the package completeness block', () => {
    const fullRecords = [
      entry('S1.v1.json', 'S1', 'v1', 0, fakeRecord('S1', 'v1', 0, { dreamers: [[{ b: 'a' }, { b: 'b' }], [{ b: 'c' }]] })),
      entry('S1.v2.json', 'S1', 'v2', 0, fakeRecord('S1', 'v2', 0, { dreamers: [[{ b: 'd' }]] })),
    ];
    const result = buildBlindPack({ runId: 'run-1', dataset, fullRecords });
    const pkg = result.packages.find((p) => p.stage === 'dreamer')!;
    const counts = [pkg.completeness.A.candidateCount, pkg.completeness.B.candidateCount].sort();
    expect(counts).toEqual([1, 3]);
    expect(pkg.completeness.A.complete).toBe(true);
    expect(pkg.completeness.B.complete).toBe(true);
    // the primary output carries the FULL candidate set (both artifacts for the 3-candidate side)
    const threeSidePrimary = pkg.completeness.A.candidateCount === 3 ? pkg.outputA : pkg.outputB;
    expect(String(threeSidePrimary)).toContain('artifactCount');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: read from disk, write pack + separate blind map
// ---------------------------------------------------------------------------

describe('readRecordsDir + writeBlindPackFiles', () => {
  it('writes packages.json (leak-free) and a SEPARATE blindmap.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdspec001-blindpack-'));
    try {
      const recordsDir = path.join(tmp, 'records');
      fs.mkdirSync(recordsDir, { recursive: true });
      fs.writeFileSync(path.join(recordsDir, 'S1.v1.json'), JSON.stringify(fakeRecord('S1', 'v1', 0, { stageArts: ['router'], dreamers: [[{ b: 'a' }]] })));
      fs.writeFileSync(path.join(recordsDir, 'S1.v2.json'), JSON.stringify(fakeRecord('S1', 'v2', 0, { stageArts: ['router'], dreamers: [[{ b: 'b' }]] })));
      fs.writeFileSync(path.join(recordsDir, 'run-manifest.deadbeef.json'), '{"not":"a record"}');

      const fullRecords = readRecordsDir(recordsDir, parseRecordFileName);
      expect(fullRecords).toHaveLength(2);
      expect(fullRecords[0].rec).toBeTruthy();

      const dataset = canaryDataset([canarySample('S1', {
        // leak attempts inside dataset metadata must be caught, not packed
      })]);
      const result = buildBlindPack({ runId: 'run-canary', dataset, fullRecords });
      // rootcause stage artifacts absent on both sides → missing, not silently skipped
      expect(result.packages.some((p) => p.stage === 'rootcause')).toBe(false);
      expect(result.missing.some((m) => m.stage === 'rootcause')).toBe(true);

      const written = writeBlindPackFiles(path.join(tmp, 'blindpack'), result, { runId: 'run-canary', paRunId: null });
      expect(fs.existsSync(written.packagesPath)).toBe(true);
      expect(fs.existsSync(written.blindMapPath)).toBe(true);

      const packagesRaw = fs.readFileSync(written.packagesPath, 'utf8');
      for (const re of [/armA/i, /armB/i, /"arm"/, /trustedContextReceipt/i, /pipelineContractVersion/i, /promptVersion/i, /_worktrees/i, /prompt[\s._-]?v[12]/i]) {
        expect(re.test(packagesRaw)).toBe(false);
      }
      // the blind map is a separate file and DOES carry the arm mapping
      const blindRaw = fs.readFileSync(written.blindMapPath, 'utf8');
      expect(blindRaw).toContain('armA');
      expect(blindRaw).toContain('armB');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scrubs leaky fields inside artifact content before packing', () => {
    const leaky = JSON.stringify({
      summary: 'CANARY-SUMMARY',
      trustedContextReceipt: { taskId: 'CANARY' },
      pipelineContractVersion: '9.9.9-canary',
      detail: { promptVersion: 'v1', keep: 'CANARY-KEEP' },
    });
    const rec = fakeRecord('S1', 'v1', 0, { stageArts: ['router'] });
    rec.artifacts.stageArtifacts[0].content_json = leaky;
    const fullRecords = [
      entry('S1.v1.json', 'S1', 'v1', 0, rec),
      entry('S1.v2.json', 'S1', 'v2', 0, fakeRecord('S1', 'v2', 0, { stageArts: ['router'] })),
    ];
    const result = buildBlindPack({ runId: 'run-1', dataset: canaryDataset([canarySample('S1')]), fullRecords });
    const pkg = result.packages.find((p) => p.stage === 'router')!;
    const v1Side = pkg.attemptsA.find((a) => String(a.content).includes('CANARY-SUMMARY')) ?? pkg.attemptsB.find((a) => String(a.content).includes('CANARY-SUMMARY'));
    expect(v1Side).toBeTruthy();
    expect(String(v1Side!.content)).not.toContain('Receipt');
    expect(String(v1Side!.content)).not.toContain('pipelineContractVersion');
    expect(String(v1Side!.content)).toContain('CANARY-KEEP');
    // scrubbing is observable on the side that carried the leaky fixture
    const leakyInA = pkg.attemptsA.some((a) => a.content.includes('CANARY-SUMMARY'));
    expect((leakyInA ? pkg.completeness.A : pkg.completeness.B).scrubbedKeyCount).toBe(3);
  });
});
