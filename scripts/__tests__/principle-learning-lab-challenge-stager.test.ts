// SPEC-PD-EXAMINER-001 v0.4 §7.2/§6.4/§12 — Stage R readiness test suite.
//
// Validates the OFFLINE enforcement boundary of the Actor-answering stage
// (Stage R) ONLY — no model, no network, no DB, no real host:
//   - challenge-stage-r-gate.mjs: the fail-closed Stage R authorization gate
//     (the machine enforcement of run-authorization.json's NOT_AUTHORIZED
//     promise), plan/budget bindings, validity window/revocation with an
//     injected trusted clock, and the F2 PRI-1037 isolation-probe requirement;
//   - challenge-runner.mjs wiring: a non-stub actor is refused BEFORE any
//     budget reservation / PREPARED row / actor step; stub execution keeps the
//     historical Phase 1B contract byte-identical;
//   - deriveRealHostBaseline: mock/offline/wiring-only evidence can NEVER
//     produce a real-host PASS.
//
// All synthetic APPROVED records are test fixtures bound to the REAL frozen
// hashes — none of this issues, extends or exercises any real authorization,
// and the live run-authorization.json stays NOT_AUTHORIZED (asserted below).

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyStageRAuthorization,
  isOfflineStubActor,
  readStudyPlanHash,
  readObservedHostEvidence,
  deriveRealHostBaseline,
  STAGE_R_AUTH_SCHEMA,
} from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';
import { runChallengeStudy, verifyFrozenStudy, STUB_STRATEGIES } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { createChallengeLedger, releaseStudyWriteLock } from '../dev/principle-learning-lab/lib/challenge-ledger.mjs';
import { perfectPlayActor, SimulatedCrashError } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realStudyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'stage-r-tests');

const FROZEN = {
  studyId: 'CEB-001',
  suiteHash: 'e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  graderHash: 'eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79',
};
const STUDY_PLAN_HASH = readStudyPlanHash(realStudyDir); // recomputed from the real preregistration.json
const NOW = Date.parse('2026-10-26T12:00:00Z'); // fixed injected clock (trusted runner in prod, pinned in tests)

let copyCounter = 0;
function copyStudy(tag: string): string {
  const dir = path.join(tmpRoot, `${tag}-${++copyCounter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(realStudyDir, dir, { recursive: true });
  return dir;
}
const readJson = (dir: string, rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

/** A schema-valid APPROVED Stage R record bound to the REAL frozen study.
 *  Test fixture only — never written into any study directory. */
function validStageRAuth(over: Record<string, any> = {}) {
  return {
    schema: STAGE_R_AUTH_SCHEMA,
    stage: 'R',
    status: 'APPROVED',
    studyId: FROZEN.studyId,
    suiteHash: FROZEN.suiteHash,
    mappingHash: FROZEN.mappingHash,
    graderHash: FROZEN.graderHash,
    studyPlanHash: STUDY_PLAN_HASH,
    requestedActorIdentity: 'test-double/never-real',
    executionMode: 'F1-direct-model',
    arms: ['A', 'B', 'C'],
    cases: ['CEB-001-FV-01', 'CEB-001-FV-02'],
    repetitions: ['1'],
    attemptCap: 40,
    issuedBy: 'owner-test-fixture',
    validFrom: '2026-10-26T00:00:00Z',
    validUntil: '2026-10-27T00:00:00Z',
    revoked: false,
    halted: false,
    ...over,
  };
}
const f2WithProbe = (over: Record<string, any> = {}) => validStageRAuth({
  executionMode: 'F2-real-host',
  isolationAcceptance: {
    realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'probe/synthetic-fixture.json', suiteHash: FROZEN.suiteHash },
  },
  ...over,
});

/** A real-mode test double: plays the perfect script but does NOT declare
 *  itself an offline stub (kind is not stub-rooted, no offlineStub flag) —
 *  exactly the shape a future real actor would present to the runner seam. */
function realModePlayDouble(ctx: any) {
  const inner = perfectPlayActor(ctx.caseDef);
  return { kind: 'real-model-double(wiring-only)', nextAction: (view: any) => inner.nextAction(view) };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

// ===========================================================================
// A. Gate — the live placeholder and malformed records refuse fail-closed
// ===========================================================================
describe('A. Stage R gate: live placeholder + malformed records', () => {
  it('the LIVE run-authorization.json (status NOT_AUTHORIZED) is refused — the placeholder sentence is now machine-enforced', () => {
    const live = readJson(realStudyDir, 'run-authorization.json');
    const verdict = verifyStageRAuthorization({
      authorizationRecord: live,
      bindings: { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH },
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      maxAttemptsTotal: 10,
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r: string) => r.includes('NOT_AUTHORIZED'))).toBe(true);
  });

  it('missing record / wrong schema / wrong stage refuse before any further check (a Stage G record cannot be reused for Stage R)', () => {
    expect(verifyStageRAuthorization({ authorizationRecord: null, bindings: { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH }, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] }, now: NOW }).ok).toBe(false);
    const wrongSchema = validStageRAuth({ schema: 'challenge-stage-g-authorization.v1' });
    expect(verifyStageRAuthorization({ authorizationRecord: wrongSchema, bindings: { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH }, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] }, now: NOW }).reasons.join(' ')).toContain('schema must be challenge-stage-authorization.v1');
    const wrongStage = validStageRAuth({ stage: 'G' });
    expect(verifyStageRAuthorization({ authorizationRecord: wrongStage, bindings: { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH }, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] }, now: NOW }).reasons.join(' ')).toContain("stage 'G' must be 'R'");
  });

  it('unknown authorization fields refuse (closed key set — the real Owner-issued schema updates the gate deliberately, never silently)', () => {
    const withBonus = validStageRAuth({ bonusField: 'x' });
    const verdict = verifyStageRAuthorization({ authorizationRecord: withBonus, bindings: { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH }, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] }, now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('unknown authorization field');
  });

  it('owner-halted and revoked authorizations refuse', () => {
    for (const over of [{ halted: true }, { revoked: true }]) {
      const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(over), bindings: { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH }, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] }, now: NOW });
      expect(verdict.ok).toBe(false);
    }
  });
});

// ===========================================================================
// B. Gate — validity window / trusted clock (Stage G parity)
// ===========================================================================
describe('B. Stage R gate: validity window and trusted clock', () => {
  const bindings = { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH };
  const plan = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] };

  it('not-yet-valid / expired / inverted / malformed windows all refuse', () => {
    const cases: any[] = [
      validStageRAuth({ validFrom: '2026-10-27T00:00:00Z', validUntil: '2026-10-28T00:00:00Z' }),
      validStageRAuth({ validFrom: '2026-10-24T00:00:00Z', validUntil: '2026-10-25T00:00:00Z' }),
      validStageRAuth({ validFrom: '2026-10-27T00:00:00Z', validUntil: '2026-10-26T00:00:00Z' }),
      validStageRAuth({ validFrom: 'nonsense', validUntil: '' }),
    ];
    for (const auth of cases) {
      const verdict = verifyStageRAuthorization({ authorizationRecord: auth, bindings, plan, now: NOW });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.length).toBeGreaterThan(0);
    }
  });

  it('trusted clock unavailable (now not injected) refuses even for a perfect authorization', () => {
    const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan, now: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('trusted clock unavailable');
  });

  it('window boundaries are inclusive: now == validFrom and now == validUntil both pass the gate', () => {
    const auth = validStageRAuth({ validFrom: '2026-10-26T12:00:00Z', validUntil: '2026-10-26T12:00:00Z' });
    const verdict = verifyStageRAuthorization({ authorizationRecord: auth, bindings, plan, now: NOW });
    expect(verdict).toMatchObject({ ok: true, executionMode: 'F1-direct-model' });
  });
});

// ===========================================================================
// C. Gate — frozen bindings, plan containment, attempt cap, F2 probe
// ===========================================================================
describe('C. Stage R gate: bindings / plan / budget / F2 probe', () => {
  const bindings = { ...FROZEN, studyPlanHash: STUDY_PLAN_HASH };
  const plan = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] };

  it('binding mismatches refuse: suiteHash drift and studyPlanHash drift are caught against the freshly recomputed study', () => {
    for (const over of [{ suiteHash: '0'.repeat(64) }, { studyPlanHash: 'f'.repeat(64) }, { mappingHash: 'a'.repeat(64) }, { graderHash: 'b'.repeat(64) }, { studyId: 'CEB-999' }]) {
      const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(over), bindings, plan, now: NOW });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.join(' ')).toContain('binding mismatch');
    }
  });

  it('a plan outside the authorized arms/cases/repetitions refuses (no silent plan substitution)', () => {
    const outsideArm = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan: { arms: ['D'], cases: ['CEB-001-FV-01'], repetitions: [1] }, now: NOW });
    expect(outsideArm.ok).toBe(false);
    expect(outsideArm.reasons.join(' ')).toContain("outside the authorized arms");
    const outsideCase = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan: { arms: ['A'], cases: ['CEB-001-BN-03'], repetitions: [1] }, now: NOW });
    expect(outsideCase.ok).toBe(false);
    expect(outsideCase.reasons.join(' ')).toContain('outside the authorized case list');
    const outsideRep = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [2] }, now: NOW });
    expect(outsideRep.ok).toBe(false);
  });

  it('runner attempt cap above the authorized attemptCap refuses — budgets widen only via a new authorization', () => {
    const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ attemptCap: 5 }), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('exceeds the authorized attemptCap');
  });

  it('F2-real-host without a PASSED PRI-1037 probe refuses; a probe bound to a different suite refuses; F1 needs no probe', () => {
    const noProbe = verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ executionMode: 'F2-real-host' }), bindings, plan, now: NOW });
    expect(noProbe.ok).toBe(false);
    expect(noProbe.reasons.join(' ')).toContain('realHostProbe');
    const notPassed = verifyStageRAuthorization({ authorizationRecord: f2WithProbe({ isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'NOT_RUN', evidenceRef: 'x', suiteHash: FROZEN.suiteHash } } }), bindings, plan, now: NOW });
    expect(notPassed.ok).toBe(false);
    expect(notPassed.reasons.join(' ')).toContain('PRI-1037 blocks F2');
    const foreignSuite = verifyStageRAuthorization({ authorizationRecord: f2WithProbe({ isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'x', suiteHash: 'c'.repeat(64) } } }), bindings, plan, now: NOW });
    expect(foreignSuite.ok).toBe(false);
    expect(foreignSuite.reasons.join(' ')).toContain('different frozen suite');
    const f1 = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan, now: NOW });
    expect(f1.ok).toBe(true);
    const f2 = verifyStageRAuthorization({ authorizationRecord: f2WithProbe(), bindings, plan, now: NOW });
    expect(f2).toMatchObject({ ok: true, executionMode: 'F2-real-host' });
  });
});

// ===========================================================================
// D. Runner-level enforcement — the actorFactory seam refuses BEFORE side effects
// ===========================================================================
describe('D. runner enforcement: unauthorized real actors are unreachable', () => {
  it('a non-stub actor with NO execution config is refused with ZERO side effects (no reservation, no PREPARED row, zero actor steps, no attempt file)', () => {
    const dir = copyStudy('runner-noconfig');
    let steps = 0;
    const double = (ctx: any) => {
      const inner = realModePlayDouble(ctx);
      return { kind: 'real-model-double', nextAction: (v: any) => { steps += 1; return inner.nextAction(v); } };
    };
    const summary = runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: double,
      owner: 'stager-d1',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('execution config missing');
    expect(steps).toBe(0); // not a single actor step ran
    const ledger = createChallengeLedger(dir);
    expect(ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
    expect(ledger.budgetEntries().some((e: any) => e.type === 'ATTEMPT_PREPARED')).toBe(false);
    expect(ledger.eventEntries().some((e: any) => e.reason === 'stage_r_not_authorized')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false);
  });

  it('a non-stub actor with the LIVE NOT_AUTHORIZED record is refused with zero side effects', () => {
    const dir = copyStudy('runner-liveauth');
    const live = readJson(realStudyDir, 'run-authorization.json');
    const summary = runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: realModePlayDouble,
      execution: { authorizationRecord: live, now: NOW },
      owner: 'stager-d2',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('NOT_AUTHORIZED');
    const ledger = createChallengeLedger(dir);
    expect(ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false);
  });

  it('an EXPIRED otherwise-valid authorization refuses before execution (zero actor steps)', () => {
    const dir = copyStudy('runner-expired');
    let steps = 0;
    const counting = (ctx: any) => {
      const inner = realModePlayDouble(ctx);
      return { kind: 'real-model-double', nextAction: (v: any) => { steps += 1; return inner.nextAction(v); } };
    };
    const expired = validStageRAuth({ validFrom: '2026-10-24T00:00:00Z', validUntil: '2026-10-25T00:00:00Z' });
    const summary = runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: counting,
      execution: { authorizationRecord: expired, now: NOW },
      owner: 'stager-d3',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('expired');
    expect(steps).toBe(0);
  });

  it('F2 without a PASSED probe is refused at runner level too (PRI-1037 is the independent F2 blocker)', () => {
    const dir = copyStudy('runner-f2-noprobe');
    const summary = runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: realModePlayDouble,
      execution: { authorizationRecord: validStageRAuth({ executionMode: 'F2-real-host' }), now: NOW },
      owner: 'stager-d4',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('realHostProbe');
    expect(createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
  });

  it('stub execution keeps the Phase 1B contract: runs without any gate, records mode offline-stub and NO authorization field', () => {
    const dir = copyStudy('runner-stub-unchanged');
    const summary = runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef),
      owner: 'stager-d5',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    expect(attempt.mode).toBe('offline-stub');
    expect(attempt.authorization).toBeUndefined();
    expect(attempt.observedHostEvidence).toBeUndefined();
  });

  it('a gate-passing F1 authorization lets a real-mode double execute, but the record proves it is wiring-only: observedHostEvidence null, baseline stays UNKNOWN', () => {
    const dir = copyStudy('runner-f1-wiring');
    const summary = runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: realModePlayDouble,
      execution: { authorizationRecord: validStageRAuth(), now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d6',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    expect(attempt.mode).toBe('F1-direct-model');
    expect(attempt.authorization).toMatchObject({ schema: STAGE_R_AUTH_SCHEMA, studyId: 'CEB-001', executionMode: 'F1-direct-model' });
    expect(attempt.observedHostEvidence).toBeNull(); // a test double has no host session/identity to report
    const baseline = deriveRealHostBaseline({ attempts: [attempt] });
    expect(baseline.status).not.toBe('PASS');
    expect(baseline.reasons.join(' ')).toContain('not F2-real-host');
  });

  it('real-mode crash keeps the state machine honest: RESULT_UNKNOWN, no auto-retry of the same attemptId, new attemptId reserves freshly', () => {
    const dir = copyStudy('runner-real-crash');
    const crashDouble = () => ({ kind: 'real-crash-double', nextAction: () => { throw new SimulatedCrashError(1); } });
    const plan = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' };
    expect(() => runChallengeStudy({
      studyDir: dir, plan,
      actorFactory: crashDouble,
      execution: { authorizationRecord: validStageRAuth(), now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d7',
    })).toThrow(SimulatedCrashError);
    releaseStudyWriteLock(dir, { owner: 'stager-d7' }); // crashed owner explicitly releases (recovery discipline)
    const ledger = createChallengeLedger(dir);
    expect(ledger.classifyUnit({ caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' }).state).toBe('RESULT_UNKNOWN');
    // recovery of the SAME attemptId is refused even with a valid authorization
    const refused = runChallengeStudy({
      studyDir: dir, plan,
      actorFactory: realModePlayDouble,
      execution: { authorizationRecord: validStageRAuth(), now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d7',
    });
    expect(refused.units[0]).toMatchObject({ state: 'RESULT_UNKNOWN', refused: true });
    // a NEW attemptId reserves freshly — the unknown one is never overwritten
    const fresh = runChallengeStudy({
      studyDir: dir, plan: { ...plan, attemptId: 'a2' },
      actorFactory: realModePlayDouble,
      execution: { authorizationRecord: validStageRAuth(), now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d7',
    });
    expect(fresh.units[0].state).toBe('SUCCEEDED');
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false); // the crashed attempt left NO record (RESULT_UNKNOWN by absence, never fabricated)
    expect(readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a2.json')).mode).toBe('F1-direct-model');
  });
});

// ===========================================================================
// E. realHostBaseline — mock/offline evidence can never become PASS
// ===========================================================================
describe('E. deriveRealHostBaseline', () => {
  it('no attempts → UNKNOWN', () => {
    expect(deriveRealHostBaseline({ attempts: [] })).toMatchObject({ status: 'UNKNOWN' });
    expect(deriveRealHostBaseline({})).toMatchObject({ status: 'UNKNOWN' });
  });

  it('offline-stub attempts (even all-SUCCEEDED) → NOT_ESTIMABLE, never PASS', () => {
    const verdict = deriveRealHostBaseline({ attempts: [
      { mode: 'offline-stub', result: 'SUCCEEDED' },
      { mode: 'offline-stub', result: 'SUCCEEDED' },
    ] });
    expect(verdict.status).toBe('NOT_ESTIMABLE');
    expect(verdict.reasons.join(' ')).toContain('can never establish a real-host baseline');
  });

  it('F1-direct-model attempts → NOT_ESTIMABLE (direct API is not a real-host experiment)', () => {
    const verdict = deriveRealHostBaseline({ attempts: [{ mode: 'F1-direct-model', result: 'SUCCEEDED', authorization: {}, observedHostEvidence: { hostSessionId: 's', observedModelIdentity: 'm' } }] });
    expect(verdict.status).toBe('NOT_ESTIMABLE');
  });

  it('F2 attempts without observed host evidence (wiring-only doubles) → UNKNOWN', () => {
    const verdict = deriveRealHostBaseline({ attempts: [
      { mode: 'F2-real-host', result: 'SUCCEEDED', authorization: { isolationAcceptance: { realHostProbe: { status: 'PASSED' } } }, observedHostEvidence: null },
    ] });
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.reasons.join(' ')).toContain('wiring-only');
  });

  it('F2 attempts whose authorization linkage lacks a PASSED probe → NOT_ESTIMABLE', () => {
    const verdict = deriveRealHostBaseline({ attempts: [
      { mode: 'F2-real-host', result: 'SUCCEEDED', authorization: { isolationAcceptance: { realHostProbe: { status: 'NOT_RUN' } } }, observedHostEvidence: { hostSessionId: 's1', observedModelIdentity: 'm1' } },
    ] });
    expect(verdict.status).toBe('NOT_ESTIMABLE');
  });

  it('PASS requires the complete chain: F2 + probe-PASSED linkage + observed host evidence + ≥1 SUCCEEDED', () => {
    const good = { mode: 'F2-real-host', result: 'SUCCEEDED', authorization: { isolationAcceptance: { realHostProbe: { status: 'PASSED' } } }, observedHostEvidence: { hostSessionId: 's1', observedModelIdentity: 'provider/model-x' } };
    expect(deriveRealHostBaseline({ attempts: [good] })).toMatchObject({ status: 'PASS' });
    const allFailed = { ...good, result: 'FAILED_KNOWN' };
    expect(deriveRealHostBaseline({ attempts: [allFailed] })).toMatchObject({ status: 'UNKNOWN' });
  });

  it('mixed F2 + offline-stub input → NOT_ESTIMABLE (a single mock attempt poisons the baseline)', () => {
    const good = { mode: 'F2-real-host', result: 'SUCCEEDED', authorization: { isolationAcceptance: { realHostProbe: { status: 'PASSED' } } }, observedHostEvidence: { hostSessionId: 's1', observedModelIdentity: 'm1' } };
    expect(deriveRealHostBaseline({ attempts: [good, { mode: 'offline-stub', result: 'SUCCEEDED' }] })).toMatchObject({ status: 'NOT_ESTIMABLE' });
  });
});

// ===========================================================================
// F. No bypass + static boundaries + protected-state assertions
// ===========================================================================
describe('F. no-bypass, static boundaries, protected state', () => {
  it('every STUB_STRATEGIES actor declares itself an offline stub (the CLI entry cannot produce a real actor)', () => {
    const ctx = { caseDef: readJson(realStudyDir, path.join('judge-only', 'CEB-001-FV-01.json')), caseId: 'CEB-001-FV-01', caseVisible: readJson(realStudyDir, path.join('actor-visible', 'CEB-001-FV-01.json')) };
    for (const factory of Object.values(STUB_STRATEGIES)) {
      expect(isOfflineStubActor((factory as any)(ctx))).toBe(true);
    }
  });

  it('isOfflineStubActor: undeclared actors (no stub kind, no flag) are classified real; malformed objects too', () => {
    expect(isOfflineStubActor(realModePlayDouble({ caseDef: readJson(realStudyDir, path.join('judge-only', 'CEB-001-FV-01.json')) }))).toBe(false);
    expect(isOfflineStubActor({ kind: 'codex-host', nextAction: () => ({ type: 'report', args: {} }) })).toBe(false);
    expect(isOfflineStubActor(null)).toBe(false);
    expect(isOfflineStubActor({ kind: 'stub-x' })).toBe(false); // no nextAction function
    expect(isOfflineStubActor({ kind: 'stub-x', nextAction: () => ({ type: 'report', args: {} }), offlineStub: true })).toBe(true);
  });

  it('readObservedHostEvidence: only complete host-session + observed-identity objects count', () => {
    expect(readObservedHostEvidence({})).toBeNull();
    expect(readObservedHostEvidence({ observedHostEvidence: { hostSessionId: 's' } })).toBeNull();
    expect(readObservedHostEvidence({ observedHostEvidence: { hostSessionId: 's', observedModelIdentity: 'm' } })).toEqual({ hostSessionId: 's', observedModelIdentity: 'm' });
  });

  it('the gate module contains no network/env/exec/clock constructs (static proof)', () => {
    const src = fs.readFileSync(path.join(labRoot, 'lib', 'challenge-stage-r-gate.mjs'), 'utf8');
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('process.env')).toBe(false);
    expect(src.includes('http://')).toBe(false);
    expect(src.includes('https://')).toBe(false);
    expect(src.includes('Date.now')).toBe(false);
    expect(src.includes('Math.random(')).toBe(false);
    expect(src.includes('child_process')).toBe(false);
  });

  it('protected state: live run-authorization.json stays NOT_AUTHORIZED, frozen hashes unchanged, verifyFrozenStudy still passes on the pristine study', () => {
    expect(readJson(realStudyDir, 'run-authorization.json').status).toBe('NOT_AUTHORIZED');
    const hashes = readJson(realStudyDir, 'hashes.json');
    expect(hashes.mappingHash.value).toBe(FROZEN.mappingHash);
    expect(hashes.suiteHash.value).toBe(FROZEN.suiteHash);
    expect(hashes.graderHash.value).toBe(FROZEN.graderHash);
    expect(hashes.preregistrationHash.value).toBe(STUDY_PLAN_HASH);
    expect(verifyFrozenStudy(realStudyDir).suiteHash).toBe(FROZEN.suiteHash);
  });
});
