/**
 * PRI-817 — regression guard for the audit "family-1" defect class:
 * dynamically synthesized prompt examples must SATISFY the semantic rules of
 * the very validator the same prompt advertises. Previously the generic
 * synthesizer emitted placeholders ("example", fabricated registry ids) that
 * an LLM imitating the example would be rejected for.
 *
 * Invariant (new): for every diag stage schema, adapter.generateExample()
 * output must pass the stage's production validator.
 * Plus: the hand-written artificer OUTPUT FORMAT example must itself carry
 * the three v2-required obligations and reference the CONTEXT MODE block by
 * its true position ("below"), guarding against prompt/example drift.
 */
import { describe, it, expect } from 'vitest';
import { DefaultSchemaPromptAdapter } from '../schema-prompt-adapter.js';
import { DefaultDiagnosticianValidator } from '../../runner/default-validator.js';
import { DefaultDiagRootCauseValidator } from '../../diagnostician/diag-rootcause-output.js';
import { DefaultDiagDistillerValidator } from '../../diagnostician/diag-distiller-output.js';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';
import { DiagRootCauseOutputV1Schema } from '../../diagnostician/diag-rootcause-output.js';
import { DiagDistillerOutputV1Schema } from '../../diagnostician/diag-distiller-output.js';
import { ARTIFICER_PROTOCOL_INSTRUCTION } from '../../internalization/artificer-prompt-builder.js';
import { validateRuleContextV2 } from '../../internalization/rule-context-v2.js';

const adapter = new DefaultSchemaPromptAdapter();

async function expectExamplePassesValidator<T>(
  schema: Parameters<typeof adapter.generateExample>[0],
  validator: { validate(output: T, taskId: string): Promise<{ valid: boolean; errors: readonly string[] }> },
  label: string,
): Promise<void> {
  const raw = adapter.generateExample(schema);
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(raw);
  }, `${label}: generated example must be valid JSON`).not.toThrow();
  // Production runners reconcile lineage echoes (reconcileLineageEcho)
  // BEFORE validation, so a synthesized taskId placeholder is normalized to
  // the authoritative value. Simulate that step here — the invariant under
  // test is the example's SEMANTIC content, not lineage echo.
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    (parsed as Record<string, unknown>).taskId = `${label}-task`;
  }
  // The `as T` only satisfies the declared parameter type; the production
  // validators re-guard the value at runtime (their first step is a type
  // guard), so no untrusted data escapes validation.
  const result = await validator.validate(parsed as T, `${label}-task`);
  expect(result.valid, `${label}: synthesized example must pass its own validator — errors: ${result.errors.join('; ')}`).toBe(true);
}

describe('PRI-817: synthesized prompt examples pass their production validators', () => {
  it('diag_rootcause example passes DefaultDiagRootCauseValidator (category prefix)', async () => {
    await expectExamplePassesValidator(
      DiagRootCauseOutputV1Schema,
      new DefaultDiagRootCauseValidator(),
      'diag-rootcause',
    );
  });

  it('diag_distiller example passes DefaultDiagDistillerValidator (registry ids)', async () => {
    await expectExamplePassesValidator(
      DiagDistillerOutputV1Schema,
      new DefaultDiagDistillerValidator(),
      'diag-distiller',
    );
  });

  it('diag_router example passes DefaultDiagnosticianValidator', async () => {
    await expectExamplePassesValidator(
      DiagnosticianOutputV1Schema,
      new DefaultDiagnosticianValidator(),
      'diag-router',
    );
  });

  it('semantic overrides: rootCause carries a category prefix, grounded ids come from the T-registry', () => {
    const rootCauseExample = JSON.parse(adapter.generateExample(DiagRootCauseOutputV1Schema)) as { rootCause?: string };
    expect(rootCauseExample.rootCause).toMatch(/^(People|Design|Assumption|Tooling): /);
    const distillerExample = JSON.parse(adapter.generateExample(DiagDistillerOutputV1Schema)) as {
      groundedOnCorePrincipleIds?: string[];
    };
    for (const id of distillerExample.groundedOnCorePrincipleIds ?? []) {
      expect(id).toMatch(/^T-\d{2}$/);
    }
  });
});

describe('PRI-817: artificer OUTPUT FORMAT example carries the v2 obligations', () => {
  const instruction = ARTIFICER_PROTOCOL_INSTRUCTION;

  it('example declares requiresContextVersion: 2', () => {
    expect(instruction).toContain('"requiresContextVersion": 2');
  });

  it('example declares top-level evidenceRefs', () => {
    expect(instruction).toContain('"evidenceRefs":');
  });

  it('OUTPUT FORMAT block is parseable JSON and every example ruleContext passes validateRuleContextV2', () => {
    // PRI-817 review (817-1): the hand-written example itself must be
    // contract-legal — a placeholder string for an object field would be
    // family-1 relapse in the new fields. Parse the whole block and run each
    // example ruleContext through the production validator.
    const start = instruction.indexOf('{', instruction.indexOf('OUTPUT FORMAT'));
    const end = instruction.indexOf('\nNOTE:', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const parsed = JSON.parse(instruction.slice(start, end)) as {
      goldenTraceCases: { ruleContext?: unknown }[];
    };
    expect(Array.isArray(parsed.goldenTraceCases)).toBe(true);
    expect(parsed.goldenTraceCases.length).toBeGreaterThanOrEqual(2);
    for (const tc of parsed.goldenTraceCases) {
      expect(tc.ruleContext, 'case-level ruleContext must be present in the example').toBeDefined();
      const result = validateRuleContextV2(tc.ruleContext);
      expect(result.valid, `example ruleContext must be validator-legal — errors: ${result.errors.join('; ')}`).toBe(true);
    }
  });

  it('CONTEXT MODE is referenced by its true position (below, not above)', () => {
    expect(instruction).toContain('CONTEXT MODE block below');
    expect(instruction).not.toContain('CONTEXT MODE block above');
  });
});
