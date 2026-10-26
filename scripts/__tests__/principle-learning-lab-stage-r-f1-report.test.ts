// SPEC §12.4 — Stage R F1 report recomputation tests.
//
// The round-1 bigmodel run left a COMPLETE audited dataset (11/22/3 across
// 36 units — independently verified in STAGE-R-F1-ROUND1-DATA-AUDIT). These
// tests recompute the report from that raw data and assert the audited
// baseline numbers, proving "报告可从轨迹重算" for the first real run.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStageRF1Report } from '../dev/principle-learning-lab/lib/stage-r-f1-report.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
// the round-1 study copy (read-only — the report builder never mutates it)
const ROUND1_DIR = path.resolve(labRoot, '..', '..', '.tmp', 'stage-r-f1-bigmodel');
const hasRound1Data = fs.existsSync(path.join(ROUND1_DIR, 'budget-ledger.jsonl'));

describe('Stage R F1 report recomputation (SPEC §12.4)', () => {
  it('recomputes the audited round-1 baseline from raw files (36 units, 11/22/3, PASS 11, 4 triple-arm pairs)', async () => {
    if (!hasRound1Data) return; // dataset lives in the run worktree; guard other checkouts
    const report = buildStageRF1Report(ROUND1_DIR);
    // plan grid
    expect(report.plan).toEqual({ plannedUnits: 36, arms: { A: 12, B: 12, C: 12 } });
    // audited status distribution
    expect(report.statusCounts).toEqual({ SUCCEEDED: 11, RESULT_UNKNOWN: 22, FAILED_KNOWN: 3 });
    // 11/11 objective PASS on the scored denominator
    expect(report.denominators).toMatchObject({ allPlanned: 36, successfullyScored: 11, unknown: 22, failedKnown: 3 });
    // budget (this authorization: 39/1424)
    expect(report.budget).toMatchObject({ attemptsUsed: 36, attemptsRemaining: 3, requestsUsed: 70, requestsRemaining: 1354 });
    // audited token totals (ok rounds only)
    expect(report.totals.promptTokens).toBe(36482);
    expect(report.totals.completionTokens).toBe(18528);
    expect(report.totals.identities).toEqual(['glm-5.3-flash']);
    // four complete triple-arm PASS pairs (FV-02/FV-03/CT-03/BN-02)
    expect(report.completeTripleArmPairs.sort()).toEqual(['CEB-001-BN-02', 'CEB-001-CT-03', 'CEB-001-FV-02', 'CEB-001-FV-03']);
    // integrity: no duplicate settlements, no unplanned files, no broken SUCCEEDED records
    expect(report.integrity.duplicates).toBe(0);
    expect(report.integrity.unplanned).toEqual([]);
    expect(report.integrity.findings).toEqual([]);
    // per-arm rollups match the audited table
    expect(report.byArm.A).toMatchObject({ planned: 12, SUCCEEDED: 4, RESULT_UNKNOWN: 6, FAILED_KNOWN: 2, pass: 4, modelRequests: 22 });
    expect(report.byArm.B).toMatchObject({ planned: 12, SUCCEEDED: 3, RESULT_UNKNOWN: 8, FAILED_KNOWN: 1, pass: 3, modelRequests: 24 });
    expect(report.byArm.C).toMatchObject({ planned: 12, SUCCEEDED: 4, RESULT_UNKNOWN: 8, FAILED_KNOWN: 0, pass: 4, modelRequests: 24 });
    // every unit appears exactly once with exactly one status
    expect(report.units).toHaveLength(36);
    for (const u of report.units) expect(['SUCCEEDED', 'RESULT_UNKNOWN', 'FAILED_KNOWN']).toContain(u.status);
  });

  it('flags data faults as findings instead of throwing (SUCCEEDED without trace/adjudication)', async () => {
    const dir = path.join(labRoot, '..', '..', '.tmp', 'stage-r-f1-report-tests');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'runs', 'CEB-001-X-01', 'A', 'r1'), { recursive: true });
    fs.copyFileSync(
      path.join(labRoot, 'challenge-studies', 'CEB-001', 'suite-manifest.json'),
      path.join(dir, 'suite-manifest.json'),
    );
    // minimal synthetic study: manifest + auth + ledgers + one broken attempt
    const manifest = readJson2(path.join(labRoot, 'challenge-studies', 'CEB-001', 'suite-manifest.json'));
    fs.writeFileSync(path.join(dir, 'suite-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'run-authorization.json'), JSON.stringify({
      status: 'APPROVED', requestedActorIdentity: 'glm-5.3-flash', executionMode: 'F1-direct-model',
      attemptCap: 3, requestCap: 12, validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z', issuedBy: 't',
    }));
    fs.writeFileSync(path.join(dir, 'budget-ledger.jsonl'), `${JSON.stringify({ type: 'RESERVE', unit: { caseId: manifest.cases[0].caseId, armId: 'A', repetitionId: 1, attemptId: 'a1' } })}\n${JSON.stringify({ type: 'REQUEST_RESERVE', unit: { caseId: manifest.cases[0].caseId, armId: 'A', repetitionId: 1, attemptId: 'a1' } })}\n${JSON.stringify({ type: 'ATTEMPT_RESULT', unit: { caseId: manifest.cases[0].caseId, armId: 'A', repetitionId: 1, attemptId: 'a1' }, result: 'SUCCEEDED' })}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'adjudications.jsonl'), '', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'runs', 'CEB-001-X-01', 'A', 'r1', 'a1.json'),
      JSON.stringify({ unit: { caseId: manifest.cases[0].caseId, armId: 'A', repetitionId: 1, attemptId: 'a1' }, result: 'SUCCEEDED', actorRounds: [{ ok: true, observedModelIdentity: 'glm-5.3-flash', usage: { prompt_tokens: 10, completion_tokens: 5 } }] }),
      'utf8',
    );
    const report = buildStageRF1Report(dir);
    expect(report.statusCounts).toEqual({ SUCCEEDED: 1, NOT_SETTLED: 35 }); // synthetic study: 1 settled of the 36-unit grid
    // the broken record has no trace/adjudication → the builder FLAGS it
    expect(report.integrity.findings.some((f) => f.includes('without trace+adjudication'))).toBe(true);
  });
});

function readJson2(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
