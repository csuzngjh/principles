/**
 * Deterministic context-reference hash (observability + receipt evidence).
 *
 * Shared by the runner (when recording) and post-restart evidence
 * reconstruction (when re-deriving), so both sides always use ONE
 * implementation (PRI-1146 P2-01).
 */
export function hashContextRefs(refs: readonly string[]): string {
  if (refs.length === 0) return 'empty';
  const str = refs.join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return `ctx-${Math.abs(hash).toString(16)}`;
}
