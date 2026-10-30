// SPEC-PD-EXAMINER-001 v0.4 §6.4/§12.4 + Linear PRI-1037 — isolation probe
// offline acceptance suite.
//
// 100% offline: every host round is an injected double, every rollout is a
// fabricated fixture under a TMP codexHome. Green here proves the ENGINE,
// the EVIDENCE CONTRACT and the F2 GATE WIRING only — it is never real-host
// acceptance (the honest executedIn marker keeps offline evidence out of F2
// authorization, machine-checked). The real-host probe round remains NOT_RUN
// pending its own Owner authorization (the PRI-1037 ticket itself forbids
// auto-initiating model calls).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runIsolationProbe,
  saveProbeEvidence,
  verifyF2ProbeEvidence,
  ISOLATION_PROBE_CHECK_IDS,
  ISOLATION_PROBE_SCHEMA,
} from '../dev/principle-learning-lab/lib/challenge-isolation-probe.mjs';
import { runChallengeStudy, verifyFrozenStudy } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { createChallengeLedger } from '../dev/principle-learning-lab/lib/challenge-ledger.mjs';
import { createHostActorAdapter, createRealModelActor, hostTaskIdForUnit } from '../dev/principle-learning-lab/lib/challenge-actor-transport.mjs';
import { STAGE_R_AUTH_SCHEMA } from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';
import { readRolloutEvidenceForSession } from '../dev/principle-learning-lab/lib/host-actor.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realStudyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
// Run-scoped managed temp storage keeps yesterday's fixed session ids from
// corroborating an empty home or making today's rollout ambiguous.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-probe-tests-'));
// fixed evidence location inside every study copy (the module's own contract)
const EVIDENCE_REL = 'isolation-probes/PRI-1037.json';

/** Boundary-checked file read/write helpers: every dynamic path is resolved
 *  against its root and verified to stay INSIDE that root. */
function readInside(rootDir: string, rel: string): any {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`test helper: path escapes root (${rel})`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
function writeInside(rootDir: string, rel: string, content: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) throw new Error(`test helper: path escapes root (${rel})`);
  fs.writeFileSync(target, content, 'utf8');
}
function appendInside(rootDir: string, rel: string, content: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) throw new Error(`test helper: path escapes root (${rel})`);
  fs.appendFileSync(target, content, 'utf8');
}

const FROZEN = {
  studyId: 'CEB-001',
  suiteHash: 'e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  graderHash: 'eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79',
};
const NOW = Date.now();
const NOW_ISO = '2026-10-26T12:00:00Z';
const CASE_ID = 'CEB-001-FV-01';

let copyCounter = 0; // per-run tag counter (study copies); codex homes are mkdtemp (fresh per run)
function copyStudy(tag: string): string {
  const dir = path.join(tmpRoot, `${tag}-${++copyCounter}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(realStudyDir, dir, { recursive: true });
  return dir;
}
const judgeOf = (caseId: string) => readInside(realStudyDir, path.join('judge-only', `${caseId}.json`));

/** A well-behaved-or-hostile probe host double. Every knob maps to one
 *  check's failure mode; defaults refuse everything honestly. */
function probeHostDouble({ leak = null, executeClaimRound = null, sessionMode = 'distinct', identityStatus = 'VERIFIED', failRound = null }: any = {}) {
  let n = 0;
  return {
    kind: 'probe-host-double(wiring-only)',
    rounds: [] as any[],
    async complete(req: any) {
      const i = ++n;
      this.rounds.push(req);
      if (failRound === i) throw new Error('probe round transport exploded');
      let payload: any;
      if (leak && i === 1) payload = { executed: false, refusalReason: 'refuse', smuggled: leak };
      else if (executeClaimRound === i) payload = { executed: true, output: 'performed the requested action' };
      else payload = { executed: false, refusalReason: 'isolated exam participant refuses examiner-private access' };
      const sessionId = sessionMode === 'distinct' ? `probe-s${i}` : 'probe-fixed-session';
      return {
        payload,
        runId: `${sessionId}#r${i}`,
        hostRound: { sessionId, roundNo: i, opportunityId: req.taskId, usage: null, exitCode: 0, wallMs: 1, toolCallsObserved: 0, malformedLines: 0 },
      };
    },
    hostSnapshot() {
      return {
        requestedModel: 'test-double/never-real',
        identityStatus,
        observedModel: identityStatus === 'MODEL_IDENTITY_UNVERIFIED' ? null : 'test-double/never-real',
        identityEvidenceSource: 'test-double',
      };
    },
  };
}
const cleanScanner = () => ({ crossGroupLeakage: 0, productionWrites: 0, externalSideEffects: 0 });

/** Fabricate a host rollout (the host's own artifact class) for one session
 *  under a TMP codexHome, dated with the REAL current UTC day (the reader
 *  searches today/yesterday). Wiring-fixture only — fabricating these in a
 *  test tmp dir is the documented cooperative boundary, never real-host
 *  evidence. */
function fabricateRollout(codexHome: string, sessionId: string, model = 'test-double/never-real', d = new Date()) {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, ''); // filename whitelist
  if (safe.length === 0) throw new Error('fabricateRollout: sessionId sanitizes to empty');
  const dayRel = path.join('sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(path.join(codexHome, dayRel), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model } } }),
  ];
  appendInside(codexHome, path.join(dayRel, `rollout-${safe}.jsonl`), `${lines.join('\n')}\n`);
}

/** Write a full-PASSED real-host probe evidence file + corroborating rollouts
 *  into a study copy. Test fixture — the honest-boundary twin of what the
 *  real authorized probe round will produce. */
function writeProbeEvidence(dir: string, codexHome: string, over: Record<string, any> = {}) {
  const sessions = ['probe-s1', 'probe-s2', 'probe-s3', 'probe-s4', 'probe-s5'];
  const record = {
    schema: ISOLATION_PROBE_SCHEMA,
    probeId: 'PRI-1037',
    executedIn: 'real-host',
    studyId: FROZEN.studyId,
    suiteHash: FROZEN.suiteHash,
    executedAt: new Date(NOW).toISOString(),
    checks: ISOLATION_PROBE_CHECK_IDS.map((id) => ({ id, status: 'PASSED' })),
    sessions,
    hostSnapshotAudit: { requestedModel: 'test-double/never-real', observedModel: 'test-double/never-real', identityStatus: 'VERIFIED', identityEvidenceSource: 'test-double' },
    status: 'PASSED',
    ...over,
  };
  const ref = saveProbeEvidence(dir, record);
  for (const s of sessions) fabricateRollout(codexHome, s);
  return { ref, record };
}

function validF2Auth(over: Record<string, any> = {}) {
  const manifest = readInside(realStudyDir, 'suite-manifest.json');
  return {
    schema: STAGE_R_AUTH_SCHEMA,
    stage: 'R',
    status: 'APPROVED',
    studyId: FROZEN.studyId,
    suiteHash: FROZEN.suiteHash,
    mappingHash: FROZEN.mappingHash,
    graderHash: FROZEN.graderHash,
    studyPlanHash: readInside(realStudyDir, 'hashes.json').preregistrationHash.value,
    requestedActorIdentity: 'test-double/never-real',
    executionMode: 'F2-real-host',
    arms: ['A'],
    cases: manifest.cases.map((c: any) => c.caseId),
    repetitions: ['1'],
    attemptCap: 40,
    requestCap: 200,
    isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: EVIDENCE_REL, suiteHash: FROZEN.suiteHash } },
    issuedBy: 'owner-test-fixture',
    validFrom: '2026-10-26T00:00:00Z',
    validUntil: '2026-10-27T00:00:00Z',
    revoked: false,
    halted: false,
    ...over,
  };
}

// ===========================================================================
// A. probe engine (injected doubles)
// ===========================================================================
describe('A. isolation probe engine', () => {
  it('A1: a well-behaved host passes every SPEC §6.4 check; the record is complete, honest (offline-rehearsal) and persistable', async () => {
    const dir = copyStudy('engine-clean');
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble(), mode: 'offline-rehearsal', now: NOW, sideEffectScanner: cleanScanner });
    expect(record.status).toBe('PASSED');
    expect(record.executedIn).toBe('offline-rehearsal');
    expect(record.checks.map((c: any) => c.id).sort()).toEqual([...ISOLATION_PROBE_CHECK_IDS].sort());
    expect(record.checks.every((c: any) => c.status === 'PASSED')).toBe(true);
    expect(new Set(record.sessions).size).toBe(5);
    const ref = saveProbeEvidence(dir, record);
    expect(ref).toBe(EVIDENCE_REL);
    expect(readInside(dir, EVIDENCE_REL).status).toBe('PASSED');
  });

  it('A2: a host that smuggles judge-only gold content FAILS the hidden-gold check (leak detection is content-grounded)', async () => {
    const dir = copyStudy('engine-leak');
    const judgeText = JSON.stringify(judgeOf(CASE_ID));
    const hexRun = (judgeText.match(/[0-9a-f]{32,}/) || [''])[0];
    expect(hexRun.length).toBeGreaterThanOrEqual(32);
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble({ leak: hexRun }), now: NOW, sideEffectScanner: cleanScanner });
    const gold = record.checks.find((c: any) => c.id === 'hidden-gold-unreadable');
    expect(gold.status).toBe('FAILED');
    expect(gold.reason).toContain('gold-file content');
    expect(record.status).toBe('FAILED');
  });

  it('A3: a host that CLAIMS to execute a non-experiment tool FAILS the refusal check', async () => {
    const dir = copyStudy('engine-tool');
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble({ executeClaimRound: 4 }), now: NOW, sideEffectScanner: cleanScanner });
    const tool = record.checks.find((c: any) => c.id === 'non-experiment-tool-refusal');
    expect(tool.status).toBe('FAILED');
    expect(record.status).toBe('FAILED');
  });

  it('A4: session reuse across probe rounds FAILS session-independence (independent scratch/Oracle state is transport-provable)', async () => {
    const dir = copyStudy('engine-sessions');
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble({ sessionMode: 'fixed' }), now: NOW, sideEffectScanner: cleanScanner });
    const sess = record.checks.find((c: any) => c.id === 'session-independence');
    expect(sess.status).toBe('FAILED');
    expect(sess.reason).toContain('REUSED');
  });

  it('A5: an UNVERIFIED host identity FAILS the attestation check (requested-echo is never attestation)', async () => {
    const dir = copyStudy('engine-identity');
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble({ identityStatus: 'MODEL_IDENTITY_UNVERIFIED' }), now: NOW, sideEffectScanner: cleanScanner });
    const idCheck = record.checks.find((c: any) => c.id === 'host-identity-attested');
    expect(idCheck.status).toBe('FAILED');
    expect(record.status).toBe('FAILED');
  });

  it('A6: a missing side-effect scanner fails CLOSED (unproven ≠ clean)', async () => {
    const dir = copyStudy('engine-noscan');
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble(), now: NOW }); // no scanner
    const scan = record.checks.find((c: any) => c.id === 'post-run-side-effect-scan');
    expect(scan.status).toBe('FAILED');
    expect(scan.reason).toContain('fail-closed');
    expect(record.status).toBe('FAILED');
  });

  it('A7: a transport round that explodes fails that round AND session-independence — never crashes the probe', async () => {
    const dir = copyStudy('engine-explode');
    const record = await runIsolationProbe({ studyDir: dir, hostTransport: probeHostDouble({ failRound: 2 }), now: NOW, sideEffectScanner: cleanScanner });
    expect(record.checks.some((c: any) => c.id === 'scoring-rules-unreadable' && c.status === 'FAILED')).toBe(true);
    expect(record.checks.find((c: any) => c.id === 'session-independence').status).toBe('FAILED');
    expect(record.status).toBe('FAILED');
  });
});

// ===========================================================================
// B. F2 evidence verification (the gate's deep second line)
// ===========================================================================
describe('B. verifyF2ProbeEvidence', () => {
  it('B1: offline-rehearsal evidence can NEVER authorize F2 — the honest marker is machine-enforced', () => {
    const dir = copyStudy('verify-offline');
    const codexHome = fs.mkdtempSync(path.join(tmpRoot, 'codex-'));
    writeProbeEvidence(dir, codexHome, { executedIn: 'offline-rehearsal' });
    const v = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('offline-rehearsal evidence can NEVER authorize F2');
  });

  it('B2: real-host evidence without rollout corroboration is refused (record fields alone authorize nothing)', () => {
    const dir = copyStudy('verify-norollout');
    const rolloutsHome = fs.mkdtempSync(path.join(tmpRoot, 'codex-')); // rollouts land here…
    const verifyHome = fs.mkdtempSync(path.join(tmpRoot, 'codex-')); // …but F2 verifies against THIS empty home
    fs.mkdirSync(verifyHome, { recursive: true });
    writeProbeEvidence(dir, rolloutsHome);
    const v = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome: verifyHome });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('not corroborated');
  });

  it('B3: real-host evidence WITH corroborated rollouts verifies (wiring proof; fabrication boundary documented); missing codexHome fails closed', () => {
    const dir = copyStudy('verify-ok');
    const codexHome = fs.mkdtempSync(path.join(tmpRoot, 'codex-'));
    writeProbeEvidence(dir, codexHome);
    const v = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome });
    expect(v).toMatchObject({ ok: true, reasons: [] });
    const v2 = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash } });
    expect(v2.ok).toBe(false);
    expect(v2.reasons.join(' ')).toContain('codexHome not provided');
  });

  it('B4: corrupt, missing, null, wrong-schema, traversal-style, mismatched and partially-failed evidence all refuse (boundary guard: only the fixed in-study evidence path is ever read)', () => {
    const dir = copyStudy('verify-bad');
    const codexHome = fs.mkdtempSync(path.join(tmpRoot, 'codex-'));
    const expectRefused = (v: { ok: boolean; reasons: string[] }) => { expect(v.ok).toBe(false); expect(v.reasons.length).toBeGreaterThan(0); };
    // missing file
    expectRefused(verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: 'isolation-probes/absent.json', expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome }));
    // corrupt json (overwrite the fixed evidence path)
    writeProbeEvidence(dir, codexHome);
    writeInside(dir, EVIDENCE_REL, '{ corrupt');
    expectRefused(verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome }));
    // null record — JSON.parse('null') is a legal JSON document and must be refused without crashing the verifier
    saveProbeEvidence(dir, null);
    const vNull = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome });
    expectRefused(vNull);
    expect(vNull.reasons.join(' ')).toContain('schema must be');
    // wrong schema id — every other field real (and corroborated), still refused on the contract id
    writeProbeEvidence(dir, codexHome, { schema: 'some-other-contract.v9' });
    const vSchema = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome });
    expectRefused(vSchema);
    expect(vSchema.reasons.join(' ')).toContain('schema must be');
    // traversal-style ref — the module rejects it BEFORE any path resolution (its own boundary guard)
    const vTraversal = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: 'isolation-probes/../../outside.json', expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome });
    expectRefused(vTraversal);
    expect(vTraversal.reasons.join(' ')).toContain('must be a relative path inside the study directory');
    // suite mismatch
    writeProbeEvidence(dir, codexHome, { suiteHash: 'f'.repeat(64) });
    expectRefused(verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome }));
    // one check failed
    writeProbeEvidence(dir, codexHome, { checks: ISOLATION_PROBE_CHECK_IDS.map((id) => ({ id, status: id === 'cross-arm-isolation' ? 'FAILED' : 'PASSED' })) });
    expectRefused(verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome }));
    // timezone-less executedAt (strict ISO rule shared with the gate)
    writeProbeEvidence(dir, codexHome, { executedAt: '2026-10-26T12:00:00' });
    expectRefused(verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome }));
  });

  it('B5: two rollouts claiming one session across UTC days remain ambiguous and cannot authorize F2', () => {
    const dir = copyStudy('verify-ambiguous');
    const codexHome = path.join(tmpRoot, `codex-${++copyCounter}`);
    writeProbeEvidence(dir, codexHome);
    const now = new Date();
    fabricateRollout(codexHome, 'probe-s1', 'test-double/never-real', new Date(now.getTime() - 86_400_000));
    const evidence = readRolloutEvidenceForSession({ codexHome, sessionId: 'probe-s1', now });
    expect(evidence).toMatchObject({ found: false, ambiguous: true });
    expect(evidence.files).toHaveLength(2);
    const v = verifyF2ProbeEvidence({ studyDir: dir, evidenceRef: EVIDENCE_REL, expected: { studyId: FROZEN.studyId, suiteHash: FROZEN.suiteHash }, codexHome });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain("probe session 'probe-s1' is not corroborated");
  });
});

// ===========================================================================
// C. runner integration — F2 refuses without authoritative evidence; passes with it
// ===========================================================================
describe('C. Stage R runner F2 integration', () => {
  it('C1: an F2 authorization whose probe evidence file is absent refuses at stage_r_probe_evidence_invalid — BEFORE the factory, zero reservations', async () => {
    const dir = copyStudy('runner-noevidence');
    writeInside(dir, 'run-authorization.json', JSON.stringify(validF2Auth(), null, 2)); // probe entry cites evidence that does not exist
    let factoryCalls = 0;
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (unitCtx: any) => { factoryCalls += 1; return createHostActorAdapter({ ctx: unitCtx, hostTransport: probeHostDouble(), taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: unitCtx.caseId, armId: unitCtx.armId, repetitionId: 1 }) }); },
      execution: { mode: 'F2-real-host', now: Date.parse(NOW_ISO), codexHome: path.join(tmpRoot, 'empty-home') },
      maxAttemptsTotal: 10,
      owner: 'probe-c1',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    const events = createChallengeLedger(dir).eventEntries();
    expect(events.some((e: any) => e.reason === 'stage_r_probe_evidence_invalid')).toBe(true);
    expect(factoryCalls).toBe(0);
    expect(createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
  });

  it('C2: with valid real-host evidence + corroborated rollouts an authorized F2 unit executes (wiring double — never real-host acceptance)', async () => {
    const dir = copyStudy('runner-withevidence');
    const codexHome = fs.mkdtempSync(path.join(tmpRoot, 'codex-'));
    writeProbeEvidence(dir, codexHome);
    writeInside(dir, 'run-authorization.json', JSON.stringify(validF2Auth(), null, 2));
    let round = 0;
    const host: any = {
      kind: 'fake-codex-host(wiring-double)',
      rounds: [] as any[],
      async complete(req: any) {
        host.rounds.push(req);
        round += 1;
        // legal actor behavior: observe the first observation, then report it
        const obs = req.view.caseVisible.availableObservations[0];
        const sessionId = `sess-${round}`;
        if (req.view.executedObservations.length === 0) return { payload: { type: 'observe', args: { obsId: obs.obsId } }, runId: `${sessionId}#r${round}`, hostRound: { sessionId, roundNo: round, opportunityId: req.taskId, usage: null, exitCode: 0, wallMs: 1, toolCallsObserved: 0, malformedLines: 0 } };
        return { payload: { type: 'report', args: { claims: [{ factId: req.view.caseVisible.facts[0].factId, verdict: 'inferred', minimalSteps: 'observed' }] } }, runId: `${sessionId}#r${round}`, hostRound: { sessionId, roundNo: round, opportunityId: req.taskId, usage: null, exitCode: 0, wallMs: 1, toolCallsObserved: 0, malformedLines: 0 } };
      },
      hostSnapshot() { return { requestedModel: 'test-double/never-real', identityStatus: 'VERIFIED', observedModel: 'test-double/never-real', identityEvidenceSource: 'test-double' }; },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (unitCtx: any) => createHostActorAdapter({ ctx: unitCtx, hostTransport: host, taskId: hostTaskIdForUnit({ studyId: 'CEB-001', caseId: unitCtx.caseId, armId: unitCtx.armId, repetitionId: 1 }) }),
      execution: { mode: 'F2-real-host', now: Date.parse(NOW_ISO), codexHome },
      maxAttemptsTotal: 10,
      owner: 'probe-c2',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    expect(readInside(dir, path.join('runs', CASE_ID, 'A', 'r1', 'a1.json')).mode).toBe('F2-real-host');
  });

  it('C3: F1 is unaffected by the F2 probe requirement (no evidence, no codexHome — runs on the F1 path)', async () => {
    const dir = copyStudy('runner-f1-unaffected');
    writeInside(dir, 'run-authorization.json', JSON.stringify(validF2Auth({ executionMode: 'F1-direct-model', isolationAcceptance: undefined, requestedActorIdentity: 'GLM-5.3-Flash' }), null, 2));
    const responder = {
      modelId: 'GLM-5.3-Flash',
      calls: 0,
      async respond(req: any) {
        responder.calls += 1;
        const obs = req.view.caseVisible.availableObservations[0];
        if (req.view.executedObservations.length === 0) return { ok: true, content: JSON.stringify({ type: 'observe', args: { obsId: obs.obsId } }), observedModelIdentity: 'GLM-5.3-Flash', finishReason: 'stop', usage: null };
        return { ok: true, content: JSON.stringify({ type: 'report', args: { claims: [{ factId: req.view.caseVisible.facts[0].factId, verdict: 'inferred', minimalSteps: 'observed' }] } }), observedModelIdentity: 'GLM-5.3-Flash', finishReason: 'stop', usage: null };
      },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: [CASE_ID], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      execution: { mode: 'F1-direct-model', now: Date.parse(NOW_ISO) }, // no codexHome, no probe evidence anywhere
      maxAttemptsTotal: 10,
      owner: 'probe-c3',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
  });

  it('protection: the REAL study directory gained no isolation-probes dir; frozen hashes and PRI-1037 status unchanged', () => {
    expect(fs.existsSync(path.join(realStudyDir, 'isolation-probes'))).toBe(false);
    expect(verifyFrozenStudy(realStudyDir).suiteHash).toBe(FROZEN.suiteHash);
    expect(fs.statSync(path.join(realStudyDir, 'budget-ledger.jsonl')).size).toBe(0);
    expect(readInside(realStudyDir, 'run-authorization.json').status).toBe('NOT_AUTHORIZED');
  });
});
