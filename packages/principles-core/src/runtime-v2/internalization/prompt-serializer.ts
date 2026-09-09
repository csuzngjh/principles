const MAX_PROMPT_CHARS = 50_000;

/**
 * Serialize untrusted prompt context without circular-reference crashes or
 * unbounded output.
 *
 * DAG-aware (EP002-R2): a WeakSet of every visited object misclassifies a
 * repeated reference (the same contract reachable via two separate paths —
 * e.g. `intentContract` and `scribeArtifact.intentContract`) as a cycle and
 * would emit '[Circular]' where the LLM needs the content. Cycle detection
 * therefore tracks the CURRENT ancestor path only: an object re-entered while
 * still on the path is a true cycle (replaced, bounded); an object reached
 * again after its subtree completed serializes in full.
 */
export function serializePromptInput(value: unknown): string {
  const ancestors = new Set<object>();

  const walk = (node: unknown): unknown => {
    if (typeof node === 'bigint') return `${node}n`;
    if (typeof node !== 'object' || node === null) return node;
    if (ancestors.has(node)) return '[Circular]';
    ancestors.add(node);
    try {
      if (Array.isArray(node)) return node.map(walk);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    } finally {
      ancestors.delete(node);
    }
  };

  const serialized = JSON.stringify(walk(value));
  if (serialized === undefined) return 'null';
  if (serialized.length > MAX_PROMPT_CHARS) {
    throw new RangeError(`prompt input exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  return serialized;
}
