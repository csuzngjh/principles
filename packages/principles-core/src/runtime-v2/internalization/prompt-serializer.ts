const MAX_PROMPT_CHARS = 50_000;

/** Serialize untrusted prompt context without circular-reference crashes or unbounded output. */
export function serializePromptInput(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === 'bigint') return `${nested}n`;
    if (typeof nested !== 'object' || nested === null) return nested;
    if (seen.has(nested)) return '[Circular]';
    seen.add(nested);
    return nested;
  });
  if (serialized === undefined) return 'null';
  if (serialized.length > MAX_PROMPT_CHARS) {
    throw new RangeError(`prompt input exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  return serialized;
}
