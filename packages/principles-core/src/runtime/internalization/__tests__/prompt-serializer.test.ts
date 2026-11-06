import { describe, it, expect } from 'vitest';
import { serializePromptInput } from '../prompt-serializer.js';

/**
 * EP002-R2 finding: the artificer/evaluator prompt inputs legitimately contain
 * the SAME object under two paths (e.g. intentContract both at top level and
 * nested in scribeArtifact). The WeakSet-based serializer misclassified that
 * DAG re-visit as a cycle and emitted '[Circular]' — the LLM received a
 * placeholder where the contract content should have been (the evaluator
 * flagged this as "Input intentContract serialized as '[Circular]'").
 *
 * Contract under test:
 *   - DAG (object reachable twice via separate paths) → serialized in full BOTH times;
 *   - true cycle (object is its own ancestor, direct or indirect) → '[Circular]' placeholder, no crash;
 *   - native JSON.stringify value semantics preserved for non-plain values
 *     (Date/toJSON()/Map/Set) — the review regression guard: a manual walker
 *     re-enumerated Date instances into '{}';
 *   - bigint mapping + bounded output preserved.
 */
describe('serializePromptInput — DAG vs cycle', () => {
  it('serializes an object referenced twice (DAG) in full both times — not "[Circular]"', () => {
    const intentContract = { ownerIntent: 'stop guessing config contracts' };
    const input = { intentContract, scribeArtifact: { intentContract } };
    const out = JSON.parse(serializePromptInput(input));
    expect(out.intentContract.ownerIntent).toBe('stop guessing config contracts');
    expect(out.scribeArtifact.intentContract.ownerIntent).toBe('stop guessing config contracts');
  });

  it('serializes sibling references to the same leaf object without placeholders', () => {
    const shared = { tokenId: 'tok-1' };
    const input = { a: shared, b: shared, list: [shared, shared] };
    const out = JSON.parse(serializePromptInput(input)) as { a: { tokenId: string }; b: { tokenId: string }; list: { tokenId: string }[] };
    expect(out.a.tokenId).toBe('tok-1');
    expect(out.b.tokenId).toBe('tok-1');
    expect(out.list[0]?.tokenId).toBe('tok-1');
    expect(out.list[1]?.tokenId).toBe('tok-1');
  });

  it('replaces a TRUE cycle with "[Circular]" (bounded output, no crash)', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = JSON.parse(serializePromptInput(a)) as { name: string; self: string };
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('replaces an indirect cycle at the repeating depth only', () => {
    const leaf: Record<string, unknown> = { v: 1 };
    const mid: Record<string, unknown> = { leaf };
    const root: Record<string, unknown> = { mid, alias: mid };
    // root → mid → leaf is a DAG (alias re-visits mid AFTER its subtree completed)
    const out = JSON.parse(serializePromptInput(root)) as { mid: { leaf: { v: number } }; alias: { leaf: { v: number } } };
    expect(out.mid.leaf.v).toBe(1);
    expect(out.alias.leaf.v).toBe(1);
  });

  it('bounds a TRUE indirect cycle A → B → A at the back-edge only', () => {
    const a: Record<string, unknown> = { name: 'A' };
    const b: Record<string, unknown> = { parent: a };
    a.child = b;
    const out = JSON.parse(serializePromptInput(a)) as { name: string; child: { parent: unknown } };
    expect(out.name).toBe('A');
    expect(out.child.parent).toBe('[Circular]');
  });

  it('preserves native Date serialization (toJSON) instead of collapsing it to {}', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const out = JSON.parse(serializePromptInput({ at: date })) as { at: string };
    expect(out.at).toBe(date.toISOString());
  });

  it('applies a custom toJSON() exactly like native JSON.stringify', () => {
    const value = { artifact: { toJSON: () => ({ canonical: true }) } };
    expect(serializePromptInput(value)).toBe(JSON.stringify(value));
    const out = JSON.parse(serializePromptInput(value)) as { artifact: { canonical: boolean } };
    expect(out.artifact.canonical).toBe(true);
  });

  it('keeps native semantics for non-plain objects (Map/Set) — native parity, not re-enumeration', () => {
    const value = { tags: new Set(['x']), lookup: new Map([['k', 1]]) };
    // Native JSON.stringify renders Map/Set as {}; the wrapper preserves that
    // contract instead of inventing its own representation.
    expect(serializePromptInput(value)).toBe(JSON.stringify(value));
  });

  it('maps bigint values with the n suffix', () => {
    const out = JSON.parse(serializePromptInput({ count: 5n }));
    expect(out.count).toBe('5n');
  });

  it('maps bigint nested in arrays with the n suffix', () => {
    const out = JSON.parse(serializePromptInput([1n, { count: 2n }])) as unknown[];
    expect(out).toEqual(['1n', { count: '2n' }]);
  });

  it('returns "null" for an undefined root and still caps oversized output', () => {
    expect(serializePromptInput(undefined)).toBe('null');
    const big = { blob: 'x'.repeat(60_000) };
    expect(() => serializePromptInput(big)).toThrow(RangeError);
  });
});
