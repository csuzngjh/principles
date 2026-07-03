/**
 * PRI-503 regression: admission gate must be checked before intakeService.intake()
 * in every CLI command that calls it. This static source-text scan prevents future
 * commands (or refactors) from re-introducing the bypass that PR #1134 missed in
 * pain-retry.ts and diagnose.ts (ERR-089 sibling-branch defect).
 *
 * Why static scan: runtime mocking of the full CLI command path is heavy and
 * brittle. A source-text check is deterministic, fast, and directly asserts the
 * invariant ("gate call appears before intake call in the same file").
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PD_CLI_COMMANDS_DIR = path.resolve(__dirname, '..', '..', 'src', 'commands');

function readSource(fileName: string): string {
  return fs.readFileSync(path.join(PD_CLI_COMMANDS_DIR, fileName), 'utf-8');
}

describe('PRI-503: admission gate coverage (static source scan)', () => {
  describe('shared helper exists', () => {
    it('admission-gate.ts exists and exports checkAdmissionGate', () => {
      const content = readSource('admission-gate.ts');
      expect(content).toContain('export function checkAdmissionGate');
      expect(content).toContain('evaluateCandidateAdmissionFromRecord');
    });
  });

  describe('candidate.ts uses shared helper (no local definition)', () => {
    it('candidate.ts imports checkAdmissionGate from ./admission-gate.js', () => {
      const content = readSource('candidate.ts');
      expect(content).toContain("from './admission-gate.js'");
      expect(content).toContain('checkAdmissionGate');
    });

    it('candidate.ts no longer defines a local function checkAdmissionGate', () => {
      const content = readSource('candidate.ts');
      // Local definition would be `function checkAdmissionGate(` at top level
      expect(content).not.toMatch(/function\s+checkAdmissionGate\s*\(/);
    });
  });

  describe('pain-retry.ts checks admission gate before intake', () => {
    it('pain-retry.ts imports checkAdmissionGate from ./admission-gate.js', () => {
      const content = readSource('pain-retry.ts');
      expect(content).toContain("from './admission-gate.js'");
      expect(content).toContain('checkAdmissionGate');
    });

    it('pain-retry.ts calls checkAdmissionGate before intakeService.intake', () => {
      const content = readSource('pain-retry.ts');
      const gateIdx = content.indexOf('checkAdmissionGate(');
      const intakeIdx = content.indexOf('intakeService.intake(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(intakeIdx).toBeGreaterThan(-1);
      // Gate MUST appear before intake in source order
      expect(gateIdx).toBeLessThan(intakeIdx);
    });
  });

  describe('diagnose.ts checks admission gate before intake', () => {
    it('diagnose.ts imports checkAdmissionGate from ./admission-gate.js', () => {
      const content = readSource('diagnose.ts');
      expect(content).toContain("from './admission-gate.js'");
      expect(content).toContain('checkAdmissionGate');
    });

    it('diagnose.ts calls checkAdmissionGate before intakeService.intake', () => {
      const content = readSource('diagnose.ts');
      const gateIdx = content.indexOf('checkAdmissionGate(');
      const intakeIdx = content.indexOf('intakeService.intake(');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(intakeIdx).toBeGreaterThan(-1);
      // Gate MUST appear before intake in source order
      expect(gateIdx).toBeLessThan(intakeIdx);
    });
  });
});
