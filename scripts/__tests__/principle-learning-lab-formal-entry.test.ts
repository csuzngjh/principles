// PRI-966 — formal study entry: zero-network gate-sequence tests.
//
// The formal CLI must refuse BEFORE any model call on: missing/unsigned
// authorization, hash drift, missing credentials, bad references — and its
// arm plan must be exactly the preregistered C-A four conditions. All tests
// drive the pure pieces (verifier, prereg view join) directly and the CLI
// via child processes in --dry-run mode (which performs every gate check
// and exits before any transport is built). No sockets, no model calls.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeApprovedPreregView,
  createFileEvidenceVerifier,
} from '../dev/principle-learning-lab/lib/evidence-verifier.mjs';
import { loadDataset } from '../dev/principle-learning-lab/lib/fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(HERE, '..', 'dev', 'principle-learning-lab');
const RUNS = path.join(LAB, 'runs', 'formal-2026-10-23');
const dataset = loadDataset(path.join(LAB, 'fixtures'));

describe('file evidence verifier (fail-closed by construction)', () => {
  const verifier = createFileEvidenceVerifier({ baseDir: RUNS });

  it('authenticates the Owner decision file and re-checks approved + fixtureHash', () => {
    const evidence = verifier({ kind: 'owner-decision', reference: 'owner-decision.json' });
    expect(evidence.verified).toBe(true);
    expect(evidence.approved).toBe(true);
    expect(evidence.fixtureHash).toBe(dataset.fixtureHash);
    expect(evidence.decidedBy).toContain('Owner');
  });

  it('authenticates the cost basis and flags official verification state honestly', () => {
    const evidence = verifier({ kind: 'cost-basis', reference: 'cost-basis.json' });
    expect(evidence.verified).toBe(true);
    expect(evidence.provider).toBe('zai-coding-cn');
    expect(evidence.model).toBe('glm-5.3-flash');
    expect(evidence.inputUsdPerMillionTokens).toBe(0.15);
    expect(evidence.officialPriceVerified).toBe(false); // catalog+tracker evidence, no official effective-date proof yet
  });

  it('refuses: missing files, non-approving content, hash mismatch, traversal outside the material dir, unknown kinds', () => {
    expect(() => verifier({ kind: 'owner-decision', reference: 'missing.json' })).toThrow(/cannot read/);
    expect(() => verifier({ kind: 'owner-decision', reference: '../outside.json' })).toThrow(/escapes/);
    expect(() => verifier({ kind: 'convenient-forgery', reference: 'owner-decision.json' })).toThrow(/unsupported kind/);
    // a decision file WITHOUT approved:true can never authenticate
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-verifier-'));
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ approved: false, fixtureHash: dataset.fixtureHash }), 'utf8');
    const v2 = createFileEvidenceVerifier({ baseDir: dir });
    expect(() => v2({ kind: 'owner-decision', reference: 'd.json' })).toThrow(/approved: true/);
    // absolute references are refused outright (relative-to-material-dir contract)
    expect(() => v2({ kind: 'owner-decision', reference: path.join(dir, 'd.json') })).toThrow(/must be relative/);
  });

  it('the caller-side hash re-check catches approval of a DIFFERENT dataset (drift = no run)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-verifier-'));
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ approved: true, fixtureHash: 'deadbeef'.repeat(8), decidedBy: 'x', decidedAt: '2026-10-23T00:00:00Z' }), 'utf8');
    const v2 = createFileEvidenceVerifier({ baseDir: dir });
    const evidence = v2({ kind: 'owner-decision', reference: 'd.json' });
    expect(evidence.fixtureHash).not.toBe(dataset.fixtureHash); // caller must refuse on this
  });
});

describe('approved preregistration view (approval lives beside the file, never inside it)', () => {
  const draft = JSON.parse(fs.readFileSync(path.join(LAB, 'fixtures', 'preregistration.json'), 'utf8'));

  it('joins the untouched DRAFT with an approving record; the draft object is not mutated', () => {
    const before = JSON.stringify(draft);
    const view = composeApprovedPreregView({
      prereg: draft,
      decisionRecord: { approved: true, reference: 'owner-decision.json', decidedBy: 'Owner', decidedAt: '2026-10-23T00:00:00Z' },
    });
    expect(view.status).toBe('OWNER_APPROVED');
    expect(view.approval.decisionRef).toBe('owner-decision.json');
    expect(JSON.stringify(draft)).toBe(before); // frozen file object untouched
    expect(draft.status).toBe('DRAFT_NOT_OWNER_APPROVED');
  });

  it('refuses to compose without an approving record (a DRAFT can never authorize)', () => {
    expect(() => composeApprovedPreregView({ prereg: draft, decisionRecord: null })).toThrow(/can never authorize/);
    expect(() => composeApprovedPreregView({ prereg: draft, decisionRecord: { approved: false } })).toThrow(/approved: true/);
  });
});

describe('formal CLI gate sequence (child process, --dry-run, zero network)', () => {
  const CLI = path.join(LAB, 'run-formal-study.mjs');
  // Placeholder credential for the gate's non-emptiness check. Built from a
  // variable so no credential-shaped literal exists in the tree; a dry run
  // makes no calls and this value authenticates nothing anywhere.
  const PLACEHOLDER_PARTS = ['test-only', 'gate-placeholder'];
  function runCli({ auth = path.join(RUNS, 'authorization.json'), env = {}, extra = [] } = {}) {
    return spawnSync(process.execPath, [CLI, '--authorization', auth, '--dry-run', ...extra], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...env, ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY ?? PLACEHOLDER_PARTS.join('-') },
    });
  }
  function runCliWithoutCredential() {
    const env = { ...process.env };
    delete env.ZAI_CODING_CN_API_KEY;
    return spawnSync(process.execPath, [CLI, '--authorization', path.join(RUNS, 'authorization.json'), '--dry-run'], {
      encoding: 'utf8',
      timeout: 120_000,
      env,
    });
  }

  it('full happy path (seed 2..3 continuation): every gate passes and the dry run stops before any transport exists', () => {
    // the default seed-1 output directory already holds Seed 1's completed
    // study on this machine — the continuation window 2..3 is the real
    // happy path, and the seed-1 collision is asserted separately below
    const r = runCli({ extra: ['--start-seed', '2', '--seed-count', '2'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('authorization verified');
    expect(r.stdout).toContain('seeds 2..3 → PLE-PILOT-01-FORMAL-S2, PLE-PILOT-01-FORMAL-S3');
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('EA:policy → EA:summary → EA:raw → EA:none');
  });

  it('the default seed-1 window refuses when Seed 1 already holds a completed study (no silent re-run)', () => {
    const r = runCli();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('never re-run or overwritten');
  });

  it('missing credentials refuse before any HTTP (fail-closed, zero requests)', () => {
    const r = runCliWithoutCredential();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is not set');
    expect(r.stdout).not.toContain('DRY RUN');
  });

  it('a nonexistent authorization file refuses immediately', () => {
    const r = runCli({ auth: path.join(os.tmpdir(), 'no-such-authorization.json') });
    expect(r.status).not.toBe(0);
  });

  it('hash drift between the Owner decision and the loaded dataset refuses (drift = no run)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-formal-'));
    const auth = JSON.parse(fs.readFileSync(path.join(RUNS, 'authorization.json'), 'utf8'));
    auth.od1.frozenFixtureHash = 'deadbeef'.repeat(8);
    fs.writeFileSync(path.join(dir, 'authorization.json'), JSON.stringify(auth, null, 1), 'utf8');
    fs.copyFileSync(path.join(RUNS, 'owner-decision.json'), path.join(dir, 'owner-decision.json'));
    fs.copyFileSync(path.join(RUNS, 'cost-basis.json'), path.join(dir, 'cost-basis.json'));
    // the decision record still approves the REAL hash — gate compares the
    // record's frozenFixtureHash against the FRESH dataset hash and the
    // evidence re-check, so a doctored authorization drifts out loudly
    const r = runCli({ auth: path.join(dir, 'authorization.json') });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/drift|does not equal|match/i);
  });

  it('the arm plan is exactly the preregistered four conditions, nothing added or dropped', () => {
    const r = runCli();
    expect(r.stdout).toContain('EA:policy');
    expect(r.stdout).toContain('EA:summary');
    expect(r.stdout).toContain('EA:raw');
    expect(r.stdout).toContain('EA:none');
    expect((r.stdout.match(/EA:/g) ?? []).length).toBe(4);
  });

  it('start-seed window is bounded by the preregistered 1-3 range (no silent seed 4)', () => {
    const ok = runCli({ extra: ['--start-seed', '2', '--seed-count', '2'] });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('seeds 2..3 → PLE-PILOT-01-FORMAL-S2, PLE-PILOT-01-FORMAL-S3');
    expect(ok.stdout).toContain('DRY RUN');
    for (const bad of [['--start-seed', '0'], ['--start-seed', '4'], ['--start-seed', '2', '--seed-count', '3']]) {
      const r = runCli({ extra: bad });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/preregistered 1-3 range|must be an integer/);
    }
  });

  it('completed seeds are never re-run or overwritten (seed 1 output presence refuses)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-formal-out-'));
    // the historical seed-1 invocation wrote the base study id; simulate its
    // completed output being present in the output root
    fs.mkdirSync(path.join(dir, 'PLE-PILOT-01-FORMAL'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'PLE-PILOT-01-FORMAL', 'principle-study.json'), '{}', 'utf8');
    const r = runCli({ extra: ['--out', dir] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('never re-run or overwritten');
  });
});
