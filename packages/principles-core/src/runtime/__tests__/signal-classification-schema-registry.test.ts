import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import {
  OUTPUT_SCHEMA_REGISTRY,
  resolveOutputSchema,
} from '../adapter/output-schema-registry.js';
import { SignalClassificationOutputV2Schema } from '../signal-collector/types.js';

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Production .ts files under runtime, excluding test directories/files. */
function productionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Stage-2 structured-output registry contract.
 *
 * Why this exists: the production classifier (host-runtime/signal-classifier.ts)
 * requests an `outputSchemaRef` by string. v1 was retired and PRI-1139 made the
 * version-neutral `signal-classification-output` the canonical key (the pre-v2
 * spelling still resolves through the PRI-1104 alias table); a stale v1 request
 * would make PiAiRuntimeAdapter fail loud (`output_invalid`) and be swallowed
 * into a `null` classification. These assertions pin the registry side of that
 * contract with the REAL registry map (no mock).
 */
describe('signal-classification output schema registry', () => {
  it('resolves the canonical ref the Stage-2 classifier requests (PRI-1139)', () => {
    expect(OUTPUT_SCHEMA_REGISTRY.get('signal-classification-output'))
      .toBe(SignalClassificationOutputV2Schema);
  });

  it('keeps the pre-cutover v2 spelling readable through the alias table', () => {
    expect(resolveOutputSchema('signal-classification-output-v2'))
      .toBe(SignalClassificationOutputV2Schema);
  });

  it('does not register the retired v1 ref', () => {
    expect(OUTPUT_SCHEMA_REGISTRY.has('signal-classification-output-v1')).toBe(false);
    expect(resolveOutputSchema('signal-classification-output-v1')).toBeUndefined();
  });

  it('every production outputSchemaRef under runtime resolves in the registry', () => {
    const usedRefs = new Map<string, string[]>();
    for (const file of productionTsFiles(runtimeRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const [, ref] of source.matchAll(/outputSchemaRef:\s*'([^']+)'/g)) {
        if (ref === undefined) continue;
        const owners = usedRefs.get(ref) ?? [];
        owners.push(path.relative(runtimeRoot, file));
        usedRefs.set(ref, owners);
      }
    }
    // Guard against a silently empty scan (e.g. a refactor moving the sources).
    expect(usedRefs.size).toBeGreaterThan(0);
    for (const [ref, owners] of usedRefs) {
      expect(resolveOutputSchema(ref), `${ref} used by ${owners.join(', ')}`).toBeDefined();
    }
  });

  it('accepts both contract outputs: correction and none', () => {
    const correction = {
      is_feedback: true,
      type: 'correction',
      confidence: 0.97,
      reason: '用户明确指出 AI 不应直接替其做决定',
    };
    const none = {
      is_feedback: false,
      type: 'none',
      confidence: 0.9,
      reason: '普通任务指令',
    };
    expect(Value.Check(SignalClassificationOutputV2Schema, correction)).toBe(true);
    expect(Value.Check(SignalClassificationOutputV2Schema, none)).toBe(true);
  });

  it('rejects payloads outside the contract', () => {
    expect(Value.Check(SignalClassificationOutputV2Schema, { is_feedback: true })).toBe(false);
    expect(Value.Check(SignalClassificationOutputV2Schema, {
      is_feedback: true, type: 'other', confidence: 0.5, reason: 'x',
    })).toBe(false);
    expect(Value.Check(SignalClassificationOutputV2Schema, {
      is_feedback: true, type: 'correction', confidence: 2, reason: 'x',
    })).toBe(false);
  });
});
