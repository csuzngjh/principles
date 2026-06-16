/**
 * Tests for core-axiom-block.ts — shared CORE_PRINCIPLES injection utility.
 */

import { describe, it, expect } from 'vitest';
import {
  formatCorePrinciplesList,
  buildCoreAxiomBlock,
} from '../core-axiom-block.js';
import { CORE_PRINCIPLES } from '../core-principle-registry.js';

describe('formatCorePrinciplesList', () => {
  it('formats all 10 principles as "T-XX: statement" lines', () => {
    const result = formatCorePrinciplesList();
    const lines = result.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^T-01: /);
    expect(lines[9]).toMatch(/^T-10: /);
  });

  it('uses English statements by default', () => {
    const result = formatCorePrinciplesList();
    expect(result).toContain('Understand the structure first');
  });

  it('uses Chinese statements when outputLanguage is zh-CN', () => {
    const result = formatCorePrinciplesList('zh-CN');
    expect(result).toContain('在做出变更前，先理解其结构');
  });

  it('uses English statements when outputLanguage is en', () => {
    const result = formatCorePrinciplesList('en');
    expect(result).toContain('Understand the structure first');
    expect(result).not.toContain('在做出变更前');
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

  it('includes all 10 core principles', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true });
    for (const p of CORE_PRINCIPLES) {
      expect(result).toContain(p.id + ':');
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
    expect(result).toContain('在做出变更前，先理解其结构');
  });

  it('block starts with newline for easy insertion into prompts', () => {
    const result = buildCoreAxiomBlock({ coreGrounding: true });
    expect(result.startsWith('\n')).toBe(true);
  });
});
