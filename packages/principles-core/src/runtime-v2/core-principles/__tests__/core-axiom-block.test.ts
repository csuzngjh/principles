/**
 * Tests for core-axiom-block.ts — shared CORE_PRINCIPLES injection utility.
 */

import { describe, it, expect } from 'vitest';
import {
  formatCorePrinciplesList,
  buildCoreAxiomBlock,
} from '../core-axiom-block.js';
import {
  CORE_PRINCIPLES,
  getFoundationalPrinciples,
  getOperatingPrinciples,
} from '../core-principle-registry.js';

describe('formatCorePrinciplesList', () => {
  it('formats all 10 principles as "T-XX: statement" lines by default', () => {
    const result = formatCorePrinciplesList();
    const lines = result.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^T-01: /);
    expect(lines[9]).toMatch(/^T-10: /);
    expect(result).toContain('T-07:');
  });

  it('uses English statements by default', () => {
    const result = formatCorePrinciplesList();
    expect(result).toContain('Build a sufficient model of the relevant system');
  });

  it('uses Chinese statements when outputLanguage is zh-CN', () => {
    const result = formatCorePrinciplesList('zh-CN');
    expect(result).toContain('在进行有后果的变更前，先建立对相关系统足够准确的理解');
  });

  it('uses English statements when outputLanguage is en', () => {
    const result = formatCorePrinciplesList('en');
    expect(result).toContain('Build a sufficient model of the relevant system');
    expect(result).not.toContain('在进行有后果的变更前');
  });

  it("scope 'foundational' lists exactly the foundational axioms", () => {
    const result = formatCorePrinciplesList('en', 'foundational');
    expect(result.split('\n')).toHaveLength(getFoundationalPrinciples().length);
    for (const p of getFoundationalPrinciples()) {
      expect(result).toContain(`${p.id}:`);
    }
    // Operating principles must never land in the foundational slice.
    for (const p of getOperatingPrinciples()) {
      expect(result).not.toContain(`${p.id}:`);
    }
  });

  it("scope 'operating' lists exactly the operating principles", () => {
    const result = formatCorePrinciplesList('en', 'operating');
    expect(result.split('\n')).toHaveLength(getOperatingPrinciples().length);
    expect(result).toContain('T-05:');
    expect(result).toContain('T-07:');
    expect(result).not.toContain('T-01:');
  });
});

describe('buildCoreAxiomBlock', () => {
  it('returns empty string when coreGrounding is false', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: false });
    expect(result).toBe('');
  });

  it('returns empty string when coreGrounding is undefined', () => {
    const result = buildCoreAxiomBlock({});
    expect(result).toBe('');
  });

  it('returns fallback when coreGrounding is false and fallback is provided', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: false, fallback: '\n' });
    expect(result).toBe('\n');
  });

  it('returns block with default title when coreGrounding is true', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true });
    expect(result).toContain('CORE AXIOMS:');
  });

  it('includes default instruction about fabricated IDs', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true });
    expect(result).toContain('Fabricating IDs not in this');
    expect(result).toContain('validation failure');
  });

  it('includes all 10 core principles under the default scope', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true });
    for (const p of CORE_PRINCIPLES) {
      expect(result).toContain(p.id + ':');
    }
  });

  it('honors scope override (foundational only)', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true, scope: 'foundational' });
    expect(result).toContain('T-01:');
    // The list section must be exactly the foundational slice.
    expect(result).toContain(formatCorePrinciplesList(undefined, 'foundational'));
    for (const p of getOperatingPrinciples()) {
      expect(result).not.toContain(`${p.id}:`);
    }
  });

  it('uses custom section title', () => {
    const result = buildCoreAxiomBlock({
      coreGrounding: true,
      sectionTitle: 'PHASE 3.5 — Core Axiom Grounding:',
    });
    expect(result).toContain('PHASE 3.5 — Core Axiom Grounding:');
    expect(result).not.toContain('CORE AXIOMS:');
  });

  it('uses custom instruction', () => {
    const result = buildCoreAxiomBlock({
      coreGrounding: true,
      instruction: 'Custom instruction text here.',
    });
    expect(result).toContain('Custom instruction text here.');
    expect(result).not.toContain('Fabricating IDs');
  });

  it('omits instruction when set to empty string', () => {
    const result = buildCoreAxiomBlock({
      coreGrounding: true,
      instruction: '',
    });
    expect(result).not.toContain('Fabricating IDs');
    // Should still have the principles list
    expect(result).toContain('T-01:');
  });

  it('uses Chinese statements when outputLanguage is zh-CN', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true, outputLanguage: 'zh-CN' });
    expect(result).toContain('在进行有后果的变更前，先建立对相关系统足够准确的理解');
  });

  it('block starts with newline for easy insertion into prompts', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true });
    expect(result.startsWith('\n')).toBe(true);
  });
});
