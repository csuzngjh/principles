import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const DigestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const RouterContextReceiptSchema = Type.Object({
  schemaVersion: Type.Literal('router-context-v1'),
  taskId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  outputSchemaRef: Type.Literal('diagnostician-output-v1'),
  contextHash: Type.String({ minLength: 1 }),
  messageDigest: DigestSchema,
  systemPromptDigest: DigestSchema,
  predecessorDigests: Type.Array(Type.Object({
    artifactId: Type.String({ minLength: 1 }), contentDigest: DigestSchema,
  }), { minItems: 2, maxItems: 2 }),
  canonicalPrinciples: Type.Object({
    status: Type.Literal('unavailable'),
    reason: Type.Literal('router_has_no_system_canonical_principle_allowlist'),
    nextAction: Type.String({ minLength: 1 }),
  }),
});
export type RouterContextReceipt = Static<typeof RouterContextReceiptSchema>;

/** Read only a system-produced artifact envelope, never a model response. */
export function readRouterContextReceipt(
  envelope: unknown,
  expected: { taskId: string; runId: string },
): { status: 'available'; receipt: RouterContextReceipt } | { status: 'unavailable'; reason: string; nextAction: string } {
  const invalid = (reason: string) => ({ status: 'unavailable' as const, reason, nextAction: 'Inspect the immutable router artifact and its task/run lineage; do not infer a canonical allowlist.' });
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || !Object.hasOwn(envelope, 'trustedContextReceipt')) return invalid('context_receipt_missing');
  const receipt: unknown = Reflect.get(envelope, 'trustedContextReceipt');
  if (!Value.Check(RouterContextReceiptSchema, receipt)) return invalid('context_receipt_invalid');
  if (receipt.taskId !== expected.taskId || receipt.runId !== expected.runId) return invalid('context_receipt_lineage_mismatch');
  return { status: 'available', receipt };
}

/** Re-verify reconstructed system input after restart; current Ledger is not input evidence. */
export function verifyRouterContextReceipt(
  envelope: unknown,
  expected: {
    taskId: string; runId: string; contextHash: string; message: string; systemPrompt: string;
    predecessors: { artifactId: string; content: unknown }[];
  },
): ReturnType<typeof readRouterContextReceipt> {
  const result = readRouterContextReceipt(envelope, expected);
  if (result.status !== 'available') return result;
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const mismatch = () => ({ status: 'unavailable' as const, reason: 'context_receipt_source_mismatch', nextAction: 'Reload the original system input and predecessor artifacts; keep canonical association unavailable.' });
  if (result.receipt.contextHash !== expected.contextHash
    || result.receipt.messageDigest !== hash(expected.message)
    || result.receipt.systemPromptDigest !== hash(expected.systemPrompt)
    || expected.predecessors.length !== result.receipt.predecessorDigests.length) return mismatch();
  const ids = new Set(expected.predecessors.map((source) => source.artifactId));
  if (ids.size !== expected.predecessors.length) return mismatch();
  for (const source of expected.predecessors) {
    const digest = result.receipt.predecessorDigests.find((entry) => entry.artifactId === source.artifactId);
    let content: string | undefined;
    try { content = JSON.stringify(source.content); } catch { return mismatch(); }
    if (!digest || content === undefined || digest.contentDigest !== hash(content)) return mismatch();
  }
  return result;
}
