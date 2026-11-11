import { describe, it, expect } from 'vitest';
import { estimateLineChanges } from '../risk-calculator-policy.js';
import { buildToolSemanticRegistry, type ToolSemanticRegistry, type ToolSemanticMappingV1 } from '../../internalization/tool-semantic-registry.js';

// The estimator reads the write family from the ONE semantic authority. The
// core baseline covers the generic vocabulary (write_file/write/replace/edit/
// apply_patch -> write); `delete_file` is not in the host-neutral baseline, so
// the test declares it exactly like a host would (ADR: hosts own raw names).
function makeRegistry(extra: readonly ToolSemanticMappingV1[] = []): ToolSemanticRegistry {
  const built = buildToolSemanticRegistry(extra);
  if (!built.ok) throw new Error(`test registry invalid: ${built.errors.join('; ')}`);
  return built.registry;
}

const registry = makeRegistry([{ rawToolName: 'delete_file', canonicalKind: 'write' }]);

describe('estimateLineChanges', () => {
  it('should estimate line changes correctly for write_file', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: 'line1\nline2\nline3' },
    }, registry);
    expect(lines).toBe(3);
  });

  it('should estimate line changes correctly for replace', () => {
    const lines = estimateLineChanges({
      toolName: 'replace',
      params: { new_string: 'a\nb\nc\nd\ne' },
    }, registry);
    expect(lines).toBe(5);
  });

  it('should estimate 50 for delete_file', () => {
    const lines = estimateLineChanges({
      toolName: 'delete_file',
      params: {},
    }, registry);
    expect(lines).toBe(50);
  });

  it('should return 0 for unknown tool', () => {
    const lines = estimateLineChanges({
      toolName: 'unknown_tool',
      params: {},
    }, registry);
    expect(lines).toBe(0);
  });

  it('should handle empty content for write_file', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: '' },
    }, registry);
    expect(lines).toBe(1);
  });

  it('should handle apply_patch tool', () => {
    const lines = estimateLineChanges({
      toolName: 'apply_patch',
      params: { patch: '+line1\n-line2\n+line3\n context' },
    }, registry);
    expect(lines).toBe(3);
  });

  // Regression: apply_patch must NOT count --- / +++ file headers as changes.
  // See CodeRabbit review on PR #1094 (P2): unified-diff headers overcounted by 2.
  it('should exclude --- / +++ file headers from apply_patch line count', () => {
    const lines = estimateLineChanges({
      toolName: 'apply_patch',
      params: {
        patch: '--- a/file.txt\n+++ b/file.txt\n+line1\n-line2\n context',
      },
    }, registry);
    // Only +line1 and -line2 are actual changes; --- and +++ are file headers.
    expect(lines).toBe(2);
  });

  // Regression: non-string params must NOT throw. See rc-2-no-as-bypass.
  it('should return 0 (not throw) when params.content is a number', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: 12345 },
    }, registry);
    expect(lines).toBe(1); // '' split by '\n' gives [''], length 1
  });

  it('should return 0 (not throw) when params.content is an object', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: { foo: 'bar' } },
    }, registry);
    expect(lines).toBe(1);
  });

  it('should return 0 (not throw) when params.content is an array', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: ['a', 'b'] },
    }, registry);
    expect(lines).toBe(1);
  });

  it('should return 0 (not throw) when params.new_string is null', () => {
    const lines = estimateLineChanges({
      toolName: 'replace',
      params: { new_string: null },
    }, registry);
    expect(lines).toBe(1);
  });

  it('should return 0 (not throw) when params.patch is a number', () => {
    const lines = estimateLineChanges({
      toolName: 'apply_patch',
      params: { patch: 999 },
    }, registry);
    expect(lines).toBe(0);
  });

  // Task 2 counterexample: after the family is declared in the ONE semantic
  // registry, risk follows automatically. Before this change the estimator
  // returned 0 for any raw name outside its private vocabulary.
  it('estimates a write family declared only in the semantic registry', () => {
    const withNewFamily = makeRegistry([
      { rawToolName: 'delete_file', canonicalKind: 'write' },
      { rawToolName: 'bulk_writer_v2', canonicalKind: 'write' },
    ]);
    const lines = estimateLineChanges({
      toolName: 'bulk_writer_v2',
      params: { content: 'a\nb\nc' },
    }, withNewFamily);
    expect(lines).toBe(3);
  });

  // Negative control: the canonical kind is the authority, so a name declared
  // as `execute` is NOT estimated from its payload shape.
  it('does not estimate a non-write family even when the payload looks like content', () => {
    const withExecute = makeRegistry([
      { rawToolName: 'delete_file', canonicalKind: 'write' },
      { rawToolName: 'shell_writer', canonicalKind: 'execute' },
    ]);
    const lines = estimateLineChanges({
      toolName: 'shell_writer',
      params: { content: 'a\nb\nc' },
    }, withExecute);
    expect(lines).toBe(0);
  });
});
