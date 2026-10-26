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
  readStageRAuthorization,
  deriveRealHostBaseline,
  STAGE_R_AUTH_SCHEMA,
} from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';
import { deriveRealHostBaselineFromStudy } from '../dev/principle-learning-lab/lib/challenge-baseline.mjs';
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
 *  Test fixture only — never written into the live study directory. */
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
    requestCap: 200,
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

/** Test-side authorization injection (P1-2): fixtures are written into the
 *  COPIED study directory's own run-authorization.json — the same file the
 *  production runner reads. There is no in-memory authorization override. */
function approveStudy(dir: string, record: unknown) {
  fs.writeFileSync(path.join(dir, 'run-authorization.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** A real-mode test double: plays the perfect script but does NOT declare
 *  itself an offline stub (kind is not stub-rooted, no offlineStub flag) and
 *  carries the runner-required real-actor identity fields — exactly the shape
 *  a real transport actor presents to the runner seam. */
function realModePlayDouble(ctx: any, mode = 'F1-direct-model') {
  const inner = perfectPlayActor(ctx.caseDef);
  return {
    kind: 'real-model-double(wiring-only)',
    executionMode: mode,
    requestedModelIdentity: 'test-double/never-real',
    nextAction: (view: any) => inner.nextAction(view),
  };
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
    const verdict = verifyStageRAuthorization({ authorizationRecord: auth, bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(verdict).toMatchObject({ ok: true, executionMode: 'F1-direct-model' });
  });

  it('ambiguous timestamps refuse: timezone-less, impossible calendar dates/clocks and legacy formats are not ISO-8601-with-timezone', () => {
    const ambiguous: any[] = [
      { validFrom: '2026-10-26T00:00:00', validUntil: '2026-10-27T00:00:00Z' }, // no timezone — Date.parse silently uses LOCAL time (window shifts with host TZ)
      { validFrom: '2026-02-30T00:00:00Z', validUntil: '2026-10-27T00:00:00Z' }, // impossible date — Date.parse silently normalizes to Mar 2
      { validFrom: '2026-10-26T24:00:00Z', validUntil: '2026-10-27T00:00:00Z' }, // impossible clock — silently normalized to next day
      { validFrom: 'October 26 2026', validUntil: '2026-10-27T00:00:00Z' }, // legacy non-ISO format accepted by Date.parse
      { validFrom: '2026-10-26T00:00:00+99:00', validUntil: '2026-10-27T00:00:00Z' }, // out-of-range UTC offset
    ];
    for (const over of ambiguous) {
      const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(over), bindings, plan, maxAttemptsTotal: 10, now: NOW });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.join(' ')).toContain('must be ISO-8601 WITH timezone');
    }
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
    const foreignSuite = verifyStageRAuthorization({ authorizationRecord: f2WithProbe({ isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'x', suiteHash: 'c'.repeat(64) } } }), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(foreignSuite.ok).toBe(false);
    expect(foreignSuite.reasons.join(' ')).toContain('different frozen suite');
    const unbound = verifyStageRAuthorization({ authorizationRecord: f2WithProbe({ isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'x' } } }), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(unbound.ok).toBe(false); // a missing suiteHash binding is NOT "bound to the same suite"
    expect(unbound.reasons.join(' ')).toContain('realHostProbe.suiteHash missing');
    const f1 = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(f1.ok).toBe(true);
    const f2 = verifyStageRAuthorization({ authorizationRecord: f2WithProbe(), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(f2).toMatchObject({ ok: true, executionMode: 'F2-real-host' });
  });

  it('malformed arms/cases/repetitions refuse with structured reasons instead of throwing (a TypeError would crash the run without STAGE_R_REFUSED)', () => {
    for (const over of [{ arms: undefined }, { cases: 'A,B' }, { repetitions: null }, { arms: [] }]) {
      const run = () => verifyStageRAuthorization({ authorizationRecord: validStageRAuth(over), bindings, plan, maxAttemptsTotal: 10, now: NOW });
      expect(run).not.toThrow();
      const verdict = run();
      expect(verdict.ok).toBe(false);
    }
    const missingArms = verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ arms: undefined }), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(missingArms.reasons.join(' ')).toContain('arms must be a non-empty string array');
  });

  it('a non-positive / non-finite / omitted runner maxAttemptsTotal refuses — Infinity or NaN must not silently disable the budget cap', () => {
    for (const bad of [Infinity, NaN, 0, -3, undefined]) {
      const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ attemptCap: 40 }), bindings, plan, maxAttemptsTotal: bad, now: NOW });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.join(' ')).toContain('maxAttemptsTotal must be a positive safe integer');
    }
    expect(verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ attemptCap: 40 }), bindings, plan, maxAttemptsTotal: 40, now: NOW }).ok).toBe(true);
  });

  it('P1-5 (gate): a declaredExecutionMode that contradicts the approved executionMode refuses', () => {
    const cross = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan, maxAttemptsTotal: 10, now: NOW, declaredExecutionMode: 'F2-real-host' });
    expect(cross.ok).toBe(false);
    expect(cross.reasons.join(' ')).toContain('does not match the runner-declared execution mode');
    const aligned = verifyStageRAuthorization({ authorizationRecord: validStageRAuth(), bindings, plan, maxAttemptsTotal: 10, now: NOW, declaredExecutionMode: 'F1-direct-model' });
    expect(aligned.ok).toBe(true);
    const alignedF2 = verifyStageRAuthorization({ authorizationRecord: f2WithProbe(), bindings, plan, maxAttemptsTotal: 10, now: NOW, declaredExecutionMode: 'F2-real-host' });
    expect(alignedF2.ok).toBe(true);
  });

  it('P1-7 (gate): requestCap must be a positive safe integer — an attempt cap is not a model-request budget', () => {
    for (const bad of [undefined, 0, -1, 2.5, Infinity, NaN, '40']) {
      const verdict = verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ requestCap: bad }), bindings, plan, maxAttemptsTotal: 10, now: NOW });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons.join(' ')).toContain('requestCap must be a positive safe integer');
    }
    const good = verifyStageRAuthorization({ authorizationRecord: validStageRAuth({ requestCap: 7 }), bindings, plan, maxAttemptsTotal: 10, now: NOW });
    expect(good).toMatchObject({ ok: true, requestCap: 7 });
  });
});

// ===========================================================================
// D. Runner-level enforcement — the actorFactory seam refuses BEFORE side effects
// ===========================================================================
describe('D. runner enforcement: unauthorized real actors are unreachable', () => {
  it('P1-1: a NON-stub actor under a stub declaration is refused with ZERO side effects — self-declaration can never select a real execution mode', async () => {
    const dir = copyStudy('runner-noconfig');
    let steps = 0;
    const double = (ctx: any) => {
      const inner = realModePlayDouble(ctx);
      return { ...inner, kind: 'real-model-double', nextAction: (v: any) => { steps += 1; return inner.nextAction(v); } };
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: double,
      owner: 'stager-d1',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('NON-stub actor');
    expect(steps).toBe(0); // not a single actor step ran
    const ledger = createChallengeLedger(dir);
    expect(ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
    expect(ledger.budgetEntries().some((e: any) => e.type === 'ATTEMPT_PREPARED')).toBe(false);
    expect(ledger.eventEntries().some((e: any) => e.reason === 'stage_r_not_authorized')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false);
  });

  it('P1-2: a declared F1 run against the LIVE NOT_AUTHORIZED authority file refuses BEFORE the actor factory is ever invoked', async () => {
    const dir = copyStudy('runner-liveauth');
    let factoryCalls = 0;
    const counting = (ctx: any) => { factoryCalls += 1; return realModePlayDouble(ctx); };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: counting,
      execution: { mode: 'F1-direct-model', now: NOW },
      owner: 'stager-d2',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('NOT_AUTHORIZED');
    expect(factoryCalls).toBe(0); // the gate runs BEFORE the factory — nothing was constructed
    const ledger = createChallengeLedger(dir);
    expect(ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false);
  });

  it('P1-2: an unreadable/corrupt authority file refuses fail-closed (missing authority ≠ approval)', async () => {
    const dir = copyStudy('runner-corruptauth');
    fs.writeFileSync(path.join(dir, 'run-authorization.json'), '{ not json', 'utf8');
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: realModePlayDouble,
      execution: { mode: 'F1-direct-model', now: NOW },
      owner: 'stager-d2b',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('missing or unreadable');
  });

  it('an EXPIRED otherwise-valid authorization refuses before execution (zero actor steps)', async () => {
    const dir = copyStudy('runner-expired');
    let steps = 0;
    const counting = (ctx: any) => {
      const inner = realModePlayDouble(ctx);
      return { ...inner, kind: 'real-model-double', nextAction: (v: any) => { steps += 1; return inner.nextAction(v); } };
    };
    approveStudy(dir, validStageRAuth({ validFrom: '2026-10-24T00:00:00Z', validUntil: '2026-10-25T00:00:00Z' }));
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: counting,
      execution: { mode: 'F1-direct-model', now: NOW },
      owner: 'stager-d3',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('expired');
    expect(steps).toBe(0);
  });

  it('F2 without a PASSED probe is refused at runner level too (PRI-1037 is the independent F2 blocker)', async () => {
    const dir = copyStudy('runner-f2-noprobe');
    approveStudy(dir, validStageRAuth({ executionMode: 'F2-real-host' }));
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: (ctx: any) => realModePlayDouble(ctx, 'F2-real-host'),
      execution: { mode: 'F2-real-host', now: NOW },
      owner: 'stager-d4',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('realHostProbe');
    expect(createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
  });

  it('P1-5: a declared mode that does not match the approved executionMode refuses before the factory (an F1 authorization cannot bless an F2 run and vice versa)', async () => {
    const dir = copyStudy('runner-modecross');
    let factoryCalls = 0;
    const counting = (ctx: any) => { factoryCalls += 1; return realModePlayDouble(ctx, 'F2-real-host'); };
    approveStudy(dir, validStageRAuth()); // approved F1
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: counting,
      execution: { mode: 'F2-real-host', now: NOW }, // declared F2
      maxAttemptsTotal: 10,
      owner: 'stager-d4b',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('does not match the runner-declared execution mode');
    expect(factoryCalls).toBe(0);
  });

  it('P1-5: an actor whose executionMode contradicts the declared+approved mode refuses with zero side effects', async () => {
    const dir = copyStudy('runner-actormode');
    approveStudy(dir, validStageRAuth()); // approved + declared F1
    let steps = 0;
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: () => ({ kind: 'real-model-double', executionMode: 'F2-real-host', requestedModelIdentity: 'test-double/never-real', nextAction: () => { steps += 1; throw new Error('must not run'); } }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d4c',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain("does not match the runner-declared 'F1-direct-model'");
    expect(steps).toBe(0);
    expect(createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(0);
  });

  it('P1-6/P1-5: an actor whose requested model identity is not the authorization-bound actor identity refuses (identity binding is machine-checked, not prose)', async () => {
    const dir = copyStudy('runner-identitybind');
    approveStudy(dir, validStageRAuth());
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: () => ({ kind: 'real-model-double', executionMode: 'F1-direct-model', requestedModelIdentity: 'other-provider/other-model', nextAction: () => { throw new Error('must not run'); } }),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d4d',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('is not the authorization-bound requestedActorIdentity');
  });

  it('P1-1: a stub-declaring actor under a REAL execution declaration refuses (a real run can never be downgraded to stub)', async () => {
    const dir = copyStudy('runner-stubunderreal');
    approveStudy(dir, validStageRAuth());
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), // declares stub kind
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d4e',
    });
    expect(summary.units[0]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[0].reasons.join(' ')).toContain('offline stub under a real');
  });

  it('P1-7: the model-request budget is enforced per REQUEST — cap 1 means exactly one dispatched request, the next reservation refuses BEFORE dispatch', async () => {
    const dir = copyStudy('runner-requestbudget');
    approveStudy(dir, validStageRAuth({ requestCap: 1 }));
    let requests = 0;
    const neverValid = () => ({
      kind: 'real-model-double',
      executionMode: 'F1-direct-model',
      requestedModelIdentity: 'test-double/never-real',
      nextAction: () => { requests += 1; return { type: 'observe', args: { obsId: 'no-such-obs' } }; }, // every answer is behavioral garbage — but each WAS a model request
    });
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: neverValid,
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d4f',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED'); // the attempt settled with a graded (failed) outcome
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    expect(attempt.trace.termination.reason).toBe('request_budget_exhausted');
    expect(requests).toBe(1); // the second reservation refused BEFORE dispatch — no second model request
    const budget = createChallengeLedger(dir).budgetEntries();
    expect(budget.filter((e: any) => e.type === 'REQUEST_RESERVE')).toHaveLength(1);
    expect(budget.some((e: any) => e.type === 'REQUEST_REFUSED')).toBe(true);
  });

  it('stub execution keeps the Phase 1B contract: runs without any gate, records mode offline-stub and NO authorization field', async () => {
    const dir = copyStudy('runner-stub-unchanged');
    const summary = await runChallengeStudy({
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

  it('a gate-passing F1 authorization lets a real-mode double execute, but the record proves it is wiring-only: observedHostEvidence null, baseline stays UNKNOWN', async () => {
    const dir = copyStudy('runner-f1-wiring');
    approveStudy(dir, validStageRAuth());
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: realModePlayDouble,
      execution: { mode: 'F1-direct-model', now: NOW },
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

  it('real-mode crash keeps the state machine honest: RESULT_UNKNOWN, no auto-retry of the same attemptId, new attemptId reserves freshly', async () => {
    const dir = copyStudy('runner-real-crash');
    const crashDouble = () => ({ kind: 'real-crash-double', executionMode: 'F1-direct-model', requestedModelIdentity: 'test-double/never-real', nextAction: () => { throw new SimulatedCrashError(1); } });
    approveStudy(dir, validStageRAuth());
    const plan = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' };
    await expect(runChallengeStudy({
      studyDir: dir, plan,
      actorFactory: crashDouble,
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d7',
    })).rejects.toThrow(SimulatedCrashError);
    releaseStudyWriteLock(dir, { owner: 'stager-d7' }); // crashed owner explicitly releases (recovery discipline)
    const ledger = createChallengeLedger(dir);
    expect(ledger.classifyUnit({ caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' }).state).toBe('RESULT_UNKNOWN');
    // recovery of the SAME attemptId is refused even with a valid authorization
    const refused = await runChallengeStudy({
      studyDir: dir, plan,
      actorFactory: realModePlayDouble,
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d7',
    });
    expect(refused.units[0]).toMatchObject({ state: 'RESULT_UNKNOWN', refused: true });
    // a NEW attemptId reserves freshly — the unknown one is never overwritten
    const fresh = await runChallengeStudy({
      studyDir: dir, plan: { ...plan, attemptId: 'a2' },
      actorFactory: realModePlayDouble,
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d7',
    });
    expect(fresh.units[0].state).toBe('SUCCEEDED');
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false); // the crashed attempt left NO record (RESULT_UNKNOWN by absence, never fabricated)
    expect(readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a2.json')).mode).toBe('F1-direct-model');
  });

  it('a real-mode FAILED_KNOWN attempt record still carries the authorization linkage and observed host evidence (a failed real-host run must not poison the baseline as linkage-missing)', async () => {
    const dir = copyStudy('runner-real-failed');
    approveStudy(dir, f2WithProbe());
    const failingDouble = () => ({
      kind: 'real-model-double(wiring-only)',
      executionMode: 'F2-real-host',
      requestedModelIdentity: 'test-double/never-real',
      observedHostEvidence: { hostSessionId: 's-fail', observedModelIdentity: 'test-double/never-real' },
      nextAction: () => { throw new Error('boom: actor transport failed'); },
    });
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: failingDouble,
      execution: { mode: 'F2-real-host', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'stager-d8',
    });
    expect(summary.units[0].state).toBe('FAILED_KNOWN');
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    expect(attempt.mode).toBe('F2-real-host');
    expect(attempt.authorization).toMatchObject({ schema: STAGE_R_AUTH_SCHEMA, studyId: 'CEB-001', executionMode: 'F2-real-host', isolationAcceptance: { realHostProbe: { status: 'PASSED' } } });
    expect(attempt.observedHostEvidence).toEqual({ hostSessionId: 's-fail', observedModelIdentity: 'test-double/never-real' });
    expect(attempt.error).toContain('boom');
    // complete evidence on a FAILED_KNOWN F2 attempt: unmeasured (no SUCCEEDED), NOT degraded to NOT_ESTIMABLE
    expect(deriveRealHostBaseline({ attempts: [attempt] })).toMatchObject({ status: 'UNKNOWN' });
  });

  it('a stub FAILED_KNOWN attempt keeps the Phase 1B record shape (no authorization / observedHostEvidence fields)', async () => {
    const dir = copyStudy('runner-stub-failed');
    const failingStub = () => ({ kind: 'stub-failing', nextAction: () => { throw new Error('stub boom'); } });
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: failingStub,
      owner: 'stager-d9',
    });
    expect(summary.units[0].state).toBe('FAILED_KNOWN');
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    expect(attempt.mode).toBe('offline-stub');
    expect(attempt.authorization).toBeUndefined();
    expect(attempt.observedHostEvidence).toBeUndefined();
    expect(attempt.error).toContain('stub boom');
  });
});

// ===========================================================================
// G. FORMAL realHostBaseline (challenge-baseline.mjs) — record fields alone
//    never establish real-host acceptance; the host's own rollouts must
//    corroborate every session.
// ===========================================================================
describe('G. formal realHostBaseline from study files', () => {
  const fakeF2Attempt = (over: Record<string, any> = {}) => ({
    schema: 'challenge-attempt.v1',
    unit: { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' },
    mode: 'F2-real-host',
    authorization: { schema: STAGE_R_AUTH_SCHEMA, studyId: 'CEB-001', executionMode: 'F2-real-host', isolationAcceptance: { realHostProbe: { status: 'PASSED' } } },
    observedHostEvidence: { hostSessionId: 'forged-session-001', observedModelIdentity: 'test-double/never-real' },
    frozenRefs: { suiteHash: FROZEN.suiteHash },
    result: 'SUCCEEDED',
    ...over,
  });

  it('P1-8: a fully-forged attempt record (fake session, fake VERIFIED identity) cannot produce a formal PASS — rollout corroboration fails it', async () => {
    const dir = copyStudy('baseline-forgery');
    approveStudy(dir, f2WithProbe());
    const attemptDir = path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1');
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, 'a1.json'), `${JSON.stringify(fakeF2Attempt(), null, 2)}\n`, 'utf8');
    const codexHome = path.join(tmpRoot, `codexhome-empty-${++copyCounter}`);
    fs.mkdirSync(codexHome, { recursive: true });
    const verdict = deriveRealHostBaselineFromStudy(dir, { codexHome });
    expect(verdict.status).toBe('NOT_ESTIMABLE');
    expect(verdict.reasons.join(' ')).toContain('not corroborated');
  });

  it('P1-8: without an APPROVED F2 authority file there is no formal baseline, whatever the attempt files claim', async () => {
    const dir = copyStudy('baseline-noauth'); // live file stays NOT_AUTHORIZED
    const attemptDir = path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1');
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, 'a1.json'), `${JSON.stringify(fakeF2Attempt(), null, 2)}\n`, 'utf8');
    const verdict = deriveRealHostBaselineFromStudy(dir, { codexHome: path.join(tmpRoot, 'unused') });
    expect(verdict.status).toBe('NOT_ESTIMABLE');
    expect(verdict.reasons.join(' ')).toContain('no APPROVED F2-real-host authorization');
  });

  it('P1-8: missing codexHome refuses fail-closed — corroboration that cannot run cannot claim PASS', async () => {
    const dir = copyStudy('baseline-nocodexhome');
    approveStudy(dir, f2WithProbe());
    const attemptDir = path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1');
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, 'a1.json'), `${JSON.stringify(fakeF2Attempt(), null, 2)}\n`, 'utf8');
    const verdict = deriveRealHostBaselineFromStudy(dir);
    expect(verdict.status).toBe('NOT_ESTIMABLE');
    expect(verdict.reasons.join(' ')).toContain('codexHome not provided');
  });

  it('P1-8 (classifier): lineage-conflicting evidence is NOT_ESTIMABLE — a foreign suiteHash or a non-authorized identity never becomes acceptance evidence', () => {
    const good = { mode: 'F2-real-host', result: 'SUCCEEDED', frozenRefs: { suiteHash: FROZEN.suiteHash }, authorization: { isolationAcceptance: { realHostProbe: { status: 'PASSED' } } }, observedHostEvidence: { hostSessionId: 's1', observedModelIdentity: 'authorized/model-x' } };
    const expected = { suiteHash: FROZEN.suiteHash, requestedActorIdentity: 'model-x' };
    expect(deriveRealHostBaseline({ attempts: [good], expected }).status).toBe('PASS');
    const foreignSuite = { ...good, frozenRefs: { suiteHash: 'f'.repeat(64) } };
    expect(deriveRealHostBaseline({ attempts: [foreignSuite], expected }).status).toBe('NOT_ESTIMABLE');
    const foreignIdentity = { ...good, observedHostEvidence: { hostSessionId: 's1', observedModelIdentity: 'someone/else' } };
    expect(deriveRealHostBaseline({ attempts: [foreignIdentity], expected }).status).toBe('NOT_ESTIMABLE');
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
    expect(readStageRAuthorization(realStudyDir).status).toBe('NOT_AUTHORIZED'); // the authoritative reader sees the same file the gate enforces
    const hashes = readJson(realStudyDir, 'hashes.json');
    expect(hashes.mappingHash.value).toBe(FROZEN.mappingHash);
    expect(hashes.suiteHash.value).toBe(FROZEN.suiteHash);
    expect(hashes.graderHash.value).toBe(FROZEN.graderHash);
    expect(hashes.preregistrationHash.value).toBe(STUDY_PLAN_HASH);
    expect(verifyFrozenStudy(realStudyDir).suiteHash).toBe(FROZEN.suiteHash);
  });
});

// ===========================================================================
// H. automatic dispatch stop after consecutive RESULT_UNKNOWN settlements
//    (run-scoped machine enforcement of the owner pause rule; zero network —
//    every dispatch is an injected double)
// ===========================================================================
describe('H. automatic stop after consecutive RESULT_UNKNOWN settlements', () => {
  /** A real-mode double whose transport explodes ambiguously (dispatched,
   *  no usable result) — exactly the socket-hang-up class. */
  const ambiguousDouble = () => ({
    kind: 'real-model-double',
    executionMode: 'F1-direct-model',
    requestedModelIdentity: 'test-double/never-real',
    nextAction: () => { throw Object.assign(new Error('socket hang up mid-flight'), { ambiguous: true }); },
  });
  /** A known, non-ambiguous transport failure (http_500 class). */
  const knownFailDouble = () => ({
    kind: 'real-model-double',
    executionMode: 'F1-direct-model',
    requestedModelIdentity: 'test-double/never-real',
    nextAction: () => { throw new Error('http_500: upstream exploded'); },
  });
  const planN = (n: number) => ({ arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: Array.from({ length: n }, (_, i) => i + 1) });
  const authN = (n: number) => validStageRAuth({ repetitions: Array.from({ length: n }, (_, i) => String(i + 1)) });

  it('H1: two consecutive RESULT_UNKNOWN do NOT trigger the stop; a definite settlement resets the streak', async () => {
    const dir = copyStudy('streak-h1');
    approveStudy(dir, authN(4));
    let call = 0;
    const script = [ambiguousDouble, ambiguousDouble, realModePlayDouble, realModePlayDouble]; // U, U, S, S
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: planN(4),
      actorFactory: (ctx: any) => script[call++](ctx),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'streak-h1',
    });
    expect(summary.units.map((u: any) => u.state)).toEqual(['RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'SUCCEEDED', 'SUCCEEDED']);
    expect(summary.stoppedReason).toBeNull(); // never triggered at 2
    expect((summary.units as any[]).every((u) => u.state !== 'UNKNOWN_STREAK_STOPPED')).toBe(true);
  });

  it('H2: the 3rd consecutive RESULT_UNKNOWN stops all further dispatch — zero transport calls afterwards, everything recorded is preserved', async () => {
    const dir = copyStudy('streak-h2');
    approveStudy(dir, authN(6));
    let calls = 0;
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: planN(6),
      actorFactory: (ctx: any) => { calls += 1; return ambiguousDouble(); },
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'streak-h2',
    });
    const states = summary.units.map((u: any) => u.state);
    expect(states).toEqual(['RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'UNKNOWN_STREAK_STOPPED', 'UNKNOWN_STREAK_STOPPED', 'UNKNOWN_STREAK_STOPPED']);
    expect(summary.stoppedReason).toContain('stage_r_unknown_streak_stop');
    expect(calls).toBe(3); // units 4-6 never even reached the factory → zero further transport calls
    // reservations and request slots of the three settled units stay consumed and recorded
    const budget = createChallengeLedger(dir).budgetEntries();
    expect(budget.filter((e: any) => e.type === 'RESERVE')).toHaveLength(3);
    expect(budget.filter((e: any) => e.type === 'REQUEST_RESERVE')).toHaveLength(3);
    expect(budget.some((e: any) => e.type === 'REQUEST_REFUSED')).toBe(false); // the stop is not a budget refusal
    for (const r of [1, 2, 3]) {
      const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', `r${r}`, 'a1.json'));
      expect(attempt.result).toBe('RESULT_UNKNOWN'); // settled honestly, never disguised as a known failure
      expect(attempt.ambiguous).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r4'))).toBe(false); // stopped units have nothing on disk
    const stopRows = createChallengeLedger(dir).eventEntries().filter((e: any) => e.reason === 'stage_r_unknown_streak_stop');
    expect(stopRows).toHaveLength(3); // one audit row per stopped unit
  });

  it('H3: a FAILED_KNOWN settlement breaks the streak exactly like SUCCEEDED (definite settlements reset; refused units count for nothing)', async () => {
    const dir = copyStudy('streak-h3');
    approveStudy(dir, authN(7));
    let call = 0;
    const script = [ambiguousDouble, ambiguousDouble, knownFailDouble, ambiguousDouble, ambiguousDouble, ambiguousDouble, realModePlayDouble]; // U,U,F(known),U,U,U,S
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: planN(7),
      actorFactory: (ctx: any) => script[call++](ctx),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'streak-h3',
    });
    const states = summary.units.map((u: any) => u.state);
    expect(states).toEqual(['RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'FAILED_KNOWN', 'RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'UNKNOWN_STREAK_STOPPED']);
    expect(summary.stoppedReason).toContain('stage_r_unknown_streak_stop'); // the known failure reset the streak; the NEXT three unknowns stopped the run
  });

  it('H4: recovery after a streak stop — settled RESULT_UNKNOWN units are still never re-dispatched; unsettled units run again under a fresh reservation', async () => {
    const dir = copyStudy('streak-h4');
    approveStudy(dir, authN(4));
    const first = await runChallengeStudy({
      studyDir: dir,
      plan: planN(4),
      actorFactory: () => ambiguousDouble(),
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'streak-h4',
    });
    expect(first.units[3].state).toBe('UNKNOWN_STREAK_STOPPED');
    // second run: same attemptId — the three settled UNKNOWNs refuse recovery; r4 (never settled) executes normally
    let factoryCalls = 0;
    const second = await runChallengeStudy({
      studyDir: dir,
      plan: planN(4),
      actorFactory: (ctx: any) => { factoryCalls += 1; return realModePlayDouble(ctx); },
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'streak-h4',
    });
    const states = second.units.map((u: any) => u.state);
    expect(states).toEqual(['RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'SUCCEEDED']); // refusal ×3 (recovery), fresh execution
    expect(factoryCalls).toBe(1); // only the unsettled unit ever built an actor — settled attempts are never re-dispatched
    expect(second.stoppedReason).toBeNull(); // the streak restarts at zero on a new run; recovery refusals are not settlements
  });
});

// ===========================================================================
// I. capacity circuit breaker — consecutive PROVEN 429/5xx unit failures stop
//    dispatch (distinct from the unknown streak; identity/contract failures
//    never arm it). Zero network — responder doubles only.
// ===========================================================================
describe('I. capacity circuit breaker (consecutive provider-capacity failures)', () => {
  /** A real-mode double whose responder fails with a fixed error message. */
  const failingWith = (message: string) => () => ({
    kind: 'real-model-double',
    executionMode: 'F1-direct-model',
    requestedModelIdentity: 'test-double/never-real',
    nextAction: () => { throw new Error(message); },
  });
  const planN = (n: number) => ({ arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: Array.from({ length: n }, (_, i) => i + 1) });
  const authN = (n: number) => validStageRAuth({ repetitions: Array.from({ length: n }, (_, i) => String(i + 1)) });
  const runWith = (dir: string, factories: Array<() => any>, owner: string, n = factories.length) => runChallengeStudy({
    studyDir: dir,
    plan: planN(n),
    actorFactory: (() => { let i = 0; return (ctx: any) => (factories[i++] || realModePlayDouble)(ctx); })(),
    execution: { mode: 'F1-direct-model', now: NOW },
    maxAttemptsTotal: 10,
    owner,
  });

  it('I1: two consecutive 429 failures do NOT trip the breaker; a SUCCESS resets it', async () => {
    const dir = copyStudy('cap-i1');
    approveStudy(dir, authN(4));
    const summary = await runWith(dir, [failingWith('rate_limited (HTTP 429); Retry-After: unspecified — recorded, NOT auto-retried'), failingWith('rate_limited (HTTP 429); Retry-After: 77'), realModePlayDouble, realModePlayDouble], 'cap-i1');
    expect(summary.units.map((u: any) => u.state)).toEqual(['FAILED_KNOWN', 'FAILED_KNOWN', 'SUCCEEDED', 'SUCCEEDED']);
    expect(summary.stoppedReason).toBeNull();
  });

  it('I2: the 3rd consecutive 429 trips the breaker — remaining units CAPACITY_STREAK_STOPPED before any dispatch, all records kept', async () => {
    const dir = copyStudy('cap-i2');
    approveStudy(dir, authN(6));
    let factoryCalls = 0;
    const counting = () => { factoryCalls += 1; return failingWith('rate_limited (HTTP 429); Retry-After: unspecified')(); };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: planN(6),
      actorFactory: counting,
      execution: { mode: 'F1-direct-model', now: NOW },
      maxAttemptsTotal: 10,
      owner: 'cap-i2',
    });
    expect(summary.units.map((u: any) => u.state)).toEqual(['FAILED_KNOWN', 'FAILED_KNOWN', 'FAILED_KNOWN', 'CAPACITY_STREAK_STOPPED', 'CAPACITY_STREAK_STOPPED', 'CAPACITY_STREAK_STOPPED']);
    expect(summary.stoppedReason).toContain('stage_r_capacity_streak_stop');
    expect(factoryCalls).toBe(3); // units 4-6 never reached the factory → zero further requests
    const ledger = createChallengeLedger(dir);
    const budget = ledger.budgetEntries();
    expect(budget.filter((e: any) => e.type === 'RESERVE')).toHaveLength(3); // reservations kept, never returned
    expect(budget.filter((e: any) => e.type === 'ATTEMPT_RESULT')).toHaveLength(3); // the 429 units settled honestly as FAILED_KNOWN
    expect(ledger.eventEntries().filter((e: any) => e.reason === 'stage_r_capacity_streak_stop')).toHaveLength(3); // one audit row per stopped unit
    for (const r of [1, 2, 3]) {
      const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', `r${r}`, 'a1.json'));
      expect(attempt.result).toBe('FAILED_KNOWN');
      expect(attempt.error).toContain('rate_limited (HTTP 429)'); // original response evidence preserved
    }
  });

  it('I3: an explicit 5xx is a capacity failure too; a NON-capacity known failure (identity mismatch) BREAKS the streak', async () => {
    const dir = copyStudy('cap-i3');
    approveStudy(dir, authN(7));
    const summary = await runWith(dir, [
      failingWith('http_503: upstream overloaded'),
      failingWith('rate_limited (HTTP 429); Retry-After: 10'),
      failingWith('model_identity_mismatch: requested \'GLM-5.3-Flash\', server reports \'other\''), // NOT capacity — hard failure
      failingWith('http_500: boom'),
      failingWith('http_500: boom'),
      failingWith('http_500: boom'),
      realModePlayDouble,
    ], 'cap-i3');
    expect(summary.units.map((u: any) => u.state)).toEqual(['FAILED_KNOWN', 'FAILED_KNOWN', 'FAILED_KNOWN', 'FAILED_KNOWN', 'FAILED_KNOWN', 'FAILED_KNOWN', 'CAPACITY_STREAK_STOPPED']);
    expect(summary.stoppedReason).toContain('stage_r_capacity_streak_stop'); // the identity mismatch reset the streak; the NEXT three 5xx tripped it
  });

  it('I4: output-contract and authorization-class failures never arm the breaker (capped at 2 consecutive without a stop)', async () => {
    const dir = copyStudy('cap-i4');
    approveStudy(dir, authN(3));
    const summary = await runWith(dir, [
      failingWith('model_identity_unobserved: the server attested no model identity'),
      failingWith('empty or missing message content (finish_reason=stop)'),
      failingWith('http_429-not-the-prefix'),
    ], 'cap-i4');
    expect(summary.units.every((u: any) => u.state === 'FAILED_KNOWN')).toBe(true);
    expect(summary.stoppedReason).toBeNull(); // 3 consecutive NON-capacity failures never trip the capacity breaker
  });
});
