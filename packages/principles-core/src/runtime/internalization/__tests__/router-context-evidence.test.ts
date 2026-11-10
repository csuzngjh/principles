/**
 * Trusted router context evidence tests (PRI-1146 / SPEC v0.6 §5).
 *
 * Matrix D of the PRI-1146 acceptance test plan:
 *  - receipt `available` with an exposed principle set + per-entry digests;
 *  - receipt `unavailable` is typed (ledger_unavailable / ledger_corrupt /
 *    source_not_configured) and never a guess;
 *  - read/verify reject: wrong lineage, tampered digest, stale
 *    router-context-v1 receipts, duplicate principleId, self-inconsistent
 *    digest;
 *  - verify(...exposed) proves the receipt matches the exposure the caller
 *    can reconstruct (message/prompt/predecessors/principles/evidenceRefs);
 *  - the ledger adapter's readTrustedPrinciples: eligibility filter,
 *    deterministic order, digest correctness, unreadable ledger → typed
 *    unavailable, empty-but-readable ledger → ok([]).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  RouterContextReceiptSchema,
  readRouterContextReceipt,
  verifyRouterContextReceipt,
  computeTrustedPrincipleDigest,
  type RouterTrustedPrinciple,
} from '../router-context-evidence.js';
import { PrincipleTreeLedgerAdapter } from '../../adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger } from '../../../principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../types/ledger-store.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function makePrinciple(id: string, status: LedgerPrinciple['status'], extra: { version?: number; text?: string } = {}): LedgerPrinciple {
  return {
    id,
    version: extra.version ?? 1,
    text: extra.text ?? `principle ${id}`,
    triggerPattern: '',
    action: '',
    status,
    priority: 'P2',
    scope: 'general',
    evaluability: 'weak_heuristic',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
}

function makeTrusted(entry: { principleId: string; status: string; version: number; text: string }): RouterTrustedPrinciple {
  return { ...entry, contentDigest: computeTrustedPrincipleDigest(entry) };
}

const EXPOSED_A = makeTrusted({ principleId: '11111111-1111-4111-8111-111111111111', status: 'active', version: 2, text: 'Limit blast radius' });
const EXPOSED_B = makeTrusted({ principleId: '22222222-2222-4222-8222-222222222222', status: 'candidate', version: 1, text: 'Understand before modifying' });

const TASK_ID = 'diag_router-001';
const RUN_ID = 'run-router-001';
const MESSAGE = JSON.stringify({ taskId: TASK_ID, trustedContext: { status: 'available', principles: [EXPOSED_A, EXPOSED_B] } });
const SYSTEM_PROMPT = 'router instruction';
const PREDECESSORS = [
  { artifactId: 'pi-art-rc-001', content: { summary: 'root cause' } },
  { artifactId: 'pi-art-dist-001', content: { summary: 'distilled' } },
];

function makeReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'router-context-v2',
    taskId: TASK_ID,
    runId: RUN_ID,
    outputSchemaRef: 'diagnostician-output',
    contextHash: 'hash-001',
    messageDigest: sha(MESSAGE),
    systemPromptDigest: sha(SYSTEM_PROMPT),
    predecessorDigests: PREDECESSORS.map((p) => ({ artifactId: p.artifactId, contentDigest: sha(JSON.stringify(p.content)) })),
    evidenceRefs: ['trace:1', 'trace:2'],
    canonicalPrinciples: { status: 'available', principles: [EXPOSED_A, EXPOSED_B] },
    ...overrides,
  };
}

function envelopeWith(receipt: Record<string, unknown>): unknown {
  return { valid: true, trustedContextReceipt: receipt };
}

const VERIFY_ARGS = {
  taskId: TASK_ID,
  runId: RUN_ID,
  contextHash: 'hash-001',
  message: MESSAGE,
  systemPrompt: SYSTEM_PROMPT,
  predecessors: PREDECESSORS,
  exposed: { status: 'available' as const, principles: [EXPOSED_A, EXPOSED_B], evidenceRefs: ['trace:1', 'trace:2'] },
};

// ── Receipt schema/read ───────────────────────────────────────────────────────

describe('RouterContextReceipt (PRI-1146 trusted context evidence)', () => {
  it('accepts a valid available receipt with digested exposure', () => {
    const read = readRouterContextReceipt(envelopeWith(makeReceipt()), { taskId: TASK_ID, runId: RUN_ID });
    expect(read.status).toBe('available');
    if (read.status !== 'available') return;
    expect(read.receipt.canonicalPrinciples).toMatchObject({
      status: 'available',
      principles: [EXPOSED_A, EXPOSED_B],
    });
    expect(Value.Check(RouterContextReceiptSchema, read.receipt)).toBe(true);
  });

  it('accepts a provably EMPTY exposure as available (readable ledger, zero eligible principles)', () => {
    const read = readRouterContextReceipt(envelopeWith(makeReceipt({ canonicalPrinciples: { status: 'available', principles: [] } })), { taskId: TASK_ID, runId: RUN_ID });
    expect(read.status).toBe('available');
  });

  it('rejects the retired router-context-v1 receipt shape (Clean Break)', () => {
    const read = readRouterContextReceipt(envelopeWith(makeReceipt({ schemaVersion: 'router-context-v1' })), { taskId: TASK_ID, runId: RUN_ID });
    expect(read).toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
  });

  it('rejects wrong task/run lineage', () => {
    expect(readRouterContextReceipt(envelopeWith(makeReceipt()), { taskId: 'foreign', runId: RUN_ID }))
      .toMatchObject({ status: 'unavailable', reason: 'context_receipt_lineage_mismatch' });
    expect(readRouterContextReceipt(envelopeWith(makeReceipt()), { taskId: TASK_ID, runId: 'foreign' }))
      .toMatchObject({ status: 'unavailable', reason: 'context_receipt_lineage_mismatch' });
  });

  it('rejects a receipt whose principle digest does not match its own entry', () => {
    const tampered = makeTrusted({ principleId: EXPOSED_A.principleId, status: EXPOSED_A.status, version: EXPOSED_A.version, text: 'tampered text' });
    const read = readRouterContextReceipt(
      envelopeWith(makeReceipt({ canonicalPrinciples: { status: 'available', principles: [{ ...EXPOSED_A, contentDigest: tampered.contentDigest }, EXPOSED_B] } })),
      { taskId: TASK_ID, runId: RUN_ID },
    );
    expect(read).toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
  });

  it('rejects duplicate principleIds in the exposure', () => {
    const read = readRouterContextReceipt(
      envelopeWith(makeReceipt({ canonicalPrinciples: { status: 'available', principles: [EXPOSED_A, EXPOSED_A] } })),
      { taskId: TASK_ID, runId: RUN_ID },
    );
    expect(read).toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
  });

  it('rejects the versioned outputSchemaRef spelling on fresh receipts', () => {
    expect(readRouterContextReceipt(envelopeWith(makeReceipt({ outputSchemaRef: 'diagnostician-output-v1' })), { taskId: TASK_ID, runId: RUN_ID }))
      .toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
  });

  it('typed unavailable reasons are machine-readable', () => {
    for (const reason of ['ledger_unavailable', 'ledger_corrupt', 'source_not_configured'] as const) {
      const read = readRouterContextReceipt(
        envelopeWith(makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason, nextAction: 'repair and re-run' } })),
        { taskId: TASK_ID, runId: RUN_ID },
      );
      expect(read.status).toBe('available'); // the RECEIPT is readable; the context it records is unavailable
    }
  });

  it('missing envelope / non-object receipt / unknown reason are rejected', () => {
    expect(readRouterContextReceipt({}, { taskId: TASK_ID, runId: RUN_ID })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_missing' });
    expect(readRouterContextReceipt({ trustedContextReceipt: 'nope' }, { taskId: TASK_ID, runId: RUN_ID })).toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
    expect(readRouterContextReceipt(
      envelopeWith(makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason: 'made_up_reason', nextAction: 'x' } })),
      { taskId: TASK_ID, runId: RUN_ID },
    )).toMatchObject({ status: 'unavailable', reason: 'context_receipt_invalid' });
  });
});

// ── Exposure re-verification (restart replay) ─────────────────────────────────

describe('verifyRouterContextReceipt exposure re-verification', () => {
  it('verifies the full proven exposure (message, prompt, predecessors, principles, evidenceRefs)', () => {
    expect(verifyRouterContextReceipt(envelopeWith(makeReceipt()), VERIFY_ARGS).status).toBe('available');
  });

  it('rejects when the receipt exposure differs from the reconstructable exposure (extra principle)', () => {
    const extra = makeTrusted({ principleId: '33333333-3333-4333-8333-333333333333', status: 'active', version: 1, text: 'not in receipt' });
    const result = verifyRouterContextReceipt(envelopeWith(makeReceipt()), { ...VERIFY_ARGS, exposed: { status: 'available', principles: [EXPOSED_A, EXPOSED_B, extra], evidenceRefs: ['trace:1', 'trace:2'] } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects when a principle digest drifted (stale exposure)', () => {
    const drifted = { ...EXPOSED_B, contentDigest: sha('different content') };
    const result = verifyRouterContextReceipt(envelopeWith(makeReceipt()), { ...VERIFY_ARGS, exposed: { status: 'available', principles: [EXPOSED_A, drifted], evidenceRefs: ['trace:1', 'trace:2'] } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects when evidenceRefs exposure differs', () => {
    const result = verifyRouterContextReceipt(envelopeWith(makeReceipt()), { ...VERIFY_ARGS, exposed: { status: 'available', principles: [EXPOSED_A, EXPOSED_B], evidenceRefs: ['trace:1'] } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects a receipt recording unavailable context when exposure is claimed', () => {
    const receipt = makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'x' } });
    const result = verifyRouterContextReceipt(envelopeWith(receipt), VERIFY_ARGS);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('verifies a typed unavailable exposure (reason + nextAction + evidenceRefs) without an allowlist', () => {
    const receipt = makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run' } });
    const result = verifyRouterContextReceipt(envelopeWith(receipt), {
      ...VERIFY_ARGS,
      exposed: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run', evidenceRefs: ['trace:1', 'trace:2'] },
    });
    expect(result.status).toBe('available');
  });

  it('rejects an unavailable exposure claim when the receipt records an available allowlist', () => {
    const result = verifyRouterContextReceipt(envelopeWith(makeReceipt()), {
      ...VERIFY_ARGS,
      exposed: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run', evidenceRefs: ['trace:1', 'trace:2'] },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects an unavailable exposure whose reason drifted from the receipt', () => {
    const receipt = makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason: 'ledger_corrupt', nextAction: 'repair and re-run' } });
    const result = verifyRouterContextReceipt(envelopeWith(receipt), {
      ...VERIFY_ARGS,
      exposed: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run', evidenceRefs: ['trace:1', 'trace:2'] },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects an unavailable exposure whose nextAction drifted from the receipt', () => {
    const receipt = makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run' } });
    const result = verifyRouterContextReceipt(envelopeWith(receipt), {
      ...VERIFY_ARGS,
      exposed: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'a different next action', evidenceRefs: ['trace:1', 'trace:2'] },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('verifies evidenceRefs even when the exposure is unavailable', () => {
    const receipt = makeReceipt({ canonicalPrinciples: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run' } });
    const result = verifyRouterContextReceipt(envelopeWith(receipt), {
      ...VERIFY_ARGS,
      exposed: { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair and re-run', evidenceRefs: ['trace:1'] },
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('survives a serialize/deserialize round-trip (restart recovery)', () => {
    const roundTripped = JSON.parse(JSON.stringify(envelopeWith(makeReceipt())));
    expect(verifyRouterContextReceipt(roundTripped, VERIFY_ARGS).status).toBe('available');
  });
});

// ── Ledger adapter trusted exposure ───────────────────────────────────────────

describe('PrincipleTreeLedgerAdapter.readTrustedPrinciples', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trusted-context-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a proven empty exposure for a readable, empty ledger', () => {
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    expect(adapter.readTrustedPrinciples()).toEqual({ status: 'ok', principles: [] });
  });

  it('exposes only eligible principles (candidate/probation/active) in deterministic id order with verifiable digests', () => {
    addPrincipleToLedger(stateDir, makePrinciple('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'active', { version: 3, text: 'active one' }));
    addPrincipleToLedger(stateDir, makePrinciple('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'candidate', { text: 'candidate one' }));
    addPrincipleToLedger(stateDir, makePrinciple('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'archived', { text: 'archived out' }));
    addPrincipleToLedger(stateDir, makePrinciple('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'probation', { version: 2, text: 'probation one' }));
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const result = adapter.readTrustedPrinciples();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.principles.map((p) => p.principleId)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ]);
    for (const entry of result.principles) {
      expect(entry.contentDigest).toBe(computeTrustedPrincipleDigest(entry));
    }
  });

  it('returns typed unavailable for an unreadable ledger file', () => {
    // A raw JSON parse failure is 'unreadable' without the binding-corruption
    // flag, so the port maps it to ledger_unavailable — typed, never a guess.
    fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), '{ not json');
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    expect(adapter.readTrustedPrinciples()).toMatchObject({ status: 'unavailable', reason: 'ledger_unavailable' });
  });

  it('getCanonicalPrincipleEligibility mirrors the resolver target rule', () => {
    addPrincipleToLedger(stateDir, makePrinciple('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'active', { text: 'x' }));
    addPrincipleToLedger(stateDir, makePrinciple('ffffffff-ffff-4fff-8fff-ffffffffffff', 'archived', { text: 'y' }));
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    expect(adapter.getCanonicalPrincipleEligibility('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).toEqual({ eligible: true });
    expect(adapter.getCanonicalPrincipleEligibility('ffffffff-ffff-4fff-8fff-ffffffffffff')).toEqual({ eligible: false, reason: 'ineligible' });
    expect(adapter.getCanonicalPrincipleEligibility('00000000-0000-4000-8000-000000000000')).toEqual({ eligible: false, reason: 'missing' });
  });

  it('getCanonicalPrincipleEligibility classifies an unreadable ledger as ledger_unavailable, never missing', () => {
    fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), '{ not json');
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    expect(adapter.getCanonicalPrincipleEligibility('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
      .toEqual({ eligible: false, reason: 'ledger_unavailable' });
  });

  it('getCanonicalPrincipleEligibility classifies binding corruption as ledger_corrupt', () => {
    fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'),
      JSON.stringify({ tree: { principles: {}, ruleCandidateBindings: 'not-an-object' } }));
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    expect(adapter.getCanonicalPrincipleEligibility('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
      .toEqual({ eligible: false, reason: 'ledger_corrupt' });
  });
});
