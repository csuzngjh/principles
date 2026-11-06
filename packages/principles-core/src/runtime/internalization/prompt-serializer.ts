const MAX_PROMPT_CHARS = 50_000;

/**
 * Serialize untrusted prompt context without circular-reference crashes or
 * unbounded output.
 *
 * Contract: NATIVE JSON.stringify value semantics — property enumeration,
 * toJSON() (Date → ISO string, custom canonicalizers), arrays, primitives —
 * stay with the engine. This wrapper only:
 *   (a) maps bigint to an "Nn" string (native stringify throws on bigint),
 *   (b) replaces true ancestor-path cycles with '[Circular]',
 *   (c) enforces the output-size cap on the FINAL serialized string.
 *
 * DAG-aware (EP002-R2): a WeakSet of every visited object misclassifies a
 * repeated reference (the same contract reachable via two separate paths —
 * e.g. `intentContract` and `scribeArtifact.intentContract`) as a cycle and
 * would emit '[Circular]' where the LLM needs the content. Cycle detection
 * therefore tracks the CURRENT ancestor path only: an object re-entered while
 * still on the path is a true cycle (replaced, bounded); an object reached
 * again after its subtree completed serializes in full.
 *
 * Implemented as a JSON.stringify replacer instead of a manual walker so
 * non-plain objects keep native semantics: the engine applies toJSON() BEFORE
 * calling the replacer, so a Date arrives already converted and is never
 * re-enumerated into '{}'. The replacer runs pre-order over the serialization
 * tree with `this` = the object whose property is being emitted; unwinding the
 * ancestor stack to `this` on every call pops the previous sibling's completed
 * subtree — exactly the exit signal a flat WeakSet lacks.
 */
export function serializePromptInput(value: unknown): string {
  const ancestors: object[] = [];
  const onPath = new Set<object>();

  const replacer = function (this: object, key: string, node: unknown): unknown {
    if (typeof node === 'bigint') return `${node}n`;
    if (typeof node !== 'object' || node === null) return node;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      const exited = ancestors.pop();
      if (exited !== undefined) onPath.delete(exited);
    }
    if (onPath.has(node)) return '[Circular]';
    ancestors.push(node);
    onPath.add(node);
    return node;
  };

  const serialized = JSON.stringify(value, replacer);
  if (serialized === undefined) return 'null';
  if (serialized.length > MAX_PROMPT_CHARS) {
    throw new RangeError(`prompt input exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  return serialized;
}
