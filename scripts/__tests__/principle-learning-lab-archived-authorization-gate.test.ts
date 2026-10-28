// Archived-study authorization merge gate (Owner P1-1 finding, 2026-10-28).
//
// The evidence archives of CEB-002 (this PR) and CEB-003-P (merged #2193)
// preserve their HISTORICAL execution authorizations byte-exact as research
// evidence — including validUntil windows that extend into 2026-10-28. An
// APPROVED record with revoked=false/halted=false whose window is still open
// can pass the Stage R gate against a FRESH budget ledger (a study copy with
// truncated ledgers): study-directory budget exhaustion does NOT revoke the
// authorization — the gate and the ledger are different checks.
//
// Per the Owner review, merge of such an archive must wait for NATURAL
// EXPIRY, machine-enforced. These tests are therefore RED until each study's
// authorization window has actually closed, and green forever after:
//
//   CEB-002   validUntil 2026-10-28T12:22:47.763Z
//   CEB-003-P validUntil 2026-10-28T17:13:04.371Z
//
// The fresh-ledger tests prove the exact attack path from the review (copy the
// study, truncate the ledgers, run) is refused by the gate on the CLOCK once
// expired — permanently closing both windows without touching any record.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const wtRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const labRoot = path.join(wtRoot, 'scripts/dev/principle-learning-lab');
const cli = path.join(labRoot, 'run-challenge-study.mjs');

const STUDIES = [
  {
    studyId: 'CEB-002',
    dir: path.join(labRoot, 'challenge-studies/CEB-002'),
    pinnedValidUntil: '2026-10-28T12:22:47.763Z',
    // this authorization predates the per-attempt cap binding — declaring one would refuse for the wrong reason
    extraArgs: [] as string[],
  },
  {
    studyId: 'CEB-003-P',
    dir: path.join(labRoot, 'challenge-studies/CEB-003-P'),
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

describe('archived-study authorization merge gate (Owner P1-1: natural expiry is a merge precondition)', () => {
  for (const study of STUDIES) {
    it(`${study.studyId}: the archived authorization's window must be BYTE-PINNED (tamper detection)`, () => {
      const auth = JSON.parse(fs.readFileSync(path.join(study.dir, 'run-authorization.json'), 'utf8'));
      expect(auth.status).toBe('APPROVED');
      expect(auth.revoked).toBe(false);
      expect(auth.halted).toBe(false);
      expect(auth.validUntil).toBe(study.pinnedValidUntil);
    });

    it(`${study.studyId}: merge gate — the archived authorization must be clock-EXPIRED at test time (RED until ${study.pinnedValidUntil}, by design)`, () => {
      const auth = JSON.parse(fs.readFileSync(path.join(study.dir, 'run-authorization.json'), 'utf8'));
      expect(
        Date.now(),
        `${study.studyId} archive merge gate: the historical authorization is still clock-valid until ${study.pinnedValidUntil} (revoked=false, halted=false). Per the Owner P1-1 finding, this archive must NOT merge before natural expiry — do not bypass or delete this test.`,
      ).toBeGreaterThan(Date.parse(auth.validUntil));
    });

    it(`${study.studyId}: fresh-ledger copy (review attack path) is REFUSED by the gate once expired — budget exhaustion was never the protector, the clock is`, () => {
      const auth = JSON.parse(fs.readFileSync(path.join(study.dir, 'run-authorization.json'), 'utf8'));
      expect(Date.now(), 'precondition: window must already be closed for this assertion to be meaningful').toBeGreaterThan(Date.parse(auth.validUntil));
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-auth-gate-'));
      try {
        fs.cpSync(study.dir, tmp, { recursive: true });
        // simulate a FRESH budget ledger: the gate and the ledger are different
        // checks — a still-valid authorization passes the gate here regardless
        // of the original study's 96/96 exhaustion
        for (const ledger of ['budget-ledger.jsonl', 'events.jsonl', 'adjudications.jsonl']) {
          fs.writeFileSync(path.join(tmp, ledger), '', 'utf8');
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'suite-manifest.json'), 'utf8'));
        const args = [
          '--execution-mode', 'F1-direct-model',
          '--arms', 'A,B,C',
          '--cases', manifest.cases.map((c: any) => c.caseId).join(','),
          '--repetitions', '1,2',
          '--max-attempts', '96',
          '--request-timeout-ms', '480000',
          ...study.extraArgs,
          '--dry-run', '--now', new Date().toISOString(),
        ];
        const r = runCli(args, tmp);
        expect(r.status).toBe(1);
        expect(r.out).toContain('authorization expired');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
