// Archived-study authorization isolation gate (Owner P1-1 finding, 2026-10-28).
//
// The evidence archives of CEB-002 (this PR) and CEB-003-P (merged #2193)
// preserve their HISTORICAL execution authorizations byte-exact as research
// evidence — including validUntil windows that extend into 2026-10-28. An
// APPROVED record with revoked=false/halted=false whose window is still open
// can pass the Stage R gate against a FRESH budget ledger (a study copy with
// truncated ledgers): study-directory budget exhaustion does NOT revoke the
// authorization — the gate and the ledger are different checks.
//
// Isolation scheme (the Owner-sanctioned early-merge path): the retirement
// registry challenge-studies/authorization-revocations.json retires both
// records AT THE GATE — refused at ANY clock time, against ANY study copy,
// including the review's exact attack path (copy + truncated ledgers +
// in-window clock). The registry travels with the lab code, so copying study
// data cannot shed it. Natural window expiry remains as an independent
// backstop (the records keep their original windows; the clock eventually
// closes them too).
//
// Supersession note: an earlier revision of this file enforced the Owner's
// "wait for natural expiry before merge" policy with live-clock RED-until-
// expiry assertions. The retirement registry is strictly stronger (immediate,
// clock-independent) and replaces those assertions.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { readAuthorizationRevocations, isRetiredAuthorization } from '../dev/principle-learning-lab/lib/challenge-stage-r-gate.mjs';

const wtRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const labRoot = path.join(wtRoot, 'scripts/dev/principle-learning-lab');
const cli = path.join(labRoot, 'run-challenge-study.mjs');
const IN_WINDOW_CLOCKS = {
  // a moment strictly INSIDE each authorization's still-open validity window
  'CEB-002': '2026-10-28T06:00:00Z',
  'CEB-003-P': '2026-10-28T12:00:00Z',
};

const STUDIES = [
  {
    studyId: 'CEB-002',
    dir: path.join(labRoot, 'challenge-studies/CEB-002'),
    pinnedValidFrom: '2026-10-27T12:22:47.763Z',
    pinnedValidUntil: '2026-10-28T12:22:47.763Z',
    // this authorization predates the per-attempt cap binding — declaring one would refuse for the wrong reason
    extraArgs: [] as string[],
  },
  {
    studyId: 'CEB-003-P',
    dir: path.join(labRoot, 'challenge-studies/CEB-003-P'),
    pinnedValidFrom: '2026-10-27T17:13:04.371Z',
    pinnedValidUntil: '2026-10-28T17:13:04.371Z',
    // this authorization binds maxRequestsPerAttempt=10 — the gate requires the exact declaration
    extraArgs: ['--max-requests-per-attempt', '10'],
  },
];

function runCli(args: string[], studyDir: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [cli, '--study-dir', studyDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('archived-study authorization isolation (Owner P1-1: retirement registry)', () => {
  it('registry loads and is well-formed', () => {
    const entries = readAuthorizationRevocations();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e: any) => e.reason.length > 0)).toBe(true);
  });

  it('registry matcher: only the EXACT retirement tuple retires (near-misses are judged on their own merits)', () => {
    const entries = readAuthorizationRevocations();
    const auth = { studyId: 'CEB-002', suiteHash: '02cbc15cfd9cf8a8b9e986950fdf722fcda6632604f4e62d4bd50ea0950d04f5', validFrom: '2026-10-27T12:22:47.763Z', validUntil: '2026-10-28T12:22:47.763Z' };
    expect(isRetiredAuthorization(auth, entries)).toBe(true);
    expect(isRetiredAuthorization({ ...auth, validUntil: '2026-10-28T12:22:47.764Z' }, entries)).toBe(false); // 1ms window change ≠ retired
    expect(isRetiredAuthorization({ ...auth, suiteHash: '0'.repeat(64) }, entries)).toBe(false);
    expect(isRetiredAuthorization({ ...auth, studyId: 'CEB-999' }, entries)).toBe(false);
    expect(isRetiredAuthorization(auth, null)).toBe(false); // no registry passed = no retirements judged here
  });

  it('registry loader: a malformed registry file refuses LOUDLY (never silently ignores retirements)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revoc-malformed-'));
    try {
      fs.writeFileSync(path.join(tmp, 'authorization-revocations.json'), JSON.stringify({ schema: 'wrong-schema', entries: [] }), 'utf8');
      expect(() => readAuthorizationRevocations({ registryPath: path.join(tmp, 'authorization-revocations.json') })).toThrow(/malformed registry/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const study of STUDIES) {
    it(`${study.studyId}: the archived authorization's window must be BYTE-PINNED and REGISTERED as retired (tamper detection)`, () => {
      const auth = JSON.parse(fs.readFileSync(path.join(study.dir, 'run-authorization.json'), 'utf8'));
      expect(auth.status).toBe('APPROVED');
      expect(auth.revoked).toBe(false);
      expect(auth.halted).toBe(false);
      expect(auth.validFrom).toBe(study.pinnedValidFrom);
      expect(auth.validUntil).toBe(study.pinnedValidUntil);
      expect(isRetiredAuthorization(auth, readAuthorizationRevocations())).toBe(true);
    });

    it(`${study.studyId}: the archived study directory itself is REFUSED at an IN-WINDOW clock (retirement, not expiry)`, () => {
      const r = runCli(dryRunArgs(study, study.dir, IN_WINDOW_CLOCKS[study.studyId as keyof typeof IN_WINDOW_CLOCKS]), study.dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('STAGE R GATE REFUSED');
      expect(r.out).toContain('authorization retired');
      expect(r.out).not.toContain('authorization expired'); // in-window: the refusal ground is retirement, proving clock-independence
    });

    it(`${study.studyId}: fresh-ledger copy (the review attack path) is REFUSED at an IN-WINDOW clock — copying/truncating study data cannot shed the registry`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-auth-gate-'));
      try {
        fs.cpSync(study.dir, tmp, { recursive: true });
        for (const ledger of ['budget-ledger.jsonl', 'events.jsonl', 'adjudications.jsonl']) {
          fs.writeFileSync(path.join(tmp, ledger), '', 'utf8');
        }
        const r = runCli(dryRunArgs(study, tmp, IN_WINDOW_CLOCKS[study.studyId as keyof typeof IN_WINDOW_CLOCKS]), tmp);
        expect(r.status).toBe(1);
        expect(r.out).toContain('authorization retired');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

function dryRunArgs(study: { extraArgs: string[] }, studyDir: string, nowIso: string): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(studyDir, 'suite-manifest.json'), 'utf8'));
  return [
    '--execution-mode', 'F1-direct-model',
    '--arms', 'A,B,C',
    '--cases', manifest.cases.map((c: any) => c.caseId).join(','),
    '--repetitions', '1,2',
    '--max-attempts', '96',
    '--request-timeout-ms', '480000',
    ...study.extraArgs,
    '--dry-run', '--now', nowIso,
  ];
}
