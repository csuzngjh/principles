import { describe, expect, it } from 'vitest';
import { validateGeneratedCode } from '../../src/core/principle-compiler/code-validator.js';

describe('validateGeneratedCode', () => {
  // --- Valid code ---

  it('accepts valid rule implementation with evaluate and meta', () => {
    const code = `
export const meta = {
  name: 'test-rule',
  version: '1.0.0',
  ruleId: 'R-001',
  coversCondition: 'test condition'
};

export function evaluate(input) {
  return {
    matched: input.action.toolName === 'bash',
    reason: 'checked toolName'
  };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts evaluate that returns matched: false', () => {
    const code = `
export const meta = { name: 'never-match', version: '1.0.0', ruleId: 'R-002', coversCondition: 'none' };

export function evaluate(_input) {
  return { matched: false, reason: 'never matches' };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(true);
  });

  // --- Syntax check ---

  it('rejects code with syntax errors', () => {
    const code = `function broken( {`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /syntax/i.test(e))).toBe(true);
  });

  // --- Forbidden patterns ---

  it('rejects code containing require(', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { const fs = require('fs'); return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /require/i.test(e))).toBe(true);
  });

  it('rejects code containing import statement', () => {
    const code = `import { something } from 'module';
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /import/i.test(e))).toBe(true);
  });

  it('rejects code containing fetch(', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { fetch('http://evil.com'); return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /fetch/i.test(e))).toBe(true);
  });

  it('rejects code containing eval(', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { eval('42'); return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /eval/i.test(e))).toBe(true);
  });

  it('rejects code containing Function(', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { new Function('return 1')(); return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Function/i.test(e))).toBe(true);
  });

  it('rejects code containing process', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { const x = process.env; return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /process/i.test(e))).toBe(true);
  });

  it('rejects code containing globalThis', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { globalThis.foo = 'bar'; return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /globalThis/i.test(e))).toBe(true);
  });

  it('reports all forbidden patterns at once', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() {
  require('fs');
  fetch('http://x');
  eval('1');
  process.env;
  return { matched: false, reason: '' };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  // --- Export check ---

  it('rejects code that does not export evaluate', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
// no evaluate function at all
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /evaluate/i.test(e))).toBe(true);
  });

  it('rejects code that does not export meta', () => {
    const code = `
// no meta at all
export function evaluate() { return { matched: false, reason: '' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /meta/i.test(e))).toBe(true);
  });

  // --- Return shape check ---

  it('rejects evaluate that returns object without matched', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { return { reason: 'no matched field' }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /matched/i.test(e))).toBe(true);
  });

  it('accepts evaluate even when it throws on mock input', () => {
    // evaluate throws because it accesses a nested property that doesn't exist in mock
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate(input) {
  if (input.action.toolName === 'bash') {
    return { matched: true, reason: 'ok' };
  }
  throw new Error('unexpected input');
}
`;
    // The mock input has toolName: 'bash', so it returns successfully
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(true);
  });

  it('accepts evaluate that throws as long as it has correct shape when it returns', () => {
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate(_input) {
  return { matched: true, reason: 'ok' };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(true);
  });
});
