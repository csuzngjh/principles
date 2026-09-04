/**
 * Tool Semantic Registry tests — PRI-634-F Phase 1 (Tool Semantic Closure)
 *
 * SPEC §12 Phase 1 acceptance:
 *   1. execute_command → execute
 *   2. exec → execute
 *   3. unknown tool → explicit failure (lookup null; validation layer fails
 *      via validateRuleReliability — see rule-reliability-validation.test.ts)
 */

import { describe, expect, it } from 'vitest';
import {
  buildToolSemanticRegistry,
  validateToolSemanticMappings,
  type ToolSemanticMappingV1,
} from '../tool-semantic-registry.js';
import { canonicalizeToolKind } from '../rule-context-v2.js';

// The baseline registry always builds (static table, no host input) — a
// failure here is a programming error and the throw surfaces it directly.
function baselineRegistry() {
  const built = buildToolSemanticRegistry();
  if (!built.ok) throw new Error(`baseline registry failed to build: ${built.errors.join('; ')}`);
  return built.registry;
}

describe('buildToolSemanticRegistry — baseline layer', () => {
  it('resolves SPEC §1 Problem A LLM vocabulary names to execute', () => {
    const registry = baselineRegistry();
    // Artificer emits these; before PRI-634-F they degraded to 'other'.
    expect(registry.resolve('execute_command')).toBe('execute');
    expect(registry.resolve('run_script')).toBe('execute');
    expect(registry.resolve('code_interpreter')).toBe('execute');
  });

  it('resolves core baseline names (SPEC Phase 1 acceptance #2)', () => {
    const registry = baselineRegistry();
    expect(registry.resolve('exec')).toBe('execute');
    expect(registry.resolve('bash')).toBe('execute');
    expect(registry.resolve('write_file')).toBe('write');
    expect(registry.resolve('grep')).toBe('search');
    expect(registry.resolve('read_file')).toBe('read');
    expect(registry.resolve('sessions_spawn')).toBe('agent');
  });

  it('lookup returns null for unknown raw names (explicit unknown)', () => {
    expect(baselineRegistry().lookup('totally_unknown_tool')).toBeNull();
  });

  it('resolve falls back to other for unknown raw names (runtime graceful)', () => {
    const registry = baselineRegistry();
    expect(registry.resolve('totally_unknown_tool')).toBe('other');
    expect(registry.resolve('__proto__')).toBe('other');
    expect(registry.resolve('constructor')).toBe('other');
  });

  it('canonicalizeToolKind keeps baseline-only semantics (host-aware callers use the registry)', () => {
    expect(canonicalizeToolKind('exec')).toBe('execute');
    // Host-neutral baseline includes the generic LLM vocabulary additions…
    expect(canonicalizeToolKind('execute_command')).toBe('execute');
    // …but never host tool names declared only by a host layer.
    expect(canonicalizeToolKind('shell')).toBe('other');
  });
});

describe('buildToolSemanticRegistry — host layer', () => {
  it('host mappings layer over the baseline and win on conflict', () => {
    const built = buildToolSemanticRegistry([
      { rawToolName: 'shell', canonicalKind: 'execute' },
      { rawToolName: 'cmd', canonicalKind: 'execute' },
      { rawToolName: 'my_host_lint', canonicalKind: 'search' },
      { rawToolName: 'write', canonicalKind: 'write' }, // idempotent re-declaration
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const {registry} = built;
    expect(registry.resolve('shell')).toBe('execute');
    expect(registry.resolve('cmd')).toBe('execute');
    expect(registry.resolve('my_host_lint')).toBe('search');
    // Baseline entries remain resolvable through the merged registry.
    expect(registry.resolve('exec')).toBe('execute');
    expect(registry.resolve('write_file')).toBe('write');
  });

  it('the same registry value resolves identically across calls (deterministic)', () => {
    const built = buildToolSemanticRegistry([{ rawToolName: 'shell', canonicalKind: 'execute' }]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const a = built.registry.resolve('shell');
    const b = built.registry.resolve('shell');
    expect(a).toBe(b);
  });
});
describe('validateToolSemanticMappings — untrusted declaration validation', () => {
  it('rejects non-array input', () => {
    const result = validateToolSemanticMappings({ rawToolName: 'x', canonicalKind: 'write' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('must be an array');
  });

  it('rejects invalid canonicalKind values (rc-4: every element checked)', () => {
    const result = validateToolSemanticMappings([
      { rawToolName: 'ok_tool', canonicalKind: 'write' },
      { rawToolName: 'bad_tool', canonicalKind: 'cron' },
      'not-an-object',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('[1].canonicalKind'))).toBe(true);
    expect(result.errors.some((e) => e.includes('[2] must be a plain object'))).toBe(true);
  });

  it('rejects empty/whitespace raw names', () => {
    const result = validateToolSemanticMappings([{ rawToolName: '  ', canonicalKind: 'write' }]);
    expect(result.valid).toBe(false);
  });

  it('rejects prototype-pollution keys as raw names (rc-5)', () => {
    const result = validateToolSemanticMappings([{ rawToolName: '__proto__', canonicalKind: 'write' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('prototype-pollution');
  });

  it('rejects conflicting duplicate declarations, accepts idempotent ones', () => {
    const conflicting = validateToolSemanticMappings([
      { rawToolName: 'shell', canonicalKind: 'execute' },
      { rawToolName: 'shell', canonicalKind: 'write' },
    ]);
    expect(conflicting.valid).toBe(false);
    expect(conflicting.errors[0]).toContain('conflicting');

    const idempotent = validateToolSemanticMappings([
      { rawToolName: 'shell', canonicalKind: 'execute' },
      { rawToolName: 'shell', canonicalKind: 'execute' },
    ]);
    expect(idempotent.valid).toBe(true);
  });

  it('buildToolSemanticRegistry fails loud on an invalid host declaration (rc-3)', () => {
    // Simulate a malformed declaration reaching the builder (untrusted `unknown`
    // at the boundary — the validator must catch it, not the type system).
    const malformed: unknown = [{ rawToolName: 'x', canonicalKind: 'nope' }];
    const built = buildToolSemanticRegistry(malformed as ToolSemanticMappingV1[]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.length).toBeGreaterThan(0);
  });
});
