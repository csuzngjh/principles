// SPEC §12.4 — Stage R F1 report recomputation tests.
//
// The positive path ALWAYS runs: it recomputes a full 36-unit SYNTHETIC study
// that mirrors the audited round-1 settlement distribution (11 SUCCEEDED /
// 22 RESULT_UNKNOWN / 3 FAILED_KNOWN, including CEB-001-FV-02/B settling
// RESULT_UNKNOWN — the arm that only succeeded in the LATER recovery batch,
// never in round 1). No external worktree, personal directory or real run
// data decides whether these tests execute: everything is built in a
// system-temp directory that the suite itself creates and removes.
//
// Pairing ground truth: the round-1 evidence yields exactly THREE complete
// triple-arm PASS pairs (BN-02 / CT-03 / FV-03). The original audit line
// claiming four (including FV-02) was corrected by the PR #2167 independent
// verification — FV-02's B arm is RESULT_UNKNOWN in round 1 raw data, so it
// cannot be a complete pair in ANY dataset that mirrors round 1.
//
// The real round-1 bigmodel dataset (read-only, lives in the run worktree)
// is NOT a test dependency; when present it is exercised as a separate
// read-only integration check by hand, never committed.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStageRF1Report } from '../dev/principle-learning-lab/lib/stage-r-f1-report.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realManifest = JSON.parse(fs.readFileSync(path.join(labRoot, 'challenge-studies', 'CEB-001', 'suite-manifest.json'), 'utf8'));
const CASE_IDS = realManifest.cases.map((c: any) => c.caseId);

/** Round-1 ground-truth settlement by unit (mirrors the audited 11/22/3). */
const ROUND1: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const caseId of CASE_IDS) for (const arm of ['A', 'B', 'C']) m[`${caseId}/${arm}`] = 'RESULT_UNKNOWN';
  for (const u of ['CEB-001-BN-02/A', 'CEB-001-BN-02/B', 'CEB-001-BN-02/C',
    'CEB-001-CT-03/A', 'CEB-001-CT-03/B', 'CEB-001-CT-03/C',
    'CEB-001-FV-02/A', 'CEB-001-FV-02/C', // FV-02/B stays RESULT_UNKNOWN (round-1 fact)
    'CEB-001-FV-03/A', 'CEB-001-FV-03/B', 'CEB-001-FV-03/C']) m[u] = 'SUCCEEDED';
  for (const u of ['CEB-001-FV-01/B', 'CEB-001-TC-02/A', 'CEB-001-TC-03/A']) m[u] = 'FAILED_KNOWN';
  return m;
})();

/** Per-arm request reservation counts mirroring the audited round-1 (22/24/24). */
const ARM_REQUESTS: Record<string, number> = { A: 22, B: 24, C: 24 };
/** Deterministic per-arm token seeds so the asserted totals are exact. */
const ARM_PROMPT_TOKENS: Record<string, number> = { A: 1000, B: 2000, C: 3000 };
const ARM_COMPLETION_TOKENS: Record<string, number> = { A: 100, B: 200, C: 300 };

const unitOf = (key: string) => {
  const [caseId, armId] = key.split('/');
  return { caseId, armId, repetitionId: 1, attemptId: 'a1' };
};

/** Build a complete synthetic round-1 study in dir. All files are created by
 *  this helper — nothing outside `dir` is ever written. */
function buildSyntheticStudy(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'suite-manifest.json'), JSON.stringify(realManifest));
  fs.writeFileSync(path.join(dir, 'run-authorization.json'), JSON.stringify({
    status: 'APPROVED', requestedActorIdentity: 'glm-5.3-flash', executionMode: 'F1-direct-model',
    attemptCap: 39, requestCap: 1424, validFrom: '2026-10-26T00:00:00Z', validUntil: '2026-10-28T00:00:00Z', issuedBy: 'synthetic fixture',
  }));
  const budget: any[] = [];
  const events: any[] = [];
  const adjudications: any[] = [];
  let seq = 0;
  let eseq = 0;
  events.push({ seq: ++eseq, type: 'RUN_STARTED', owner: 'synthetic' });
  for (const [caseIdx, caseId] of CASE_IDS.entries()) {
    for (const arm of ['A', 'B', 'C']) {
      const key = `${caseId}/${arm}`;
      const unit = unitOf(key);
      const unitIdx = caseIdx; // first unit of each arm books the arm's request surplus
      const status = ROUND1[key];
      budget.push({ seq: ++seq, type: 'RESERVE', unit, amount: 1, reason: 'synthetic' });
      // distribute the audited per-arm request totals (A22/B24/C24) over the
      // arm's 12 units: one request per unit, the rest booked on the first
      const unitRequests = unitIdx === 0 ? ARM_REQUESTS[arm] - 11 : 1;
      for (let i = 0; i < unitRequests; i++) {
        budget.push({ seq: ++seq, type: 'REQUEST_RESERVE', key: `a1:${key}:step${i}`, unit, amount: 1, reason: 'synthetic' });
      }
      budget.push({ seq: ++seq, type: 'ATTEMPT_PREPARED', unit });
      budget.push({ seq: ++seq, type: 'ATTEMPT_RESULT', unit, result: status, detail: status === 'SUCCEEDED' ? 'PASS' : status === 'RESULT_UNKNOWN' ? 'result_unknown (ambiguous transport outcome): request timeout after 240000ms (total)' : 'execution_error: rate_limited (HTTP 429)' });
      const attemptDir = path.join(dir, 'runs', caseId, arm, 'r1');
      fs.mkdirSync(attemptDir, { recursive: true });
      const attempt: any = { schema: 'challenge-attempt.v1', unit, mode: 'F1-direct-model', result: status };
      if (status === 'SUCCEEDED') {
        const adj = { objectiveTaskOutcome: 'PASS', behaviorAligned: true, forbiddenBehaviorOccurred: false, negativeTransfer: false };
        attempt.adjudication = adj;
        attempt.trace = { records: [{}, {}, {}] };
        adjudications.push({ unit, suiteHash: 'synthetic', objectiveTaskOutcome: 'PASS', adjudication: adj });
      } else if (status === 'RESULT_UNKNOWN') {
        attempt.ambiguous = true;
        attempt.error = 'result_unknown (ambiguous transport outcome): request timeout after 240000ms (total)';
      } else {
        attempt.error = 'execution_error: rate_limited (HTTP 429)';
      }
      attempt.actorRounds = [{ step: 0, ok: true, observedModelIdentity: 'glm-5.3-flash', usage: { prompt_tokens: ARM_PROMPT_TOKENS[arm], completion_tokens: ARM_COMPLETION_TOKENS[arm] } }];
      fs.writeFileSync(path.join(attemptDir, 'a1.json'), JSON.stringify(attempt));
      events.push({ seq: ++eseq, type: 'UNIT_PREPARED', unit });
      events.push({ seq: ++eseq, type: 'UNIT_FINISHED', unit, result: status });
    }
  }
  events.push({ seq: ++eseq, type: 'RUN_FINISHED', owner: 'synthetic' });
  fs.writeFileSync(path.join(dir, 'budget-ledger.jsonl'), budget.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'adjudications.jsonl'), adjudications.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** Fresh system-temp study per test; only the directory the helper created is removed. */
function withSyntheticStudy(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-r-f1-report-test-'));
    try {
      buildSyntheticStudy(dir);
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('Stage R F1 report recomputation (SPEC §12.4 — always-executed synthetic positive path)', () => {
  it('recomputes the full 36-unit round-1-shaped study: statuses, arms, budget, tokens, integrity',
    withSyntheticStudy((dir) => {
      const report = buildStageRF1Report(dir);
      // plan grid from the real frozen manifest
      expect(report.plan).toEqual({ plannedUnits: 36, arms: { A: 12, B: 12, C: 12 } });
      // audited round-1 status distribution
      expect(report.statusCounts).toEqual({ SUCCEEDED: 11, RESULT_UNKNOWN: 22, FAILED_KNOWN: 3 });
      expect(report.denominators).toMatchObject({ allPlanned: 36, successfullyScored: 11, unknown: 22, failedKnown: 3 });
      // budget accounting against the synthetic authorization (39/1424)
      expect(report.budget).toMatchObject({ attemptsUsed: 36, attemptsRemaining: 3, requestsUsed: 70, requestsRemaining: 1354 });
      // per-arm rollups mirror the audited table (A 4/6/2 pass4 · B 3/8/1 pass3 · C 4/8/0 pass4)
      expect(report.byArm.A).toMatchObject({ planned: 12, SUCCEEDED: 4, RESULT_UNKNOWN: 6, FAILED_KNOWN: 2, pass: 4, modelRequests: 22 });
      expect(report.byArm.B).toMatchObject({ planned: 12, SUCCEEDED: 3, RESULT_UNKNOWN: 8, FAILED_KNOWN: 1, pass: 3, modelRequests: 24 });
      expect(report.byArm.C).toMatchObject({ planned: 12, SUCCEEDED: 4, RESULT_UNKNOWN: 8, FAILED_KNOWN: 0, pass: 4, modelRequests: 24 });
      // deterministic token totals: per-unit seed × 12 units per arm
      expect(report.totals.promptTokens).toBe((ARM_PROMPT_TOKENS.A + ARM_PROMPT_TOKENS.B + ARM_PROMPT_TOKENS.C) * 12);
      expect(report.totals.completionTokens).toBe((ARM_COMPLETION_TOKENS.A + ARM_COMPLETION_TOKENS.B + ARM_COMPLETION_TOKENS.C) * 12);
      expect(report.totals.identities).toEqual(['glm-5.3-flash']);
      // every unit appears exactly once with exactly one settled status
      expect(report.units).toHaveLength(36);
      for (const u of report.units) expect(['SUCCEEDED', 'RESULT_UNKNOWN', 'FAILED_KNOWN']).toContain(u.status);
      // clean synthetic evidence: zero integrity findings
      expect(report.integrity).toEqual({ duplicates: 0, unplanned: [], findings: [] });
    }));

  it('counts exactly THREE complete triple-arm PASS pairs — FV-02/B is RESULT_UNKNOWN in round 1 and must not pair',
    withSyntheticStudy((dir) => {
      const report = buildStageRF1Report(dir);
      // the round-1 fact the original test got wrong: FV-02's B arm never succeeded
      expect(report.units.find((u: any) => u.caseId === 'CEB-001-FV-02' && u.armId === 'B')?.status).toBe('RESULT_UNKNOWN');
      // therefore exactly three complete pairs — BN-02 / CT-03 / FV-03
      expect(report.completeTripleArmPairs.sort()).toEqual(['CEB-001-BN-02', 'CEB-001-CT-03', 'CEB-001-FV-03']);
    }));

  it('drops a pair when one arm degrades — pairing follows the data, not a fixed list',
    withSyntheticStudy((dir) => {
      const file = path.join(dir, 'runs', 'CEB-001-FV-03', 'C', 'r1', 'a1.json');
      const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
      attempt.result = 'FAILED_KNOWN';
      attempt.adjudication = undefined;
      attempt.error = 'execution_error: rate_limited (HTTP 429)';
      fs.writeFileSync(file, JSON.stringify(attempt));
      // keep the append-only ledgers consistent with the rewritten file so the
      // only behavioral change under test is the pairing decision
      const budget = fs.readFileSync(path.join(dir, 'budget-ledger.jsonl'), 'utf8')
        .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
        .map((e) => (e.type === 'ATTEMPT_RESULT' && e.unit.caseId === 'CEB-001-FV-03' && e.unit.armId === 'C' ? { ...e, result: 'FAILED_KNOWN', detail: 'execution_error: rate_limited (HTTP 429)' } : e));
      fs.writeFileSync(path.join(dir, 'budget-ledger.jsonl'), budget.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
        .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
        .map((e) => (e.type === 'UNIT_FINISHED' && e.unit.caseId === 'CEB-001-FV-03' && e.unit.armId === 'C' ? { ...e, result: 'FAILED_KNOWN' } : e));
      fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const adjudications = fs.readFileSync(path.join(dir, 'adjudications.jsonl'), 'utf8')
        .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
        .filter((e: any) => !(e.unit.caseId === 'CEB-001-FV-03' && e.unit.armId === 'C'));
      fs.writeFileSync(path.join(dir, 'adjudications.jsonl'), adjudications.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const report = buildStageRF1Report(dir);
      expect(report.completeTripleArmPairs.sort()).toEqual(['CEB-001-BN-02', 'CEB-001-CT-03']);
    }));

  it('flags ledger↔file inconsistencies instead of trusting either side', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-r-f1-report-neg-'));
    try {
      buildSyntheticStudy(dir);
      // (a) drop one adjudications row → its SUCCEEDED file loses its ledger counterpart
      const adjPath = path.join(dir, 'adjudications.jsonl');
      const adj = fs.readFileSync(adjPath, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
      fs.writeFileSync(adjPath, adj.slice(1).map((e: any) => JSON.stringify(e)).join('\n') + '\n');
      // (b) drop one UNIT_FINISHED event → settled file without its runner event
      const evPath = path.join(dir, 'events.jsonl');
      const ev = fs.readFileSync(evPath, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
      const finishedIdx = ev.findIndex((e: any) => e.type === 'UNIT_FINISHED' && e.unit.armId === 'A');
      ev.splice(finishedIdx, 1);
      fs.writeFileSync(evPath, ev.map((e: any) => JSON.stringify(e)).join('\n') + '\n');
      // (c) an unplanned attempt file outside the plan grid
      fs.mkdirSync(path.join(dir, 'runs', 'CEB-001-ZZ-99', 'A', 'r1'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'runs', 'CEB-001-ZZ-99', 'A', 'r1', 'a1.json'), JSON.stringify({ unit: { caseId: 'CEB-001-ZZ-99', armId: 'A', repetitionId: 1, attemptId: 'a1' }, result: 'SUCCEEDED' }));
      const report = buildStageRF1Report(dir);
      const findings = report.integrity.findings.join('\n');
      expect(findings).toContain('has no adjudications.jsonl row');
      expect(findings).toContain('no UNIT_FINISHED event');
      expect(report.integrity.unplanned.length).toBe(1);
      // statistics stay untouched by cross-check findings (they flag, never reweight)
      expect(report.statusCounts).toEqual({ SUCCEEDED: 11, RESULT_UNKNOWN: 22, FAILED_KNOWN: 3 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a UNIT_FINISHED result that contradicts the attempt file, and orphan adjudication rows',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-r-f1-report-neg2-'));
      try {
        buildSyntheticStudy(dir);
        const evPath = path.join(dir, 'events.jsonl');
        const ev = fs.readFileSync(evPath, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
        const idx = ev.findIndex((e: any) => e.type === 'UNIT_FINISHED' && e.unit.caseId === 'CEB-001-CT-03' && e.unit.armId === 'B');
        ev[idx] = { ...ev[idx], result: 'FAILED_KNOWN' };
        fs.writeFileSync(evPath, ev.map((e: any) => JSON.stringify(e)).join('\n') + '\n');
        const adjPath = path.join(dir, 'adjudications.jsonl');
        const adj = fs.readFileSync(adjPath, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
        adj.push({ unit: { caseId: 'CEB-001-CT-02', armId: 'A', repetitionId: 1, attemptId: 'a1' }, objectiveTaskOutcome: 'PASS' });
        fs.writeFileSync(adjPath, adj.map((e: any) => JSON.stringify(e)).join('\n') + '\n');
        const report = buildStageRF1Report(dir);
        const findings = report.integrity.findings.join('\n');
        expect(findings).toContain('UNIT_FINISHED says FAILED_KNOWN, attempt file says SUCCEEDED');
        expect(findings).toContain('adjudications.jsonl row CEB-001-CT-02/A/1/a1 has no matching SUCCEEDED attempt file');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
});

/** Derive a mutated copy of the synthetic study and rebuild the report. */
async function reportFromMutatedStudy(mutate: (dir: string) => void): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-r-f1-report-neg3-'));
  try {
    buildSyntheticStudy(dir);
    mutate(dir);
    return buildStageRF1Report(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readLines = (p: string): any[] => fs.readFileSync(p, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
const writeLines = (p: string, lines: any[]) => fs.writeFileSync(p, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
const eventsPath = (dir: string) => path.join(dir, 'events.jsonl');
const adjudicationsPath = (dir: string) => path.join(dir, 'adjudications.jsonl');

describe('Stage R F1 report cross-check anomaly paths (duplicate / orphan / conflicting ledger rows)', () => {
  it('detects DUPLICATE adjudication rows for one SUCCEEDED unit (never folded by a Set)', async () => {
    const report = await reportFromMutatedStudy((dir) => {
      const adj = readLines(adjudicationsPath(dir));
      const victim = adj.find((a: any) => a.unit.caseId === 'CEB-001-BN-02' && a.unit.armId === 'A');
      adj.push(JSON.parse(JSON.stringify(victim))); // exact duplicate row
      writeLines(adjudicationsPath(dir), adj);
    });
    const finding = report.integrity.findings.find((f: string) => f.includes('CEB-001-BN-02/A: 2 duplicate adjudications.jsonl rows'));
    expect(finding).toBeDefined();
    // the statistics stay untouched by cross-check findings
    expect(report.statusCounts).toEqual({ SUCCEEDED: 11, RESULT_UNKNOWN: 22, FAILED_KNOWN: 3 });
  });

  it('detects two UNIT_FINISHED events with the SAME result for one unit', async () => {
    const report = await reportFromMutatedStudy((dir) => {
      const ev = readLines(eventsPath(dir));
      const victim = ev.find((e: any) => e.type === 'UNIT_FINISHED' && e.unit.caseId === 'CEB-001-FV-03' && e.unit.armId === 'A');
      ev.push({ ...victim, seq: 9999 }); // identical result, second event
      writeLines(eventsPath(dir), ev);
    });
    expect(report.integrity.findings.some((f: string) => f.includes('CEB-001-FV-03/A: 2 duplicate UNIT_FINISHED events (same result'))).toBe(true);
  });

  it('detects two UNIT_FINISHED events with CONFLICTING results for one unit', async () => {
    const report = await reportFromMutatedStudy((dir) => {
      const ev = readLines(eventsPath(dir));
      const victim = ev.find((e: any) => e.type === 'UNIT_FINISHED' && e.unit.caseId === 'CEB-001-FV-03' && e.unit.armId === 'A');
      ev.push({ ...victim, seq: 9999, result: 'FAILED_KNOWN' }); // contradicts the SUCCEEDED file
      writeLines(eventsPath(dir), ev);
    });
    const finding = report.integrity.findings.find((f: string) => f.includes('CEB-001-FV-03/A: 2 duplicate UNIT_FINISHED events (conflicting results'));
    expect(finding).toBeDefined();
    // the conflicting duplicate must NOT be silently resolved to either side's truth
    expect(report.integrity.findings.some((f: string) => f.includes('CEB-001-FV-03/A: UNIT_FINISHED says'))).toBe(false);
  });

  it('detects a UNIT_FINISHED event for a unit outside the frozen plan grid', async () => {
    const report = await reportFromMutatedStudy((dir) => {
      const ev = readLines(eventsPath(dir));
      ev.push({ seq: 9999, type: 'UNIT_FINISHED', unit: { caseId: 'CEB-001-ZZ-99', armId: 'A', repetitionId: 1, attemptId: 'a1' }, result: 'SUCCEEDED' });
      writeLines(eventsPath(dir), ev);
    });
    expect(report.integrity.findings.some((f: string) => f.includes('UNIT_FINISHED event for unplanned unit CEB-001-ZZ-99/A/1/a1 (SUCCEEDED)'))).toBe(true);
  });

  it('flags adjudication records without a unit field (missing and null variants) at their source line', async () => {
    const report = await reportFromMutatedStudy((dir) => {
      const adj = readLines(adjudicationsPath(dir));
      adj.push({ objectiveTaskOutcome: 'PASS' }); // parses fine, no unit at all
      adj.push({ unit: null, objectiveTaskOutcome: 'PASS' }); // explicit null variant
      writeLines(adjudicationsPath(dir), adj);
    });
    const findings = report.integrity.findings.join('\n');
    // both records are located by file + 1-based source line, never silently skipped
    expect(findings).toMatch(/adjudications\.jsonl line \d+: record without a unit field — cannot participate in unit matching/);
    expect(findings.match(/record without a unit field/g)?.length).toBe(2);
    // the unit-less records were NOT matched to any study unit: no unit gained a second row
    expect(findings).not.toContain('duplicate adjudications.jsonl rows');
    // statistics are untouched by the cross-check findings
    expect(report.statusCounts).toEqual({ SUCCEEDED: 11, RESULT_UNKNOWN: 22, FAILED_KNOWN: 3 });
    expect(report.denominators).toMatchObject({ allPlanned: 36, successfullyScored: 11 });
    expect(report.completeTripleArmPairs.sort()).toEqual(['CEB-001-BN-02', 'CEB-001-CT-03', 'CEB-001-FV-03']);
  });

  it('flags UNIT_FINISHED events without a unit field (missing and null variants) at their source line', async () => {
    const report = await reportFromMutatedStudy((dir) => {
      const ev = readLines(eventsPath(dir));
      ev.push({ seq: 9998, type: 'UNIT_FINISHED', result: 'SUCCEEDED' }); // no unit at all
      ev.push({ seq: 9999, type: 'UNIT_FINISHED', unit: null, result: 'FAILED_KNOWN' }); // null variant
      writeLines(eventsPath(dir), ev);
    });
    const findings = report.integrity.findings.join('\n');
    expect(findings).toMatch(/events\.jsonl line \d+: UNIT_FINISHED event without a unit field — cannot participate in unit matching/);
    expect(findings.match(/UNIT_FINISHED event without a unit field/g)?.length).toBe(2);
    // neither event was matched to any planned unit: no duplicate-event finding appeared
    expect(findings).not.toContain('duplicate UNIT_FINISHED events');
    // statistics are untouched by the cross-check findings
    expect(report.statusCounts).toEqual({ SUCCEEDED: 11, RESULT_UNKNOWN: 22, FAILED_KNOWN: 3 });
    expect(report.denominators).toMatchObject({ allPlanned: 36, successfullyScored: 11 });
    expect(report.completeTripleArmPairs.sort()).toEqual(['CEB-001-BN-02', 'CEB-001-CT-03', 'CEB-001-FV-03']);
  });
});
