/**
 * PRI-44: Pure PrincipleCompiler core contracts
 *
 * Tests for template generation, forbidden pattern detection, and type exports
 * migrated from openclaw-plugin to @principles/core.
 */
import { describe, it, expect } from 'vitest';

// ── Template generation ──────────────────────────────────────────────────────

describe('generateFromTemplate', () => {
  // Dynamic import to allow TDD red-green cycle
  async function getModule() {
    return import('../internalization/template-generator.js');
  }

  it('generates code for single tool with path pattern', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_066', 'Writing to secrets directory', [
      { toolName: 'write', pathRegex: 'secrets/.*\\.env' },
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain('export const meta');
    expect(result).toContain('export function evaluate(input)');
    expect(result).toContain('name: "Auto_P_066"');
    expect(result).toContain('ruleId: "R_P_066_auto"');
    expect(result).toContain('sourcePrincipleId: "P_066"');
    expect(result).toContain('coversCondition: "Writing to secrets directory"');
    expect(result).toContain('input.action.toolName === "write"');
    expect(result).toContain('input.action.normalizedPath');
    expect(result).toContain("decision: 'block'");
  });

  it('generates code for write tool with content pattern', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_007', 'Writing private keys', [
      { toolName: 'write', contentRegex: 'BEGIN RSA PRIVATE KEY' },
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain('paramsSummary.content');
  });

  it('generates code for multiple tool patterns', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_010', 'Destructive operations', [
      { toolName: 'bash', commandRegex: 'rm\\s+-rf\\s+/' },
      { toolName: 'write', pathRegex: 'secrets/' },
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain('input.action.toolName === "bash"');
    expect(result).toContain('input.action.toolName === "write"');
  });

  it('returns null when patterns array is empty', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_066', 'some condition', []);
    expect(result).toBeNull();
  });

  it('does not contain forbidden patterns in generated code', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_099', 'Dangerous commands', [
      { toolName: 'bash', commandRegex: 'dangerous' },
    ]);

    expect(result).not.toBeNull();
    expect(result).not.toContain('require(');
    expect(result).not.toContain('import ');
    expect(result).not.toContain('fetch(');
  });

  it('has proper meta structure with compiledAt timestamp', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_050', 'Modifying admin config', [
      { toolName: 'edit', pathRegex: '\\.json$' },
    ]);

    expect(result).not.toBeNull();
    expect(result).toMatch(/export const meta = \{/);
    expect(result).toMatch(/name: "Auto_P_050"/);
    expect(result).toMatch(/version: '1\.0\.0'/);
    expect(result).toMatch(/ruleId: "R_P_050_auto"/);
    expect(result).toMatch(/sourcePrincipleId: "P_050"/);
    expect(result).toMatch(/compiledAt: "\d{4}-\d{2}-\d{2}T/);
    expect(result).toMatch(/export function evaluate\(input\)/);
    expect(result).toMatch(/return \{ matched: false \}/);
  });

  it('edit tool uses new_string fallback in content check', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_050', 'test', [
      { toolName: 'edit', contentRegex: 'admin.*true' },
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain('input.action.paramsSummary.content || input.action.paramsSummary.new_string');
  });
});

// ── Forbidden pattern detection ──────────────────────────────────────────────

describe('checkForbiddenPatterns', () => {
  async function getModule() {
    return import('../internalization/rule-code-validator.js');
  }

  it('returns empty array for clean code', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const code = `
export const meta = { name: 'x', version: '1', ruleId: 'R', coversCondition: 'c' };
export function evaluate() { return { matched: false, reason: 'ok' }; }
`;
    expect(checkForbiddenPatterns(code)).toEqual([]);
  });

  it('detects require', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns("const fs = require('fs');");
    expect(labels).toContain('require');
  });

  it('detects import, fetch, eval, Function, process, globalThis', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const code = `import { x } from 'y'; fetch('/url'); eval('1'); new Function('x'); process.env; globalThis.z;`;
    const labels = checkForbiddenPatterns(code);
    expect(labels).toContain('import');
    expect(labels).toContain('fetch');
    expect(labels).toContain('eval');
    expect(labels).toContain('Function');
    expect(labels).toContain('process');
    expect(labels).toContain('globalThis');
  });

  it('detects bracket notation access to forbidden globals', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns("const r = window['require'];");
    expect(labels).toContain('bracket access to forbidden global');
  });

  it('returns all labels for multi-violation code', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const code = `require('fs'); fetch('/x'); eval('1'); process.env;`;
    const labels = checkForbiddenPatterns(code);
    expect(labels.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Return statement field check ─────────────────────────────────────────────

describe('checkReturnStatementsMissingFields', () => {
  async function getModule() {
    return import('../internalization/rule-code-validator.js');
  }

  it('returns empty array for code with all three fields in every return', async () => {
    const { checkReturnStatementsMissingFields } = await getModule();
    const code = `
function evaluate(input, helpers) {
  if (input.action.toolName === 'write') {
    return { decision: 'block', matched: true, reason: 'blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'safe' };
}
`;
    expect(checkReturnStatementsMissingFields(code)).toEqual([]);
  });

  it('detects return missing decision and reason', async () => {
    const { checkReturnStatementsMissingFields } = await getModule();
    const code = `
function evaluate(input, helpers) {
  return { matched: false };
}
`;
    const violations = checkReturnStatementsMissingFields(code);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('decision');
    expect(violations[0]).toContain('reason');
  });

  it('detects return missing only reason', async () => {
    const { checkReturnStatementsMissingFields } = await getModule();
    const code = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: true };
}
`;
    const violations = checkReturnStatementsMissingFields(code);
    expect(violations).toHaveLength(1);
    // The "missing required field(s): reason" part should only list 'reason'
    const [missingPart] = violations[0].split('—');
    expect(missingPart).toContain('reason');
    expect(missingPart).not.toContain('decision');
  });

  it('detects multiple violations across multiple returns', async () => {
    const { checkReturnStatementsMissingFields } = await getModule();
    const code = `
function evaluate(input, helpers) {
  if (input.x) {
    return { matched: true };
  }
  if (input.y) {
    return { decision: 'block', matched: true };
  }
  return { decision: 'allow', matched: false, reason: 'ok' };
}
`;
    const violations = checkReturnStatementsMissingFields(code);
    expect(violations).toHaveLength(2);
  });

  it('skips complex returns with nested braces (no false positives)', async () => {
    const { checkReturnStatementsMissingFields } = await getModule();
    const code = `
function evaluate(input, helpers) {
  return { decision: 'propose_correction', matched: true, reason: 'fix', correctionProposal: { params: { a: 1 } } };
}
`;
    expect(checkReturnStatementsMissingFields(code)).toEqual([]);
  });

  it('returns empty for code with no return statements', async () => {
    const { checkReturnStatementsMissingFields } = await getModule();
    const code = `const x = 1;`;
    expect(checkReturnStatementsMissingFields(code)).toEqual([]);
  });
});

// ── Type exports via barrel ──────────────────────────────────────────────────

describe('PRI-44 barrel exports', () => {
  it('exports generateFromTemplate and checkForbiddenPatterns', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.generateFromTemplate).toBe('function');
    expect(typeof mod.checkForbiddenPatterns).toBe('function');
  }, 10000);

  it('exports PainPattern type usable with generateFromTemplate', async () => {
    const { generateFromTemplate } = await import('../internalization/template-generator.js');
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash' }]);
    expect(result).not.toBeNull();
  });
});
