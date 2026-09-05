/**
 * PRI-439 Phase 2: RuleCode dialect contract — TDD tests
 *
 * Canonical dialect: synchronous bare `function evaluate(input, helpers)`.
 * Strict forbidden patterns: export, import, async, eval, Function, I/O,
 * network, timers, random.
 * Decision: exactly 4 values (allow | block | requireApproval | auto_correct).
 * matched=false → decision must be 'allow'.
 * auto_correct → correctionProposal required (already enforced, smoke-tested here).
 */
import { describe, it, expect } from 'vitest';

// ── New forbidden patterns (PRI-439 Phase 2) ────────────────────────────────

describe('PRI-439 Phase 2: new forbidden patterns', () => {
  async function getModule() {
    return import('../rule-code-validator.js');
  }

  // ── export (canonical is bare function, no ESM export) ──────────────────

  it('rejects `export function evaluate`', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `export function evaluate(input, helpers) {\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('export');
  });

  it('rejects `export const meta`', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `export const meta = { name: 'x' };\nfunction evaluate(input, helpers) { return { decision: 'allow', matched: false, reason: 'x' }; }`,
    );
    expect(labels).toContain('export');
  });

  it('accepts bare `function evaluate(input, helpers)` (canonical form)', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `const meta = { name: 'x' };\nfunction evaluate(input, helpers) {\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).not.toContain('export');
  });

  // ── async / await (canonical is synchronous) ────────────────────────────

  it('rejects `async function evaluate`', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `async function evaluate(input, helpers) {\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('async');
  });

  it('rejects `await` inside evaluate', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  const x = await fetch('/x');\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('await');
  });

  it('does not false-positive on `async` in a string literal', async () => {
    const { checkForbiddenPatterns } = await getModule();
    // `async` inside a string should not be flagged by the word-boundary regex.
    // NOTE: This is a best-effort static check. If the regex is too broad it
    // will false-positive on legitimate reason strings mentioning "async".
    // We assert the canonical clean code passes.
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  return { decision: 'allow', matched: false, reason: 'synchronous not async' };\n}`,
    );
    // PRI-668: string-literal contents are masked before scanning, so a
    // mention inside a literal is never a pattern hit — the former "known
    // limitation" branch (labels.includes('async') → return) is now dead.
    expect(labels).not.toContain('async');
  });

  // ── PRI-668: string literals / comments are DATA, never an access ───────

  it('PRI-668: does not flag "global" compared as string data (scope === \'global\')', async () => {
    const { checkForbiddenPatterns } = await getModule();
    // Exact production shape from lab chain 38a29eb5 repair round: the rule
    // compares a config value against the literal 'global' — data, not access.
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  var p = input.action.paramsSummary || {};\n  if (p.scope === 'global') { return { decision: 'block', matched: true, reason: 'system scope' }; }\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).not.toContain('global');
    expect(labels).not.toContain('process');
  });

  it('PRI-668: does not flag "global_apply" denylist literal or comments mentioning global', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `// global rule — this comment mentions global and process\n` +
      `function evaluate(input, helpers) {\n  var blanketKeys = ['all', 'recursive_all', 'bulk_apply', 'global_apply', 'wipe'];\n  return { decision: 'allow', matched: false, reason: 'checked ' + blanketKeys.length };\n}`,
    );
    expect(labels).not.toContain('global');
    expect(labels).not.toContain('process');
  });

  it('PRI-668: still flags bare `global` as identifier and template interpolation', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const bare = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  var x = global.foo;\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(bare).toContain('global');
    // Template interpolation is executable code — masking must NOT protect it.
    const interp = checkForbiddenPatterns(
      'function evaluate(input, helpers) {\n  var r = `${global}`;\n  return { decision: \'allow\', matched: false, reason: r };\n}',
    );
    expect(interp).toContain('global');
    // The escape hatches stay forbidden even when reached via a string-typed value.
    const viaEval = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  var s = 'ev' + 'il';\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(viaEval).toEqual([]);
  });

  // ── Math.random (non-deterministic randomness) ──────────────────────────

  it('rejects Math.random()', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  if (Math.random() > 0.5) { return { decision: 'block', matched: true, reason: 'x' }; }\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('Math.random');
  });

  // ── Timers: setImmediate, queueMicrotask (extends setTimeout/setInterval) ─

  it('rejects setImmediate', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  setImmediate(() => {});\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('setImmediate');
  });

  it('rejects queueMicrotask', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  queueMicrotask(() => {});\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('queueMicrotask');
  });

  // ── Network: XMLHttpRequest ──────────────────────────────────────────────

  it('rejects XMLHttpRequest', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  const xhr = new XMLHttpRequest();\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('XMLHttpRequest');
  });

  // ── crypto (non-deterministic / side-channel) ────────────────────────────

  it('rejects crypto.randomBytes', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  const x = crypto.randomBytes(4);\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    expect(labels).toContain('crypto');
  });

  // ── Bracket access to new forbidden globals ──────────────────────────────

  it('rejects bracket access to setImmediate', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const labels = checkForbiddenPatterns(
      `function evaluate(input, helpers) {\n  const fn = globalThis['setImmediate'];\n  return { decision: 'allow', matched: false, reason: 'x' };\n}`,
    );
    // globalThis is already forbidden, but bracket-access to setImmediate
    // should also be caught.
    expect(labels).toContain('bracket access to forbidden global');
  });

  // ── Canonical clean code passes ──────────────────────────────────────────

  it('canonical bare function evaluate(input, helpers) passes with zero violations', async () => {
    const { checkForbiddenPatterns } = await getModule();
    const code = [
      `const meta = { name: 'R1', version: '1.0.0', ruleId: 'R1', coversCondition: 'test' };`,
      `function evaluate(input, helpers) {`,
      `  if (input.action.toolName === 'write' && helpers.isRiskPath()) {`,
      `    return { decision: 'block', matched: true, reason: 'risk path' };`,
      `  }`,
      `  return { decision: 'allow', matched: false, reason: 'safe' };`,
      `}`,
    ].join('\n');
    expect(checkForbiddenPatterns(code)).toEqual([]);
  });
});

// ── matched=false → decision must be 'allow' (PRI-439 Phase 2) ──────────────

describe('PRI-439 Phase 2: matched=false decision constraint', () => {
  async function getValidator() {
    return import('../rule-host-validator.js');
  }

  async function getCodeValidator() {
    return import('../rule-code-validator.js');
  }

  // ── Runtime validation (validateRuleHostResult) ──────────────────────────

  it('runtime: matched=false with decision=allow is valid', async () => {
    const { validateRuleHostResult } = await getValidator();
    const result = validateRuleHostResult({
      decision: 'allow',
      matched: false,
      reason: 'rule not applicable',
    });
    expect(result.valid).toBe(true);
  });

  it('runtime: matched=false with decision=block is INVALID', async () => {
    const { validateRuleHostResult } = await getValidator();
    const result = validateRuleHostResult({
      decision: 'block',
      matched: false,
      reason: 'contradictory',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/matched.*false.*allow|allow.*matched.*false/i);
  });

  it('runtime: matched=false with decision=requireApproval is INVALID', async () => {
    const { validateRuleHostResult } = await getValidator();
    const result = validateRuleHostResult({
      decision: 'requireApproval',
      matched: false,
      reason: 'contradictory',
    });
    expect(result.valid).toBe(false);
  });

  it('runtime: matched=false with decision=auto_correct is INVALID', async () => {
    const { validateRuleHostResult } = await getValidator();
    const result = validateRuleHostResult({
      decision: 'auto_correct',
      matched: false,
      reason: 'contradictory',
      correctionProposal: {
        ruleId: 'R1',
        correctedFields: { command: 'safe' },
        proposedParams: { command: 'safe' },
        applicationMode: 'replace_params',
        confidence: 0.9,
        notifyAgent: true,
      },
    });
    expect(result.valid).toBe(false);
  });

  it('runtime: matched=true with decision=block is valid (no constraint)', async () => {
    const { validateRuleHostResult } = await getValidator();
    const result = validateRuleHostResult({
      decision: 'block',
      matched: true,
      reason: 'blocked',
    });
    expect(result.valid).toBe(true);
  });

  // ── Static check (checkMatchedFalseDecisions) ────────────────────────────

  it('static: flags return { matched: false, decision: "block" }', async () => {
    const { checkMatchedFalseDecisions } = await getCodeValidator();
    const code = `function evaluate(input, helpers) {
  return { decision: 'block', matched: false, reason: 'x' };
}`;
    const violations = checkMatchedFalseDecisions(code);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]).toMatch(/matched.*false.*allow/i);
  });

  it('static: does NOT flag return { matched: false, decision: "allow" }', async () => {
    const { checkMatchedFalseDecisions } = await getCodeValidator();
    const code = `function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'safe' };
}`;
    const violations = checkMatchedFalseDecisions(code);
    expect(violations).toEqual([]);
  });

  it('static: does NOT flag return { matched: true, decision: "block" }', async () => {
    const { checkMatchedFalseDecisions } = await getCodeValidator();
    const code = `function evaluate(input, helpers) {
  return { decision: 'block', matched: true, reason: 'blocked' };
}`;
    const violations = checkMatchedFalseDecisions(code);
    expect(violations).toEqual([]);
  });

  it('static: does NOT flag complex returns with nested braces', async () => {
    const { checkMatchedFalseDecisions } = await getCodeValidator();
    const code = `function evaluate(input, helpers) {
  return { decision: 'auto_correct', matched: true, reason: 'fix', correctionProposal: { params: { a: 1 } } };
}`;
    const violations = checkMatchedFalseDecisions(code);
    expect(violations).toEqual([]);
  });
});

// ── Template generator emits canonical bare form (PRI-439 Phase 2) ──────────

describe('PRI-439 Phase 2: template generator canonical form', () => {
  async function getModule() {
    return import('../template-generator.js');
  }

  it('emits bare `function evaluate(input, helpers)` (no export keyword)', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash' }]);
    expect(result).not.toBeNull();
    expect(result).toContain('function evaluate(input, helpers)');
    expect(result).not.toContain('export function evaluate');
  });

  it('emits bare `const meta` (no export keyword)', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash' }]);
    expect(result).not.toBeNull();
    expect(result).toContain('const meta =');
    expect(result).not.toContain('export const meta');
  });

  it('default return includes decision: "allow" and reason', async () => {
    const { generateFromTemplate } = await getModule();
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash' }]);
    expect(result).not.toBeNull();
    expect(result).toMatch(/return\s*\{\s*decision:\s*['"]allow['"]/);
    expect(result).toMatch(/matched:\s*false/);
    expect(result).toMatch(/reason:\s*'/);
  });

  it('generated code passes checkForbiddenPatterns', async () => {
    const { generateFromTemplate } = await getModule();
    const { checkForbiddenPatterns } = await import('../rule-code-validator.js');
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash', commandRegex: 'rm' }]);
    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected non-null result');
    const labels = checkForbiddenPatterns(result);
    expect(labels).toEqual([]);
  });

  it('generated code passes checkReturnStatementsMissingFields', async () => {
    const { generateFromTemplate } = await getModule();
    const { checkReturnStatementsMissingFields } = await import('../rule-code-validator.js');
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash', commandRegex: 'rm' }]);
    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected non-null result');
    const violations = checkReturnStatementsMissingFields(result);
    expect(violations).toEqual([]);
  });

  it('generated code passes checkMatchedFalseDecisions', async () => {
    const { generateFromTemplate } = await getModule();
    const { checkMatchedFalseDecisions } = await import('../rule-code-validator.js');
    const result = generateFromTemplate('P_TEST', 'test', [{ toolName: 'bash', commandRegex: 'rm' }]);
    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected non-null result');
    const violations = checkMatchedFalseDecisions(result);
    expect(violations).toEqual([]);
  });
});

// ── SEC-BASE-2: forbidden patterns upgrade (vm escape surface) ─────────────
// Adds: import.meta, WeakRef, FinalizationRegistry, SharedArrayBuffer, Atomics
// These are meta-programming & shared-memory primitives that widen the vm
// escape surface. See docs/architecture/SECURITY_BASELINE.md §4 (sandbox layer).

describe('SEC-BASE-2: forbidden patterns upgrade (vm escape surface)', () => {
  async function getModule() {
    return import('../rule-code-validator.js');
  }

  const NEW_FORBIDDEN = [
    { label: 'import.meta', code: 'const x = import.meta.url;' },
    { label: 'WeakRef', code: 'const r = new WeakRef({});' },
    { label: 'FinalizationRegistry', code: 'const r = new FinalizationRegistry(() => {});' },
    { label: 'SharedArrayBuffer', code: 'const b = new SharedArrayBuffer(8);' },
    { label: 'Atomics', code: 'Atomics.load(new Int32Array(1), 0);' },
  ];

  for (const { label, code } of NEW_FORBIDDEN) {
    it(`forbids ${label}`, async () => {
      const { checkForbiddenPatterns } = await getModule();
      const labels = checkForbiddenPatterns(code);
      expect(labels).toContain(label);
    });
  }

  it('bracket access to new forbidden globals is also blocked', async () => {
    const { checkForbiddenPatterns } = await getModule();
    // Bracket access — common vm escape evasion
    const labels = checkForbiddenPatterns("const x = globalThis['WeakRef'];");
    expect(labels).toContain('bracket access to forbidden global');
  });
});
