/**
 * Trusted router context evidence (SPEC-PD-RULE-ASSOCIATION-005 v0.6 §5).
 *
 * The receipt proves, for one diagnostician router run, exactly which
 * canonical principles and evidence refs the SYSTEM exposed to the model. It
 * is produced BEFORE the model call, persisted immutably inside the committed
 * artifact envelope (`artifacts.content_json` / `pi_artifacts.contentJson`),
 * and re-verifiable after a restart by digest comparison.
 *
 * Rules:
 *  - The exposed set is the only allowlist association validation may trust;
 *    the current Ledger state is NEVER a substitute for the historical
 *    exposure (a principle added later cannot impersonate history).
 *  - When the system cannot prove what was exposed, the receipt carries a
 *    typed `unavailable` with a machine-readable reason — never a guess.
 */
import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const DigestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });

// ── Trusted principle exposure entry ────────────────────────────────────────

/**
 * One canonical principle the system exposed to the model for a router run.
 * The digest is computed over the canonicalized `{id, version, status, text}`
 * tuple with a fixed key order, so any consumer can re-verify the record.
 */
export interface RouterTrustedPrinciple {
  /** Canonical ledger principleId (the only id the model may reference). */
  readonly principleId: string;
  /** Ledger lifecycle status at exposure time (candidate | probation | active). */
  readonly status: string;
  /** Semantic version of the principle record. */
  readonly version: number;
  /** Principle body text as exposed to the model. */
  readonly text: string;
  /** sha256 over the canonicalized {id, version, status, text} tuple. */
  readonly contentDigest: string;
}

const RouterTrustedPrincipleSchema = Type.Object({
  principleId: Type.String({ minLength: 1 }),
  status: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 0 }),
  text: Type.String(),
  contentDigest: DigestSchema,
}, { additionalProperties: false });

/**
 * Deterministic content digest for a trusted principle exposure entry.
 * Fixed key order, fixed field set, sha256 hex — version this function only
 * by changing the receipt schemaVersion (SPEC v0.6 §5).
 */
export function computeTrustedPrincipleDigest(entry: {
  principleId: string;
  status: string;
  version: number;
  text: string;
}): string {
  const canonical = JSON.stringify({
    id: entry.principleId,
    version: entry.version,
    status: entry.status,
    text: entry.text,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Read-side port for assembling the trusted principle exposure before the
 * model call (SPEC v0.6 §5). Implementations read from PD's authoritative
 * sources (Principle Ledger / verified read models) — NEVER from model output.
 *
 * A readable ledger with zero eligible principles is a PROVEN empty exposure
 * (`ok` with `principles: []`), not `unavailable` — the model demonstrably saw
 * no canonical ids. `unavailable` is reserved for "cannot prove what was (or
 * would be) exposed".
 */
export interface RouterTrustedPrincipleSource {
  readTrustedPrinciples():
    | { status: 'ok'; principles: RouterTrustedPrinciple[] }
    | { status: 'unavailable'; reason: 'ledger_unavailable' | 'ledger_corrupt' | 'source_not_configured' };
}

/** Runtime guard (rc-1/rc-2): structural detection of the source port on an
 * injected dependency — lets the runtime factory accept the concrete ledger
 * adapter through its narrow LedgerAdapter-typed option without a cast. */
export function isRouterTrustedPrincipleSource(value: unknown): value is RouterTrustedPrincipleSource {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).readTrustedPrinciples === 'function';
}

// ── Receipt schema ───────────────────────────────────────────────────────────

/**
 * PRI-1146: receipt schemaVersion bumped v1 → v2 because `canonicalPrinciples`
 * gained the `available` shape and the receipt now pins the exposed evidence
 * refs. Old `router-context-v1` receipts belong to retired V1-only artifacts
 * and are not readable through this contract (Clean Break).
 */
export const RouterContextReceiptSchema = Type.Object({
  schemaVersion: Type.Literal('router-context-v2'),
  taskId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
  // Neutral canonical ref (PRI-1139); `diagnostician-output` resolves to the
  // V2 schema since PRI-1146. A versioned spelling here is a receipt bug.
  outputSchemaRef: Type.Literal('diagnostician-output'),
  contextHash: Type.String({ minLength: 1 }),
  messageDigest: DigestSchema,
  systemPromptDigest: DigestSchema,
  predecessorDigests: Type.Array(Type.Object({
    artifactId: Type.String({ minLength: 1 }), contentDigest: DigestSchema,
  }), { minItems: 2, maxItems: 2 }),
  /**
   * Evidence sourceRefs actually exposed to the model in this run (from the
   * Stage A predecessor artifact's evidence array). Association evidenceRefs
   * must be a subset of this list.
   */
  evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  canonicalPrinciples: Type.Union([
    Type.Object({
      status: Type.Literal('available'),
      /**
       * The exact set exposed to the model — may be empty (a provably empty
       * allowlist is still "available": the model saw no canonical ids).
       */
      principles: Type.Array(RouterTrustedPrincipleSchema),
    }, { additionalProperties: false }),
    Type.Object({
      status: Type.Literal('unavailable'),
      reason: Type.Union([
        Type.Literal('ledger_unavailable'),
        Type.Literal('ledger_corrupt'),
        Type.Literal('source_not_configured'),
      ]),
      nextAction: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  ]),
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
  if (receipt.canonicalPrinciples.status === 'available') {
    // rc-4-validate-array-elements: uniqueness is by principleId (object-level
    // uniqueItems cannot express this), and every digest must verify against
    // the entry it travels with — a self-consistent, non-ambiguous allowlist.
    const seen = new Set<string>();
    for (const entry of receipt.canonicalPrinciples.principles) {
      if (seen.has(entry.principleId)) return invalid('context_receipt_invalid');
      seen.add(entry.principleId);
      if (computeTrustedPrincipleDigest(entry) !== entry.contentDigest) return invalid('context_receipt_invalid');
    }
  }
  return { status: 'available', receipt };
}

/** Re-verify reconstructed system input after restart; current Ledger is not input evidence. */
export function verifyRouterContextReceipt(
  envelope: unknown,
  expected: {
    taskId: string; runId: string; contextHash: string; message: string; systemPrompt: string;
    predecessors: { artifactId: string; content: unknown }[];
    /** What the caller can prove was actually exposed (runner replay); optional. */
    exposed?: { principles: readonly RouterTrustedPrinciple[]; evidenceRefs: readonly string[] };
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
  if (expected.exposed) {
    // The receipt must match the exposure the caller can reconstruct from the
    // persisted prompt input — same principle set (id + digest) and same
    // evidence refs. A receipt claiming exposure the input cannot show (or
    // vice versa) is a mismatch, not a partial pass.
    const receiptPrinciples = result.receipt.canonicalPrinciples.status === 'available'
      ? result.receipt.canonicalPrinciples.principles : undefined;
    if (!receiptPrinciples) return mismatch();
    if (receiptPrinciples.length !== expected.exposed.principles.length) return mismatch();
    const expectedById = new Map(expected.exposed.principles.map((p) => [p.principleId, p]));
    if (expectedById.size !== expected.exposed.principles.length) return mismatch();
    for (const entry of receiptPrinciples) {
      const match = expectedById.get(entry.principleId);
      if (!match || match.contentDigest !== entry.contentDigest) return mismatch();
    }
    const expectedRefs = new Set(expected.exposed.evidenceRefs);
    if (expectedRefs.size !== expected.exposed.evidenceRefs.length) return mismatch();
    if (result.receipt.evidenceRefs.length !== expectedRefs.size
      || result.receipt.evidenceRefs.some((ref) => !expectedRefs.has(ref))) return mismatch();
  }
  return result;
}
