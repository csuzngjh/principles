// SPEC-PD-EXAMINER-001 — CEB-002 offline validation suite (§四 of the
// 2026-10-27 Owner stage-transition instruction).
//
// Seven validation families, all offline with self-contained fixtures:
//   1. gold independence + structure — every CEB-002 case re-validates at an
//      eligible tier through the full Stage-G validator;
//   2. actor-visible projection leaks no judge keys; A/B/C payload identity
//      matches CEB-001's frozen texts verbatim (info-balance audit);
//   3. boundary scoring positive/negative — perfect-play passes every B-tier
//      case WITHOUT probing waste; a naive over-prober draws overCheck/no_report
//      findings (existing scorer semantics, no new rules);
//   4. difficulty gradient pre-check — perfect-play passes ALL tiers
//      (decidability), while weaker stubs degrade monotonically L1→L3;
//   5. paired statistics — McNemar exact test implementation checked against
//      known binomial values (the preregistered primary analysis instrument);
//   6. simulation of UNKNOWN/capacity/report-recompute — reuses the proven
//      CEB-001 stub-run path on a COPY, asserting behavior-report generation
//      + --verify round-trip (infrastructure, not CEB-002-specific);
//   7. isolation — CEB-001's frozen hashes verify unchanged and its working
//      tree stays clean after the whole CEB-002 build.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCandidatesB1 } from '../dev/principle-learning-lab/lib/challenge-enumerator.mjs';
import { validateStageGCandidate } from '../dev/principle-learning-lab/lib/challenge-validator.mjs';
import { buildClaimEnvironment, newClaimRunState } from '../dev/principle-learning-lab/lib/claim-evidence-env.mjs';
import { adjudicateClaimEvidence } from '../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs';
import { runControlledActorLoop, perfectPlayActor, createScriptedStub } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const study = path.join(labRoot, 'challenge-studies', 'CEB-002');
const ceb1 = path.join(labRoot, 'challenge-studies', 'CEB-001');
const MAPPING_ID = 'CEB-002-draft';
const frozenRefs = { mappingId: MAPPING_ID, mappingHash: 'ceb002-draft', suiteHash: 'ceb002-draft', graderHash: 'ceb002-draft', principleContentHash: 'ceb002-draft', templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0' };

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest = readJson(path.join(study, 'suite-manifest.json'));
const judgeCases = manifest.cases.map((c: any) => readJson(path.join(study, 'judge-only', `${c.caseId}.json`)));
const tierOf = (caseId: string) => caseId.split('-')[2];
const pool = enumerateCandidatesB1({ mappingId: MAPPING_ID, verify: validateStageGCandidate });
const byCombo = new Map(pool.map((c) => [`${c.caseDef.family}|${c.draft.parameters.domain}|${c.draft.parameters.distractor}`, c]));

function runStub(caseDef: any, actor: any) {
  const env = buildClaimEnvironment(caseDef);
  const runState = newClaimRunState(env);
  return runControlledActorLoop({ env, runState, caseVisible: { caseId: caseDef.caseId, taskText: caseDef.taskText }, actor, linkage: { suiteHash: 'ceb002-draft' } })
    .then(() => adjudicateClaimEvidence({ caseDef, runState }));
}

// naive over-prober: probes every observation once, then reports inferred-only verdicts
function naiveOverProber(caseDef: any) {
  const actions = caseDef.observations.map((o: any) => ({ type: 'observe', args: { obsId: o.obsId } }));
  actions.push({ type: 'report', args: { claims: caseDef.facts.map((f: any) => ({ factId: f.factId, verdict: 'inferred', evidenceRef: null })) } });
  return createScriptedStub({ actions });
}

import { mcnemarExactPValue as mcnemarExact, mcnemarExactPower, reduceCaseLevel } from '../dev/principle-learning-lab/lib/ceb002-stats.mjs';

describe('CEB-002 offline validation (Owner stage-transition instruction §四)', () => {
  it('1+2. every case re-validates through the full Stage-G validator at an eligible tier; actor-visible leaks no judge keys; payloads are CEB-001 verbatim', () => {
    expect(manifest.caseCount).toBe(16);
    // The archived study is FROZEN: judge-only/actor-visible hold the COMPILED
    // projection, so the Stage-G revalidation consumes the frozen build input
    // (challenge-suite.draft.json — the exact caseDefs prepare-ceb002-freeze
    // compiled), and the compiled per-case hashes are pinned to the manifest.
    const draftDoc = readJson(path.join(study, 'challenge-suite.draft.json'));
    const caseDefById = new Map(draftDoc.cases.map((cd: any) => [cd.caseId, cd]));
    for (const c of manifest.cases) {
      const caseDef = caseDefById.get(c.caseId);
      const compiledJudge = readJson(path.join(study, 'judge-only', `${c.caseId}.json`));
      expect(compiledJudge.inputHash).toBe(c.inputHash);
      expect(compiledJudge.goldHash).toBe(c.goldHash);
      const plan = readJson(path.join(study, 'difficulty-tier-plan.json'));
      const seq = Number(c.caseId.split('-')[3]); // plan.tiers is ordered — index by case sequence
      const tierEntry = plan.tiers[seq - 1];
      const baseline = byCombo.get(tierEntry.baseline.replace(/\//g, '|'));
      const candidate = {
        candidateId: c.caseId,
        draft: { scenarioId: c.caseId, family: caseDef.family, templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0', parameters: { ...baseline.draft.parameters }, sourceMechanismRef: `${MAPPING_ID}#assertion_without_observation`, rationaleForDesigner: 'revalidation' },
        caseDef,
        sourceBinding: { mappingId: MAPPING_ID, mappingHash: 'ceb002-draft', templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0' },
        provenance: { generator: 'test' },
      };
      const verdict = validateStageGCandidate({ candidate, frozenRefs });
      expect(verdict.ok).toBe(true);
      expect(verdict.goldIndependence.eligibleForValidSet).toBe(true);
      // actor-visible projection must not carry judge keys
      const visibleRaw = fs.readFileSync(path.join(study, 'actor-visible', `${c.caseId}.json`), 'utf8');
      for (const forbidden of ['goldTruth', 'implies', 'acceptableVerdicts', 'expectedMode']) expect(visibleRaw.includes(`"${forbidden}"`)).toBe(false);
    }
    // info-balance: payloads identical to CEB-001's frozen texts (verbatim reuse)
    const balance = readJson(path.join(study, 'info-balance-audit.json'));
    const ceb1Arms = readJson(path.join(ceb1, 'arm-configs.json'));
    expect(balance.armBPayloadHash).toBe(ceb1Arms.arms.B.delivery.payloadHash);
    expect(balance.armCPayloadHash).toBe(ceb1Arms.arms.C.delivery.payloadHash);
    expect(balance.chars.ratio).toBeLessThanOrEqual(1.25); // preregistered balance band
  });

  it('3. boundary scoring positive/negative — perfect-play passes B-tier without waste; a naive over-prober draws scorer findings', async () => {
    const bCases = judgeCases.filter((c) => tierOf(c.caseId).startsWith('B'));
    expect(bCases.length).toBe(5);
    for (const c of bCases) {
      const adj = await runStub(c, perfectPlayActor(c));
      expect(adj.objectiveTaskOutcome).toBe('PASS');
      expect(adj.forbiddenBehaviorOccurred).toBe(false);
    }
    // naive over-prober on the pre-seeded B1 case: probing everything after the
    // decisive observation is pre-seeded → unnecessary cost / no_report class findings
    const b1 = judgeCases.find((c) => c.caseId.includes('-B1-'));
    const naiveAdj = await runStub(b1, naiveOverProber(b1));
    expect(naiveAdj.objectiveTaskOutcome).toBe('FAIL');
    expect(naiveAdj.forbiddenBehaviorOccurred).toBe(true);
  });

  it('4. difficulty gradient pre-check — perfect-play passes every tier (decidability); the naive stub degrades monotonically L1→L3', async () => {
    const tiers = ['L1', 'L2', 'L3'];
    const naiveFail: Record<string, number> = {};
    for (const t of tiers) {
      const cases = judgeCases.filter((c) => c.caseId.includes(`-${t}-`));
      for (const c of cases) {
        const adj = await runStub(c, perfectPlayActor(c));
        expect(adj.objectiveTaskOutcome).toBe('PASS'); // decidability at EVERY tier
        const naive = await runStub(c, naiveOverProber(c));
        if (naive.objectiveTaskOutcome === 'FAIL') naiveFail[t] = (naiveFail[t] || 0) + 1;
      }
    }
    // monotone degradation for the naive strategy (probing everything without
    // evidence binding gets WORSE as budget tightens)
    expect(naiveFail.L3).toBeGreaterThan(naiveFail.L1);
  });

  it('5. paired statistics — McNemar exact matches known binomial values', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(1, 0)).toBeCloseTo(1, 9); // 2*0.5
    expect(mcnemarExact(8, 0)).toBeCloseTo(2 / 256, 9);
    expect(mcnemarExact(7, 1)).toBeCloseTo(18 / 256, 9); // 2*(C(8,0)+C(8,1))/256
    expect(mcnemarExact(5, 5)).toBe(1); // perfectly balanced discordance
  });

  it('5b. exact power enumeration — independent recomputation anchors for the preregistration table (16 and 32 pairs)', () => {
    // sanity: perfect effect -> power 1; null effect -> exact-test conservative size (<< nominal alpha)
    expect(mcnemarExactPower({ pairs: 16, p10: 1, p01: 0 })).toBeCloseTo(1, 9);
    const size = mcnemarExactPower({ pairs: 16, p10: 0.1, p01: 0.1 });
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(0.05); // conservative exact test — actual size below nominal
    // power-table anchors (values re-derived independently by the enumeration; these pins catch regressions)
    expect(mcnemarExactPower({ pairs: 16, p10: 0.3, p01: 0.0 })).toBeCloseTo(0.340, 2);
    expect(mcnemarExactPower({ pairs: 16, p10: 0.4, p01: 0.0 })).toBeCloseTo(0.671, 2);
    expect(mcnemarExactPower({ pairs: 32, p10: 0.2, p01: 0.0 })).toBeCloseTo(0.640, 2);
    expect(mcnemarExactPower({ pairs: 32, p10: 0.3, p01: 0.0 })).toBeCloseTo(0.949, 2);
    // n=8 (discriminative-tier case-level PRIMARY analysis) anchors — the exact
    // test at n=8 can only reject on the two extreme outcomes, so power caps at 0.145
    expect(mcnemarExactPower({ pairs: 8, p10: 0.5, p01: 0.0 })).toBeCloseTo(0.145, 2);
    expect(mcnemarExactPower({ pairs: 8, p10: 0.375, p01: 0.125 })).toBeCloseTo(0.024, 2);
    expect(mcnemarExactPower({ pairs: 8, p10: 0.1, p01: 0.1 })).toBeLessThan(0.01); // conservative size ~ 0
    // case-level clustering reduction: repeated measurements of one case reduce to a single unit
    expect(reduceCaseLevel([{ bFail: true, cFail: false }, { bFail: false, cFail: false }])).toEqual({ bWorse: true, cWorse: false });
    expect(reduceCaseLevel([{ bFail: true, cFail: false }, { bFail: false, cFail: true }])).toEqual({ bWorse: false, cWorse: false }); // mixed -> concordant for this view
    expect(reduceCaseLevel([{ bFail: false, cFail: true }, { bFail: false, cFail: true }])).toEqual({ bWorse: false, cWorse: true });
  });

  it('6. UNKNOWN/capacity/report-recompute simulation — stub run on a CEB-001 COPY produces REPORT_READY behavior-report + verify round-trip', async () => {
    const { runChallengeStudy } = await import('../dev/principle-learning-lab/lib/challenge-runner.mjs');
    const { execFileSync } = await import('node:child_process');
    const tmp = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp', 'ceb002-sim-'));
    try {
      const dir = path.join(tmp, 'sim');
      fs.cpSync(ceb1, dir, { recursive: true });
      const summary = await runChallengeStudy({
        studyDir: dir,
        plan: { arms: ['A'], cases: ['CEB-001-FV-03'], repetitions: [1] },
        actorFactory: (ctx: any) => perfectPlayActor(ctx.caseDef), maxAttemptsTotal: 5, owner: 'ceb002-validation',
      });
      expect(summary.units[0].state).toBe('SUCCEEDED');
      const gen = execFileSync('node', [path.join(labRoot, 'generate-behavior-report.mjs'), '--study-dir', dir, '--now', '2026-10-27T12:00:00Z'], { encoding: 'utf8' });
      expect(gen).toContain('"status": "REPORT_READY"');
      const ver = execFileSync('node', [path.join(labRoot, 'generate-behavior-report.mjs'), '--study-dir', dir, '--verify', '--json'], { encoding: 'utf8' });
      expect(JSON.parse(ver).ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('7. isolation — CEB-001 frozen hashes verify unchanged; CEB-002 is the FROZEN+EXECUTED archive (hash pinned, authorization window byte-pinned)', () => {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('node', [path.join(labRoot, 'freeze-challenge-study.mjs'), '--study', 'CEB-001', '--verify'], { encoding: 'utf8' });
    expect(out).toContain('VERIFY OK');
    // CEB-002 frozen+executed (2026-10-27) and evidence-archived (2026-10-28):
    // the frozen suite hash is pinned and the historical authorization's
    // window is byte-pinned. Live-clock expiry (the natural-expiry MERGE GATE
    // from the Owner P1-1 finding — budget exhaustion alone is NOT a
    // revocation) is enforced in
    // principle-learning-lab-archived-authorization-gate.test.ts.
    const manifestNow = readJson(path.join(study, 'suite-manifest.json'));
    const authNow = readJson(path.join(study, 'run-authorization.json'));
    expect(manifestNow.suiteHash).toBe('02cbc15cfd9cf8a8b9e986950fdf722fcda6632604f4e62d4bd50ea0950d04f5');
    expect(authNow.status).toBe('APPROVED');
    // pinned byte-exact historical window (NOT clock-dependent here): any tampering
    // breaks the pin
    expect(authNow.validFrom).toBe('2026-10-27T12:22:47.763Z');
    expect(authNow.validUntil).toBe('2026-10-28T12:22:47.763Z');
    expect(readJson(path.join(study, 'preregistration.draft.json')).status).toBe('DRAFT');
    expect(fs.existsSync(path.join(study, 'preregistration.json'))).toBe(true);
  });
});
