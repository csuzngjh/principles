// SPEC-PD-EXAMINER-001 v0.4 — CLI Stage R F1 entry tests (run-challenge-study.mjs).
//
// SAFETY BOUNDARY: every case here is ZERO-NETWORK by construction. The CLI's
// F1 path reaches the network ONLY through the Stage R gate; these tests
// exercise the gate's REFUSAL paths and the --dry-run plan verification, never
// an authorized run (an authorized F1 run would dispatch real model requests
// and is covered by fully-injected suites at the runner/transport layer, not
// here). Credentials are never read: createAmdActorResponder only resolves a
// key inside respond(), which is unreachable while the gate refuses.

import { describe, expect, it, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStudyPlanHash } from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';
import { createRealModelActor } from '../dev/principle-learning-lab/lib/challenge-actor-transport.mjs';
import { createChallengeLedger } from '../dev/principle-learning-lab/lib/challenge-ledger.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const realStudyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const cliPath = path.join(labRoot, 'run-challenge-study.mjs');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'cli-f1-tests');

const FROZEN_SUITE_HASH = 'e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a';
// Simulated clock for dry-runs: DYNAMIC (the current instant) so fixtures
// stay valid regardless of when CI runs. Fixed absolute windows would make
// these tests fail (or worse, change refusal reasons) as real time moves.
const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const NOW = nowIso();

let copyCounter = 0;
function copyStudy(tag: string): string {
  const dir = path.join(tmpRoot, `${tag}-${++copyCounter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(realStudyDir, dir, { recursive: true });
  return dir;
}

/** File-level side-effect audit: append-only ledgers byte-identical, no run
 *  records, no attempt files. The strongest zero-side-effect evidence. */
function ledgerFingerprint(dir: string): string {
  const files = ['budget-ledger.jsonl', 'events.jsonl', 'adjudications.jsonl'];
  return files.map((f) => {
    const p = path.join(dir, f);
    return `${f}:${fs.existsSync(p) ? fs.statSync(p).size : 'absent'}`;
  }).join('|') + `|runs:${fs.existsSync(path.join(dir, 'runs'))}`;
}

/** An APPROVED F1 fixture written into the COPIED study's authoritative file
 *  (the same injection path the production runner reads). Covers ALL 12
 *  frozen cases so the CLI default plan (A/B/C × 12) is inside the grant. */
function approveF1(dir: string, over: Record<string, any> = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'suite-manifest.json'), 'utf8'));
  const record = {
    schema: 'challenge-stage-authorization.v1',
    stage: 'R',
    status: 'APPROVED',
    studyId: 'CEB-001',
    suiteHash: FROZEN_SUITE_HASH,
    mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
    graderHash: 'eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79',
    studyPlanHash: readStudyPlanHash(dir),
    requestedActorIdentity: 'GLM-5.3-Flash',
    executionMode: 'F1-direct-model',
    arms: ['A', 'B', 'C'],
    cases: manifest.cases.map((c: any) => c.caseId),
    repetitions: ['1'],
    attemptCap: 40,
    requestCap: 80,
    issuedBy: 'owner-test-fixture',
    validFrom: nowIso(-24 * 3600e3),
    validUntil: nowIso(+24 * 3600e3),
    revoked: false,
    halted: false,
    ...over,
  };
  fs.writeFileSync(path.join(dir, 'run-authorization.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function runCli(args: string[], studyDir: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [cliPath, '--study-dir', studyDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('CLI Stage R F1 entry — dry-run and refusal paths (zero network by construction)', () => {
  it('E1: --dry-run on the LIVE NOT_AUTHORIZED copy verifies the plan, refuses at the gate, and writes NOTHING', () => {
    const dir = copyStudy('dry-unauth');
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('STAGE R GATE REFUSED');
    expect(r.out).toContain('NOT_AUTHORIZED');
    expect(r.out).toContain('plan — study=CEB-001 units=36');
    expect(r.out).not.toMatch(/sk-[A-Za-z0-9]|Bearer /); // no credential material ever
    expect(ledgerFingerprint(dir)).toBe(before); // zero ledger/attempt side effects
  });

  it('E1: --dry-run on an APPROVED F1 copy passes the gate without any execution', () => {
    const dir = copyStudy('dry-approved');
    approveF1(dir);
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain('authorizedModel=GLM-5.3-Flash');
    expect(r.out).toContain('attemptCap=40 (used 0) | requestCap=80 (used 0)');
    expect(r.out).toContain('worst-case requests for THIS plan = 1440'); // 36 units × maxSteps=40 — the code-proven hard cap
    expect(r.out).toContain('DRY-RUN OK');
    expect(ledgerFingerprint(dir)).toBe(before);
  });

  it('E1: --dry-run stub path still works (Phase 1B plan verification, no gate)', () => {
    const dir = copyStudy('dry-stub');
    const before = ledgerFingerprint(dir);
    const r = runCli(['--dry-run'], dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain('mode=offline-stub');
    expect(r.out).toContain('DRY-RUN OK');
    expect(ledgerFingerprint(dir)).toBe(before);
  });

  it('E2: an UNAUTHORIZED F1 run (no --dry-run) is refused by the CLI pre-flight gate BEFORE the runner starts — zero ledger rows at all', () => {
    const dir = copyStudy('run-unauth');
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model'], dir); // no --now: real runs use the actual system clock
    expect(r.status).toBe(1);
    expect(r.out).toContain('STAGE R GATE REFUSED');
    expect(r.out).toContain('NOT_AUTHORIZED');
    // the CLI verifies the SAME gate function the runner enforces per-unit; a refused plan never enters the runner: zero ledger rows, zero network
    expect(ledgerFingerprint(dir)).toBe(before);
  });

  it('E3: wrong execution mode (F1 declared, F2-approved record) refuses; F2 via CLI is refused outright; missing --now refuses', () => {
    const dir = copyStudy('wrong-mode');
    approveF1(dir, { executionMode: 'F2-real-host', isolationAcceptance: { realHostProbe: { ticketId: 'PRI-1037', status: 'PASSED', evidenceRef: 'probe.json', suiteHash: FROZEN_SUITE_HASH } } });
    const r1 = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir);
    expect(r1.status).toBe(1);
    expect(r1.out).toContain('does not match the runner-declared');

    const dir2 = copyStudy('f2-cli');
    const r2 = runCli(['--execution-mode', 'F2-real-host', '--now', NOW], dir2);
    expect(r2.status).toBe(1);
    expect(r2.out).toContain('F2-real-host is not available through this CLI');

    const dir3 = copyStudy('no-clock');
    approveF1(dir3);
    // dry-run WITHOUT --now has no simulated clock to judge with — refused (never silently falls back)
    const r3 = runCli(['--execution-mode', 'F1-direct-model', '--dry-run'], dir3);
    expect(r3.status).toBe(1);
    expect(r3.out).toContain('--now');

    const dir4 = copyStudy('bad-clock');
    const r4 = runCli(['--execution-mode', 'F1-direct-model', '--now', 'not-a-timestamp', '--dry-run'], dir4);
    expect(r4.status).toBe(1);
    expect(r4.out).toContain('not a parseable timestamp');

    // B-security: --now WITHOUT --dry-run is the ambiguous combination — refused outright
    // (a caller-supplied clock must never reach a REAL execution's authorization judgment)
    const dir5 = copyStudy('now-real-run');
    const r5 = runCli(['--execution-mode', 'F1-direct-model', '--now', nowIso()], dir5);
    expect(r5.status).toBe(1);
    expect(r5.out).toContain('--now is only honored for --dry-run');
  });

  it('E3: an approved record whose requestedActorIdentity has NO registered transport wiring is refused at the CLI entry — before the runner, zero network, zero ledger rows', () => {
    const dir = copyStudy('wrong-identity');
    approveF1(dir, { requestedActorIdentity: 'other-provider/other-model' });
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model'], dir); // no --now: real runs judge with the actual clock
    expect(r.status).toBe(1); // transport selection is authorization-bound: an unregistered identity never reaches any provider
    expect(r.out).toContain('no F1 transport wiring is registered');
    expect(ledgerFingerprint(dir)).toBe(before); // the runner never started — zero ledger rows at all
  });

  it('E4 (CLI level): an EXPIRED authorization refuses in dry-run with zero side effects', () => {
    const dir = copyStudy('expired');
    approveF1(dir, { validFrom: nowIso(-72 * 3600e3), validUntil: nowIso(-24 * 3600e3) });
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('expired');
    expect(ledgerFingerprint(dir)).toBe(before);
  });

  it('E7: the CLI end-to-end stub golden path still passes after the F1 extension (subprocess, exit 0)', () => {
    const dir = copyStudy('stub-golden');
    const r = runCli(['--strategy', 'perfect-play', '--max-attempts', '40'], dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain('units=36');
    expect(r.out).toContain('"SUCCEEDED":36');
    expect(r.out).toContain('budget RESERVE rows: 36');
  });

  it('E7: the REAL frozen study dir remains pristine (ledgers empty, hashes stable, authorization NOT_AUTHORIZED)', () => {
    expect(fs.statSync(path.join(realStudyDir, 'budget-ledger.jsonl')).size).toBe(0);
    expect(fs.statSync(path.join(realStudyDir, 'events.jsonl')).size).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(realStudyDir, 'run-authorization.json'), 'utf8')).status).toBe('NOT_AUTHORIZED');
    const hashes = JSON.parse(fs.readFileSync(path.join(realStudyDir, 'hashes.json'), 'utf8'));
    expect(hashes.suiteHash.value).toBe(FROZEN_SUITE_HASH);
  });
});

// ===========================================================================
// B. Trusted clock — a caller-supplied --now can never bless a REAL run
// ===========================================================================
describe('B. trusted clock for real F1 execution', () => {
  it('B1: an EXPIRED authorization refuses a REAL run judged by the actual system clock — no simulated clock can rescue it', () => {
    const dir = copyStudy('real-expired');
    approveF1(dir, { validFrom: nowIso(-72 * 3600e3), validUntil: nowIso(-24 * 3600e3) });
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model'], dir); // real run: no --now exists on this path
    expect(r.status).toBe(1);
    expect(r.out).toContain('STAGE R GATE REFUSED');
    expect(r.out).toContain('expired');
    expect(ledgerFingerprint(dir)).toBe(before); // zero ledger rows, zero attempt files, zero network
  });

  it('B2: a NOT-YET-VALID authorization refuses a REAL run the same way', () => {
    const dir = copyStudy('real-future');
    approveF1(dir, { validFrom: nowIso(+72 * 3600e3), validUntil: nowIso(+96 * 3600e3) });
    const r = runCli(['--execution-mode', 'F1-direct-model'], dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('not yet valid');
  });

  it('B3 (runner contract): the clock is evaluated PER UNIT — a function clock refuses units after the window closes mid-run (injected responder, zero network)', async () => {
    const dir = copyStudy('per-unit-clock');
    approveF1(dir, { cases: ['CEB-001-FV-01', 'CEB-001-FV-02'] });
    const { runChallengeStudy } = await import('../dev/principle-learning-lab/lib/challenge-runner.mjs');
    const { releaseStudyWriteLock } = await import('../dev/principle-learning-lab/lib/challenge-ledger.mjs');
    let clockCalls = 0;
    const inside = Date.now();
    const after = Date.now() + 48 * 3600e3; // far beyond validUntil (now +24h)
    // 1st unit judged INSIDE the window, every later unit AFTER it closed
    const clock = () => (clockCalls++ === 0 ? inside : after);
    // a minimal legal responder: observe one real observation, then cite it in a report
    const responder = {
      modelId: 'GLM-5.3-Flash',
      calls: [] as any[],
      async respond(req: any) {
        responder.calls.push(req);
        const obs = req.view.caseVisible.availableObservations[0];
        if (req.view.executedObservations.length === 0) {
          return { ok: true, content: JSON.stringify({ type: 'observe', args: { obsId: obs.obsId } }), observedModelIdentity: 'GLM-5.3-Flash', finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } };
        }
        return { ok: true, content: JSON.stringify({ type: 'report', args: { claims: [{ factId: req.view.caseVisible.facts[0].factId, verdict: 'inferred', minimalSteps: 'observed directly' }] } }), observedModelIdentity: 'GLM-5.3-Flash', finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    };
    const summary = await runChallengeStudy({
      studyDir: dir,
      plan: { arms: ['A'], cases: ['CEB-001-FV-01', 'CEB-001-FV-02'], repetitions: [1] },
      actorFactory: (ctx: any) => createRealModelActor({ ctx, responder }),
      maxAttemptsTotal: 10,
      owner: 'clock-b3',
      execution: { mode: 'F1-direct-model', now: clock },
    });
    expect(summary.units[0].state).toBe('SUCCEEDED'); // judged inside the window
    expect(summary.units[1]).toMatchObject({ state: 'STAGE_R_REFUSED', refused: true });
    expect(summary.units[1].reasons.join(' ')).toContain('expired');
    expect(responder.calls.length).toBe(2); // first unit only (observe+report); the second unit never reached the transport
    const budget = createChallengeLedger(dir).budgetEntries();
    expect(budget.filter((e: any) => e.type === 'RESERVE')).toHaveLength(1); // only the first unit ever reserved
    releaseStudyWriteLock(dir, { owner: 'clock-b3' });
  });
});

// ===========================================================================
// C. Dry-run positive path — synthetic APPROVED fixture, proven zero effects
// ===========================================================================
describe('C. dry-run positive path (synthetic APPROVED fixture)', () => {
  it('C1: plan resolves; units/arms/reps/hashes/identity/budget reported; ZERO poster calls, ZERO actor runs, ledger fingerprint untouched, no credentials read', () => {
    const dir = copyStudy('dry-positive');
    approveF1(dir);
    const before = ledgerFingerprint(dir);
    // Simulate a machine with NO credentials: no env var, HOME pointed at an
    // empty dir (the key file cannot resolve). A dry-run must still succeed —
    // proving it never constructs the responder (credentials are only read
    // inside respond(), which a dry-run never reaches).
    const isolated = execFileSync('node', [cliPath, '--study-dir', dir, '--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, AMD_RADEON_API_KEY: '', HOME: dir, USERPROFILE: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(isolated).toContain('plan — study=CEB-001 units=36 (A/B/C × 12 cases × 1 repetition)');
    expect(isolated).toContain('authorizedModel=GLM-5.3-Flash');
    expect(isolated).toContain('attemptCap=40 (used 0) | requestCap=80 (used 0)');
    expect(isolated).toContain('worst-case requests for THIS plan = 1440');
    expect(isolated).toContain('frozen OK'); // suite/mapping/grader hashes verified
    expect(isolated).toContain('SIMULATED clock'); // the simulated verdict is labeled
    expect(isolated).toContain('DRY-RUN OK');
    expect(isolated).not.toContain('DONE'); // the runner never ran (no execution summary)
    expect(ledgerFingerprint(dir)).toBe(before); // byte-identical ledgers, no attempt files
  });

  it('C2: the LIVE authorization file is byte-identical before/after every fixture-based test (a test grant can never leak into the live study)', () => {
    const liveBefore = fs.readFileSync(path.join(realStudyDir, 'run-authorization.json'), 'utf8');
    const dir = copyStudy('leak-guard');
    approveF1(dir); // synthetic APPROVED grant in the COPY only
    expect(fs.readFileSync(path.join(dir, 'run-authorization.json'), 'utf8')).not.toBe(liveBefore);
    expect(JSON.parse(liveBefore).status).toBe('NOT_AUTHORIZED'); // the live file stays unapproved
    expect(fs.readFileSync(path.join(realStudyDir, 'run-authorization.json'), 'utf8')).toBe(liveBefore);
  });
});


// ===========================================================================
// D. authorization-bound transport selection (AMD / Shuxi Atria-Dawn)
// ===========================================================================
describe('D. authorization-bound F1 transport selection', () => {
  it('D1: an Atria-Dawn authorization selects the Shuxi wiring in dry-run (zero network, zero side effects)', () => {
    const dir = copyStudy('atria-dry');
    approveF1(dir, { requestedActorIdentity: 'Atria-Dawn' });
    const before = ledgerFingerprint(dir);
    const r = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain('authorizedModel=Atria-Dawn');
    expect(r.out).toContain('transport = Shuxi intern-ai-discovery (Atria-Dawn, no reasoning_effort)');
    expect(r.out).toContain('DRY-RUN OK');
    expect(ledgerFingerprint(dir)).toBe(before);
  });

  it('D2: a GLM-5.3-Flash authorization keeps the AMD wiring; an UNREGISTERED identity refuses fail-closed', () => {
    const dir = copyStudy('amd-dry');
    approveF1(dir); // default identity GLM-5.3-Flash
    const r1 = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir);
    expect(r1.status).toBe(0);
    expect(r1.out).toContain('transport = AMD radeon tokenfactory (GLM-5.3-Flash)');

    const dir2 = copyStudy('unknown-identity');
    approveF1(dir2, { requestedActorIdentity: 'gpt-9-nonexistent' });
    const r2 = runCli(['--execution-mode', 'F1-direct-model', '--now', NOW, '--dry-run'], dir2);
    expect(r2.status).toBe(1);
    expect(r2.out).toContain('no F1 transport wiring is registered');
  });
});
