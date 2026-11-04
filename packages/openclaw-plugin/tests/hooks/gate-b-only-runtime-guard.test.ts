/**
 * PRI-651-B1 / Phase A — runtime admission guard.
 *
 * No runtime hook may enter Gate A (evaluatePainDiagnosticGate). Gate B
 * (TriggerController) is the only admission authority, and in Phase A it is
 * reached ONLY by Owner-driven paths:
 *  - pain.ts manual `/pd-pain` / explicit Pain Tool (`handleManualPain`),
 *  - llm.ts GFI health path (frozen until Phase C).
 *
 * Technical failures (after-tool-call-helpers) and RuleHost blocks
 * (gate-block-helper) MUST NOT consult admission at all.
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

      it('never invokes admission from the retired automatic paths', () => {
        if (file === 'gate-block-helper.ts') {
          expect(source).not.toMatch(/evaluateTriggerController/);
          expect(source).not.toMatch(/evaluateEvidenceTriage/);
        }
      });
    });
  }

  it('Owner-driven paths still reach the TriggerController', () => {
    expect(hookSource('pain.ts')).toMatch(/evaluateTriggerController/);
    expect(hookSource('llm.ts')).toMatch(/evaluateTriggerController/);
  });

  it('after-tool-call collection never consults admission (Phase A)', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts'), 'utf8');
    expect(source).not.toMatch(/evaluateTriggerController/);
    expect(source).not.toMatch(/evaluatePainAdmissionForToolCall/);
    expect(source).not.toMatch(/emitPainDetectedEvent/);
  });
});
