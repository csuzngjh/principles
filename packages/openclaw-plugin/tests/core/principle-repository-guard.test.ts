/**
 * Principle-repository guard (Round 3 follow-up, PRI-547).
 *
 * Distinguishes the three PRINCIPLES surfaces and locks each one down:
 *
 *   A. T-01..T-10 built-in core axioms  -> @principles/core runtime registry
 *   B. root core template PRINCIPLES.md -> neutral workspace template
 *   C. templates/workspace/.principles/PRINCIPLES.md -> principle repo scaffold
 *
 * This test prevents the author's historical P-10 from being shipped to new
 * users AND prevents "template cleanup" from breaking the runtime principle
 * system (registry, init chain, persistence, prompt injection source).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { CORE_PRINCIPLE_IDS, getActiveCorePrinciples } from '@principles/core/runtime-v2';
import { ensureCorePrinciples } from '../../src/core/init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

describe('AC-01/02: registry core axioms stay canonical (A)', () => {
  it('registry has 11 entries: 10 active + deprecated T-07', () => {
    expect(CORE_PRINCIPLE_IDS).toHaveLength(11);
    expect(getActiveCorePrinciples()).toHaveLength(10);
  });

  it('ids are exactly T-01 through T-11 (T-07 deprecated, kept resolvable)', () => {
    expect(CORE_PRINCIPLE_IDS.slice().sort()).toEqual([
      'T-01', 'T-02', 'T-03', 'T-04', 'T-05',
      'T-06', 'T-07', 'T-08', 'T-09', 'T-10', 'T-11',
    ]);
  });

  it('canonical source stays in runtime registry, not markdown', () => {
    const registryFile = path.join(
      PACKAGE_ROOT, '..', 'principles-core', 'src', 'runtime-v2',
      'core-principles', 'core-principle-registry.ts',
    );
    expect(fs.existsSync(registryFile)).toBe(true);
  });
});

describe('AC-03: ensureCorePrinciples initializes the active set from empty state', () => {
  it('bootstraps the full ACTIVE set into a fresh state dir (deprecated T-07 excluded)', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ac03-'));
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
    const initialized = ensureCorePrinciples(stateDir, logger);
    expect(initialized).toBe(true);

    // Training store contains exactly the 10 ACTIVE ids.
    const storePath = path.join(stateDir, 'principle_training_state.json');
    expect(fs.existsSync(storePath)).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const storedIds = Object.keys(store).filter((k) => k !== '_tree');
    expect(storedIds.sort()).toEqual(getActiveCorePrinciples().map(p => p.id).sort());
    expect(storedIds).toHaveLength(10);
    expect(storedIds).not.toContain('T-07');
  });
});

describe('AC-04/05: principle templates (B/C)', () => {
  it('C: .principles/PRINCIPLES.md workspace scaffold ships', () => {
    const scaffold = path.join(
      PACKAGE_ROOT, 'templates', 'workspace', '.principles', 'PRINCIPLES.md',
    );
    expect(fs.existsSync(scaffold)).toBe(true);
  });

  it('B: root core PRINCIPLES.md is neutral, no author P-10, no T-list reprint', () => {
    for (const lang of ['en', 'zh']) {
      const f = path.join(PACKAGE_ROOT, 'templates', 'langs', lang, 'core', 'PRINCIPLES.md');
      const content = fs.readFileSync(f, 'utf8');
      expect(content.toLowerCase()).not.toContain('流程即权限');
      expect(content.toLowerCase()).not.toContain('process as authority');
      expect(content).not.toContain('2026-03-13');
      // T-list reprint would create a second source of truth; bare mention ok.
      const tNames = [
        'survey before acting',
        'intent & constraints first',
        'evidence over assumption',
        'reversible & safe by default',
        'safety rails',
        'minimal sufficient change',
        'minimal change',
        'pain as signal',
        'divide and conquer',
        'memory externalization',
        'close the loop',
      ];
      for (const name of tNames) {
        expect(content.toLowerCase()).not.toContain(name);
      }
    }
  });
});

describe('AC-06: runtime prompt injection does not depend on core PRINCIPLES.md', () => {
  it('prompt.ts injects from the structured reducer, not the markdown template', () => {
    const promptSrc = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'hooks', 'prompt.ts'), 'utf8');
    // Must source active principles from the structured store.
    expect(promptSrc).toContain('getActivePrinciples');
    // Must not read the shipped core template as runtime source of truth.
    expect(promptSrc).not.toContain("'PRINCIPLES.md'");
    expect(promptSrc).not.toContain('"PRINCIPLES.md"');
    expect(promptSrc).not.toContain('templates/langs');
  });
});
