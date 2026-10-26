// SPEC-PD-EXAMINER-001 v0.3 — Phase 1B offline test suite: ActorTraceV1 +
// controlled Actor Loop, serial Runner with budget reservation / RESULT_UNKNOWN
// semantics, fault injection (10 scenarios), frozen-drift fail-closed, and the
// CEB-001 offline golden path end-to-end on study-directory COPIES.
//
// All stub actors are deterministic; no model, no network, no DB. The real
// frozen study dir is NEVER written by this suite — every scenario works on a
// copy under .tmp/phase1b-tests/. Green says nothing about real behavior:
// A/B/C execution evidence for real hosts stays NOT_RUN until Stage G/R.

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  runControlledActorLoop,
  createScriptedStub,
  perfectPlayActor,
  createGreedyObserverStub,
  createNaiveStub,
  SimulatedCrashError,
  DEFAULT_CHALLENGE_ACTOR_CAPS,
} from '../dev/principle-learning-lab/lib/challenge-actor.mjs';
import { buildClaimEnvironment, newClaimRunState } from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';
import {
  createChallengeLedger,
  acquireStudyWriteLock,
  releaseStudyWriteLock,
  StudyLockError,
} from '../dev/principle-learning-lab/lib/challenge-ledger.mjs';
import { verifyFrozenStudy, verifyArmConfigsFrozen, runChallengeStudy, FrozenStudyDriftError } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { sha256 } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realStudyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'phase1b-tests');

const FROZEN = {
  suiteHash: 'e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  graderHash: 'eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79',
  statementSha256: 'ae275f0f73d136e600bdbe63fdf44993e9669ad2e46387eeeceb2aa4c4a632bd',
};

let copyCounter = 0;
function copyStudy(tag: string): string {
  const dir = path.join(tmpRoot, `${tag}-${++copyCounter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(realStudyDir, dir, { recursive: true });
  return dir;
}
const readJson = (dir: string, rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const judgeOf = (dir: string, caseId: string) => readJson(dir, path.join('judge-only', `${caseId}.json`));
const visibleOf = (dir: string, caseId: string) => readJson(dir, path.join('actor-visible', `${caseId}.json`));

const observe = (obsId: string) => ({ type: 'observe', args: { obsId } });
const report = (claims: any[]) => ({ type: 'report', args: { claims } });
const claim = (factId: string, verdict: string, evidenceRef?: string, minimalSteps?: string) =>
  ({ factId, verdict, ...(evidenceRef !== undefined ? { evidenceRef } : {}), ...(minimalSteps !== undefined ? { minimalSteps } : {}) });

async function runLoopOn(dir: string, caseId: string, actor: any, caps?: any) {
  const caseDef = judgeOf(dir, caseId);
  const caseVisible = visibleOf(dir, caseId);
  const env = buildClaimEnvironment(caseDef);
  const runState = newClaimRunState(env);
  return runControlledActorLoop({ env, runState, caseVisible, actor, linkage: { suiteHash: FROZEN.suiteHash }, caps });
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

// ===========================================================================
// Stage B — controlled Actor Loop & ActorTraceV1
// ===========================================================================
describe('controlled actor loop & ActorTraceV1', async () => {
  it('records ordered actions/observations and terminates COMPLETED on report', async () => {
    const { trace } = await runLoopOn(realStudyDir, 'CEB-001-FV-01', createScriptedStub({
      actions: [
        observe('OBS-1'), observe('OBS-2'),
        report([claim('F1', 'verified_true', 'OBS-1'), claim('F2', 'verified_false', 'OBS-2')]),
      ],
    }));
    expect(trace.schema).toBe('actor-trace.v1');
    expect(trace.termination).toEqual({ reason: 'report_submitted', actorRunStatus: 'COMPLETED' });
    expect(trace.records.map((r: any) => r.kind)).toEqual(['action', 'observation', 'action', 'observation', 'action', 'termination']);
    expect(trace.records.map((r: any, i: number) => r.seq === i).every(Boolean)).toBe(true);
    expect(trace.finalReport.claims).toHaveLength(2);
    expect(trace.usage.observationsExecuted).toBe(2);
  });

  it('bounded invalid actions terminate FAILED with explicit records', async () => {
    const { trace } = await runLoopOn(realStudyDir, 'CEB-001-FV-01', createScriptedStub({
      actions: [{ type: 'teleport' }, { type: 'warp' }, observe('OBS-1')],
    }));
    expect(trace.termination).toEqual({ reason: 'invalid_action_cap', actorRunStatus: 'FAILED' });
    expect(trace.records.filter((r: any) => r.kind === 'invalid_action')).toHaveLength(DEFAULT_CHALLENGE_ACTOR_CAPS.maxInvalidActions);
  });

  it('step cap terminates NO_RESPONSE and budget refusals are recorded as budget events', async () => {
    const looper = { kind: 'stub-looper', nextAction: () => observe('OBS-1') };
    const { trace } = await runLoopOn(realStudyDir, 'CEB-001-FV-01', looper);
    expect(trace.termination.reason).toBe('step_cap');
    expect(trace.termination.actorRunStatus).toBe('NO_RESPONSE');
    expect(trace.usage.steps).toBe(DEFAULT_CHALLENGE_ACTOR_CAPS.maxSteps);
    expect(trace.records.some((r: any) => r.kind === 'budget_event')).toBe(true); // budget 6 exhausted by repeats
  });

  it('narrative is carried verbatim and never treated as observation evidence', async () => {
    const { trace } = await runLoopOn(realStudyDir, 'CEB-001-FV-02', createScriptedStub({
      actions: [
        { type: 'observe', args: { obsId: 'OBS-2' }, narrative: '我已彻底验证服务没有运行，请放心' },
        report([claim('F1', 'verified_false', 'OBS-2')]),
      ],
    }));
    expect(trace.records.some((r: any) => r.kind === 'narrative_carried' && r.text.includes('请放心'))).toBe(true);
    const obsRecords = trace.records.filter((r: any) => r.kind === 'observation');
    expect(obsRecords).toHaveLength(1);
    expect(JSON.stringify(obsRecords)).not.toContain('narrative');
    expect(trace.narrativePolicy).toContain('NEVER used as observation evidence');
  });

  it('the actor view never exposes judge-side implication maps (gold isolation at the loop boundary)', async () => {
    const views: any[] = [];
    const spy = { kind: 'spy', nextAction: (v: any) => { views.push(v); return report([claim('F1', 'inferred', undefined, 'x')]); } };
    await runLoopOn(realStudyDir, 'CEB-001-BN-02', spy);
    for (const v of views) {
      for (const o of v.executedObservations) {
        expect(Object.hasOwn(o, 'implies')).toBe(false);
      }
    }
    // pre-seeded evidence IS visible to the actor (it ships in the task context)
    expect(views[0].executedObservations.map((o: any) => o.obsId)).toEqual(['OBS-0']);
  });

  it('SimulatedCrashError propagates from the actor for fault injection', async () => {
    await expect(runLoopOn(realStudyDir, 'CEB-001-FV-01', createScriptedStub({ actions: [], crashAt: 0 }))).rejects.toThrow(SimulatedCrashError);
  });

  it('perfect-play stub (gold-informed fixture) completes the trap case correctly', async () => {
    const caseDef = judgeOf(realStudyDir, 'CEB-001-FV-01');
    const { trace, runState } = await runLoopOn(realStudyDir, 'CEB-001-FV-01', perfectPlayActor(caseDef));
    const adjudication = adjudicateClaimEvidence({ caseDef, runState });
    expect(trace.termination.actorRunStatus).toBe('COMPLETED');
    expect(adjudication.objectiveTaskOutcome).toBe('PASS');
    expect(trace.actorKind).toContain('gold-informed');
  });
});

// ===========================================================================
// Stage C — ledger, budget reservation, RESULT_UNKNOWN, locking
// ===========================================================================
describe('fault injection 1–2: reservation survives interruption', async () => {
  it('RESERVE without PREPARE: resume continues the same attempt without double-charging', async () => {
    const dir = copyStudy('fi1');
    const ledger = createChallengeLedger(dir);
    const unit = { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' };
    const reserve1 = ledger.reserveAttempt({ unit, maxAttemptsTotal: 10, reason: 'fi' });
    expect(reserve1.ok).toBe(true);
    expect(ledger.classifyUnit(unit).state).toBe('RESERVED_NOT_PREPARED');

    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef),
      maxAttemptsTotal: 10,
      owner: 'fi1',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    const reserves = ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE');
    expect(reserves).toHaveLength(1); // idempotent — crash did not double-charge
  });

  it('PREPARED without RESULT: classify RESULT_UNKNOWN; no attempt file; lock left held', async () => {
    const dir = copyStudy('fi2');
    const unit = { caseId: 'CEB-001-FV-01', armId: 'A', repetitionId: 1, attemptId: 'a1' };
    await expect(runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: () => createScriptedStub({ actions: [], crashAt: 1 }),
      owner: 'fi2-crasher',
    })).rejects.toThrow(SimulatedCrashError);

    const ledger = createChallengeLedger(dir);
    expect(ledger.classifyUnit(unit).state).toBe('RESULT_UNKNOWN');
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'runs', 'writer.lock'))).toBe(true); // crash leaves the lock
    const reserve = ledger.budgetEntries().filter((e: any) => e.type === 'RESERVE');
    expect(reserve).toHaveLength(1); // reservation NOT returned
  });
});

describe('fault injection 3–4: recorded results and RESULT_UNKNOWN recovery', async () => {
  it('already-recorded unit is skipped on re-run (result persisted, runner unconfirmed)', async () => {
    const dir = copyStudy('fi3');
    const plan = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] };
    const run = async () => await runChallengeStudy({ studyDir: dir, plan, actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'fi3' });
    await run();
    const attemptFile = path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json');
    const before = fs.readFileSync(attemptFile, 'utf8');
    const second = await run();
    expect(second.units[0]).toMatchObject({ state: 'SUCCEEDED', skipped: true });
    expect(fs.readFileSync(attemptFile, 'utf8')).toBe(before); // never overwritten
    expect(createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'RESERVE')).toHaveLength(1);
  });

  it('RESULT_UNKNOWN refuses auto-retry; a NEW attemptId runs fresh with its own reservation', async () => {
    const dir = copyStudy('fi4');
    const planA1 = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' };
    await expect(runChallengeStudy({ studyDir: dir, plan: planA1, actorFactory: () => createScriptedStub({ actions: [], crashAt: 1 }), owner: 'fi4' })).rejects.toThrow(SimulatedCrashError);
    releaseStudyWriteLock(dir, { owner: 'fi4' }); // crashed owner explicitly releases

    const refused = await runChallengeStudy({ studyDir: dir, plan: planA1, actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'fi4' });
    expect(refused.units[0]).toMatchObject({ state: 'RESULT_UNKNOWN', refused: true });

    const fresh = await runChallengeStudy({ studyDir: dir, plan: { ...planA1, attemptId: 'a2' }, actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'fi4' });
    expect(fresh.units[0].state).toBe('SUCCEEDED');

    const budget = createChallengeLedger(dir).budgetEntries();
    expect(budget.filter((e: any) => e.type === 'RESERVE')).toHaveLength(2); // a1 (kept) + a2
    const a1Entries = budget.filter((e: any) => e.unit && e.unit.attemptId === 'a1');
    expect(a1Entries.some((e: any) => e.type === 'ATTEMPT_PREPARED')).toBe(true);
    expect(a1Entries.some((e: any) => e.type === 'ATTEMPT_RESULT')).toBe(false); // a1 stays unknown forever
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-01', 'A', 'r1', 'a2.json'))).toBe(true);
  });
});

describe('fault injection 5: single-writer lock', async () => {
  it('a second concurrent runner is refused while the lock is held', async () => {
    const dir = copyStudy('fi5');
    acquireStudyWriteLock(dir, { owner: 'runner-1' });
    await expect(runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef),
      owner: 'runner-2',
    })).rejects.toThrow(StudyLockError);
    expect(() => acquireStudyWriteLock(dir, { owner: 'runner-2' })).toThrow(StudyLockError);
    releaseStudyWriteLock(dir, { owner: 'runner-1' });
    expect(acquireStudyWriteLock(dir, { owner: 'runner-2' })).toBeDefined(); // after release OK
    releaseStudyWriteLock(dir, { owner: 'runner-2' });
  });

  it('a foreign owner cannot release someone else\'s lock', async () => {
    const dir = copyStudy('fi5b');
    acquireStudyWriteLock(dir, { owner: 'runner-1' });
    expect(() => releaseStudyWriteLock(dir, { owner: 'runner-2' })).toThrow(StudyLockError);
    releaseStudyWriteLock(dir, { owner: 'runner-1' });
  });
});

describe('fault injection 6: budget exhaustion', async () => {
  it('exceeding the study attempt cap refuses units fail-closed with an audit row', async () => {
    const dir = copyStudy('fi6');
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01', 'CEB-001-FV-02'], repetitions: [1] },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef),
      maxAttemptsTotal: 1,
      owner: 'fi6',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    expect(summary.units[1]).toMatchObject({ state: 'BUDGET_EXHAUSTED', refused: true });
    const budget = createChallengeLedger(dir).budgetEntries();
    expect(budget.filter((e: any) => e.type === 'RESERVE')).toHaveLength(1);
    expect(budget.some((e: any) => e.type === 'BUDGET_REFUSED')).toBe(true);
  });
});

describe('fault injection 7: scoring failure', async () => {
  it('a scorer error marks the attempt FAILED_KNOWN without fabricating a result', async () => {
    const dir = copyStudy('fi7');
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef),
      owner: 'fi7',
      deps: { adjudicate: () => { throw new Error('scoring backend exploded'); } },
    });
    expect(summary.units[0].state).toBe('FAILED_KNOWN');
    expect(summary.units[0].detail).toContain('scoring backend exploded');
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    expect(attempt.result).toBe('FAILED_KNOWN');
    expect(attempt.adjudication).toBeUndefined();
  });
});

describe('fault injection 8: frozen asset drift mid-run', async () => {
  it('tampering judge-only gold between units refuses the next unit fail-closed', async () => {
    const dir = copyStudy('fi8');
    // Injection point: the FIRST actor step of unit 1 (mid-execution). The
    // Stage R readiness gate moved actor creation BEFORE the per-unit frozen
    // verification (a non-stub actor must be classified before any budget
    // mutation), so tampering inside the factory would now land before unit
    // 1's own verification. Tampering on the first nextAction keeps the
    // scenario's observable contract: drift introduced between unit 1's
    // verification and unit 2's verification → unit 2 refuses fail-closed.
    const tamperAtFirstUnit = (ctx: any) => {
      const inner = perfectPlayActor(ctx.caseDef);
      let tampered = false;
      return {
        kind: 'stub-fi8-midrun-tamper',
        nextAction(view: any) {
          if (!tampered) {
            tampered = true;
            if (ctx.caseId === 'CEB-001-FV-01') {
              const judgeFile = path.join(dir, 'judge-only', 'CEB-001-FV-02.json');
              const j = JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
              j.facts[0].goldTruth = !j.facts[0].goldTruth; // silently flip the gold
              fs.writeFileSync(judgeFile, `${JSON.stringify(j, null, 2)}\n`);
            }
          }
          return inner.nextAction(view);
        },
      };
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01', 'CEB-001-FV-02'], repetitions: [1] },
      actorFactory: tamperAtFirstUnit,
      owner: 'fi8',
    });
    expect(summary.units[0].state).toBe('SUCCEEDED');
    expect(summary.units[1]).toMatchObject({ state: 'SUITE_DRIFT', refused: true });
    expect(summary.units[1].detail).toContain('goldHash drift');
    expect(fs.existsSync(path.join(dir, 'runs', 'CEB-001-FV-02', 'A', 'r1', 'a1.json'))).toBe(false);
    expect(createChallengeLedger(dir).eventEntries().some((e: any) => e.reason === 'frozen_study_drift')).toBe(true);
  });

  it('verifyFrozenStudy refuses actor-visible, scoring-contract and manifest drift directly', async () => {
    const dir = copyStudy('fi8b');
    expect(verifyFrozenStudy(dir).suiteHash).toBe(FROZEN.suiteHash);
    const visibleFile = path.join(dir, 'actor-visible', 'CEB-001-FV-01.json');
    const v = JSON.parse(fs.readFileSync(visibleFile, 'utf8'));
    v.taskText += '（运行期悄悄改题）';
    fs.writeFileSync(visibleFile, `${JSON.stringify(v, null, 2)}\n`);
    expect(() => verifyFrozenStudy(dir)).toThrow(FrozenStudyDriftError);
  });
});

describe('fault injection 9: new attempt after a known failure', async () => {
  it('FAILED_KNOWN attempt is kept; a fresh attemptId runs and both records coexist', async () => {
    const dir = copyStudy('fi9');
    const planA1 = { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1], attemptId: 'a1' };
    const fail = await runChallengeStudy({
      studyDir: dir, plan: planA1,
      actorFactory: () => ({ kind: 'stub-throwing', nextAction: () => { throw new Error('stub internal error'); } }),
      owner: 'fi9',
    });
    expect(fail.units[0].state).toBe('FAILED_KNOWN');

    const rerunSame = await runChallengeStudy({ studyDir: dir, plan: planA1, actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'fi9' });
    expect(rerunSame.units[0].skipped).toBe(true); // same attemptId never re-executed

    const fresh = await runChallengeStudy({ studyDir: dir, plan: { ...planA1, attemptId: 'a2' }, actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'fi9' });
    expect(fresh.units[0].state).toBe('SUCCEEDED');
    const results = createChallengeLedger(dir).budgetEntries().filter((e: any) => e.type === 'ATTEMPT_RESULT');
    expect(results.map((e: any) => e.unit.attemptId)).toEqual(['a1', 'a2']);
    expect(results[0].result).toBe('FAILED_KNOWN');
    expect(results[1].result).toBe('SUCCEEDED');
  });
});

describe('fault injection 10: arm content mixing', async () => {
  it('swapping summary text into arm B is rejected by the frozen arm verification', async () => {
    const dir = copyStudy('fi10');
    const armFile = path.join(dir, 'arm-configs.json');
    const armConfigs = JSON.parse(fs.readFileSync(armFile, 'utf8'));
    const summaryText = readJson(dir, 'arm-payload-experience-summary.json').text;
    armConfigs.arms.B.delivery.payloadText = summaryText; // accidental mixing
    armConfigs.arms.B.delivery.payloadHash = sha256(summaryText);
    fs.writeFileSync(armFile, `${JSON.stringify(armConfigs, null, 2)}\n`);
    expect(() => verifyArmConfigsFrozen(dir)).toThrow(/arm B payloadHash/);
    const summary = await runChallengeStudy({
      studyDir: dir, plan: { arms: ['B'], cases: ['CEB-001-FV-01'], repetitions: [1] },
      actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'fi10',
    });
    expect(summary.units[0]).toMatchObject({ state: 'SUITE_DRIFT', refused: true });
  });
});

// ===========================================================================
// Stage C extras — ledger robustness
// ===========================================================================
describe('ledger robustness', async () => {
  it('a torn final line (crash mid-append) is dropped and reported, never interpreted', async () => {
    const dir = copyStudy('ledger1');
    const ledger = createChallengeLedger(dir);
    const unit = { caseId: 'X', armId: 'A', repetitionId: 1, attemptId: 'a1' };
    ledger.reserveAttempt({ unit, maxAttemptsTotal: 5, reason: 't' });
    fs.appendFileSync(path.join(dir, 'budget-ledger.jsonl'), '{"seq":2,"type":"RESERVE","unit":{"caseId":"TORN"', 'utf8');
    const { budgetMalformedTail } = createChallengeLedger(dir);
    expect(budgetMalformedTail()).toBe(true);
    expect(createChallengeLedger(dir).budgetEntries()).toHaveLength(1);
    expect(createChallengeLedger(dir).classifyUnit({ caseId: 'X', armId: 'A', repetitionId: 1, attemptId: 'a1' }).state).toBe('RESERVED_NOT_PREPARED');
  });
});

// ===========================================================================
// Stage D — offline golden path end-to-end on a study copy
// ===========================================================================
describe('offline golden path (CEB-001, 12 cases × 3 arms × 1 rep, stub)', async () => {
  const fullPlan = (dir: string) => {
    const manifest = readJson(dir, 'suite-manifest.json');
    return { arms: ['A', 'B', 'C'], cases: manifest.cases.map((c: any) => c.caseId), repetitions: [1] };
  };

  it('perfect-play stub: 36 units SUCCEEDED, all PASS, per-arm payload audits recorded', async () => {
    const dir = copyStudy('e2e-perfect');
    const summary = await runChallengeStudy({ studyDir: dir, plan: fullPlan(dir), actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), maxAttemptsTotal: 40, owner: 'e2e' });
    expect(summary.units).toHaveLength(36);
    expect(summary.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    expect(summary.units.every((u: any) => u.objectiveTaskOutcome === 'PASS')).toBe(true);

    for (const u of summary.units) {
      const attempt = readJson(dir, path.join('runs', u.unit.caseId, u.unit.armId, 'r1', 'a1.json'));
      expect(attempt.trace.schema).toBe('actor-trace.v1');
      expect(attempt.trace.linkage.suiteHash).toBe(FROZEN.suiteHash);
      expect(attempt.trace.linkage.mappingHash).toBe(FROZEN.mappingHash);
      expect(attempt.trace.linkage.graderHash).toBe(FROZEN.graderHash);
      if (u.unit.armId === 'A') expect(attempt.promptAudit.payloadHash).toBe(sha256(''));
      if (u.unit.armId === 'B') expect(attempt.promptAudit.payloadHash).toBe(FROZEN.statementSha256);
    }
    // boundary case BN-02: perfect play cites pre-seeded evidence — restrained, no negative transfer
    const bn02 = readJson(dir, path.join('runs', 'CEB-001-BN-02', 'A', 'r1', 'a1.json'));
    expect(bn02.adjudication.overCheck.overCheckOccurred).toBe(false);
    expect(bn02.adjudication.negativeTransfer).toBe(false);
    expect(createChallengeLedger(dir).adjudicationEntries()).toHaveLength(36);
  });

  it('determinism: two fresh copies produce byte-identical adjudication ledgers', async () => {
    const dirA = copyStudy('e2e-det-a');
    const dirB = copyStudy('e2e-det-b');
    const factory = (ctx: any) => perfectPlayActor(ctx.caseDef);
    await runChallengeStudy({ studyDir: dirA, plan: fullPlan(dirA), actorFactory: factory, maxAttemptsTotal: 40, owner: 'e2e' });
    await runChallengeStudy({ studyDir: dirB, plan: fullPlan(dirB), actorFactory: factory, maxAttemptsTotal: 40, owner: 'e2e' });
    const a = fs.readFileSync(path.join(dirA, 'adjudications.jsonl'), 'utf8');
    const b = fs.readFileSync(path.join(dirB, 'adjudications.jsonl'), 'utf8');
    expect(a).toBe(b);
  });

  it('naive surface-compliance stub FAILS the trap case and is recorded as such', async () => {
    const dir = copyStudy('e2e-naive');
    const summary = await runChallengeStudy({ studyDir: dir, plan: { arms: ['A'], cases: ['CEB-001-FV-01', 'CEB-001-CT-02'], repetitions: [1] }, actorFactory: () => createNaiveStub(), owner: 'e2e' });
    expect(summary.units.find((u: any) => u.unit.caseId === 'CEB-001-FV-01').objectiveTaskOutcome).toBe('FAIL');
    expect(summary.units.find((u: any) => u.unit.caseId === 'CEB-001-CT-02').objectiveTaskOutcome).toBe('FAIL'); // asserted unobservable as verified
  });

  it('greedy observer (never fabricates direction) passes inference cases, fails required-verification cases', async () => {
    const dir = copyStudy('e2e-greedy');
    const summary = await runChallengeStudy({ studyDir: dir, plan: { arms: ['A'], cases: ['CEB-001-FV-01', 'CEB-001-CT-02', 'CEB-001-BN-03'], repetitions: [1] }, actorFactory: () => createGreedyObserverStub(), owner: 'e2e' });
    expect(summary.units.find((u: any) => u.unit.caseId === 'CEB-001-FV-01').objectiveTaskOutcome).toBe('FAIL'); // abstained on verifiable required claims
    expect(summary.units.find((u: any) => u.unit.caseId === 'CEB-001-CT-02').objectiveTaskOutcome).toBe('PASS');
    expect(summary.units.find((u: any) => u.unit.caseId === 'CEB-001-BN-03').objectiveTaskOutcome).toBe('PASS');
  });

  it('runtime gold isolation: attempt traces contain no judge-side gold fields', async () => {
    const dir = copyStudy('e2e-gold');
    await runChallengeStudy({ studyDir: dir, plan: { arms: ['A'], cases: ['CEB-001-FV-01'], repetitions: [1] }, actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), owner: 'e2e' });
    const attempt = readJson(dir, path.join('runs', 'CEB-001-FV-01', 'A', 'r1', 'a1.json'));
    const traceStr = JSON.stringify(attempt.trace);
    for (const forbidden of ['goldTruth', 'implies', 'acceptableVerdicts', 'expectedMode']) {
      expect(traceStr.includes(forbidden)).toBe(false);
    }
    expect(JSON.stringify(attempt.adjudication).includes('claimOutcomes')).toBe(true); // judge record separate
  });

  it('the run CLI executes the golden path on a copy end-to-end (subprocess, exit 0)', async () => {
    const dir = copyStudy('e2e-cli');
    const out = execFileSync('node', [path.join(labRoot, 'run-challenge-study.mjs'), '--study-dir', dir, '--strategy', 'perfect-play', '--max-attempts', '40'], { encoding: 'utf8' });
    expect(out).toContain('frozen OK');
    expect(out).toContain('units=36');
    expect(out).toContain('"SUCCEEDED":36');
  });

  it('the REAL frozen study dir is untouched by this suite (ledgers pristine, hashes stable)', async () => {
    expect(fs.statSync(path.join(realStudyDir, 'budget-ledger.jsonl')).size).toBe(0);
    expect(fs.statSync(path.join(realStudyDir, 'events.jsonl')).size).toBe(0);
    expect(fs.statSync(path.join(realStudyDir, 'adjudications.jsonl')).size).toBe(0);
    expect(verifyFrozenStudy(realStudyDir).suiteHash).toBe(FROZEN.suiteHash);
    expect(fs.existsSync(path.join(realStudyDir, 'runs'))).toBe(false);
  });
});

// ===========================================================================
// Section 8 — PRI-1037 host isolation remains a separate blocker
// ===========================================================================
describe('PRI-1037 host isolation evidence remains UNKNOWN (not auto-passed)', async () => {
  it('the contamination audit keeps real-host items UNKNOWN and blocking', async () => {
    const audit = readJson(realStudyDir, 'a-baseline-contamination-audit.json');
    expect(audit.conclusion.realHostBaseline).toBe('UNKNOWN');
    expect(audit.conclusion.blocksRealExperiments).toBe(true);
    expect(audit.conclusion.offlineStubBaseline).toBe('SCANNED_CLEAN');
    for (const item of audit.unverifiableInPhase1A) expect(item.status.startsWith('UNKNOWN')).toBe(true);
    const run = readJson(realStudyDir, 'run-authorization.json');
    expect(run.status).toBe('NOT_AUTHORIZED');
  });
});
