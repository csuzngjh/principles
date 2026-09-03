/**
 * PRI-651-B1 — Runtime Gate A fallback removal guard.
 *
 * Regression guard per the PRI-651-A design (docs/audit/pd-gate-a-retirement-design-2026-09.md §R1):
 * no runtime hook may enter Gate A (evaluatePainDiagnosticGate) via the retired
 * feature flags. If Gate A routing is ever resurrected on a hook path, this test
 * fails, preventing silent behavior divergence while Gate A modules are still
 * archived (their deletion is PRI-651-B2, flag retirement PRI-651-B3).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** The three dual-gate hook files converged to unconditional Gate B in PRI-651-B1. */
const DUAL_GATE_HOOKS = ['pain.ts', 'llm.ts', 'gate-block-helper.ts'] as const;

function findRepoRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not find repo root');
}

const repoRoot = findRepoRoot(process.cwd());

function hookSource(file: string): string {
  return fs.readFileSync(path.join(repoRoot, 'packages/openclaw-plugin/src/hooks', file), 'utf8');
}

describe('PRI-651-B1: runtime hooks are Gate B only (no Gate A fallback selection)', () => {
  for (const file of DUAL_GATE_HOOKS) {
    describe(file, () => {
      const source = hookSource(file);

      it('does not invoke evaluatePainDiagnosticGate (Gate A)', () => {
        expect(source).not.toMatch(/evaluatePainDiagnosticGate/);
      });

      it('does not load painEvidenceAdmission / painEvidenceAdmissionDefault flags', () => {
        expect(source).not.toMatch(/painEvidenceAdmission/);
        expect(source).not.toMatch(/painEvidenceAdmissionDefault/);
        expect(source).not.toMatch(/pain_evidence_admission/);
      });

      it('relies on the Gate B TriggerController for admission', () => {
        expect(source).toMatch(/evaluateTriggerController/);
      });
    });
  }
});
