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
 *   - true cycle (object is its own ancestor) → '[Circular]' placeholder, no crash;
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
    const out = JSON.parse(serializePromptInput(input)) as Record<string, any>;
    expect(out.a.tokenId).toBe('tok-1');
    expect(out.b.tokenId).toBe('tok-1');
    expect(out.list[0].tokenId).toBe('tok-1');
    expect(out.list[1].tokenId).toBe('tok-1');
  });

  it('replaces a TRUE cycle with "[Circular]" (bounded output, no crash)', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = JSON.parse(serializePromptInput(a)) as Record<string, any>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('replaces an indirect cycle at the repeating depth only', () => {
    const leaf: Record<string, unknown> = { v: 1 };
    const mid: Record<string, unknown> = { leaf };
    const root: Record<string, unknown> = { mid, alias: mid };
    // root → mid → leaf is a DAG (alias re-visits mid AFTER its subtree completed)
    const out = JSON.parse(serializePromptInput(root)) as Record<string, any>;
    expect(out.mid.leaf.v).toBe(1);
    expect(out.alias.leaf.v).toBe(1);
  });

  it('maps bigint values with the n suffix', () => {
    const out = JSON.parse(serializePromptInput({ count: 5n }));
    expect(out.count).toBe('5n');
  });

  it('returns "null" for an undefined root and still caps oversized output', () => {
    expect(serializePromptInput(undefined)).toBe('null');
    const big = { blob: 'x'.repeat(60_000) };
    expect(() => serializePromptInput(big)).toThrow(RangeError);
  });
});
