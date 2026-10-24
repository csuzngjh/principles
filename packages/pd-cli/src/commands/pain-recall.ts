/**
 * pd pain recall command — SPEC-PD-PAIN-RECALL-CLI-001.
 *
 * On-demand, read-only recall of the historical pains that a principle
 * verifiably derives from. Parameter errors use the shared JSON error
 * envelope; domain outcomes (ok / no_matches / partial / *_not_found /
 * source_*) use the versioned pain-recall result contract with a non-zero
 * exit code only when the query could not be answered.
 *
 * Usage:
 *   pd pain recall --principle-id <id> [--pain-id <id>] [--context <text>] [--limit 1-10] [--json]
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  recallPains,
  PAIN_RECALL_DEFAULT_LIMIT,
  PAIN_RECALL_MIN_LIMIT,
  PAIN_RECALL_MAX_LIMIT,
  type PainRecallResult,
} from '../services/pain-recall.js';

export interface PainRecallOptions {
  principleId?: string;
  painId?: string;
  context?: string;
  limit?: number;
  workspace?: string;
  json?: boolean;
}

function fail(input: { message: string; reason: string; nextAction: string; json: boolean }): void {
  const { message, reason, nextAction, json } = input;
  if (json) {
    console.log(JSON.stringify({ status: 'failed', reason, message, nextAction }, null, 2));
  } else {
    console.error('Error: ' + message);
    console.error('Next: ' + nextAction);
  }
  process.exit(1);
}

/**
 * Strict --limit parser (SPEC §3.3): only a complete base-10 integer is
 * accepted; anything else becomes NaN so the handler's integer/range check
 * rejects it. Deliberately single-argument — Commander passes the previous
 * option value as the parser's second argument, which `parseInt` would
 * silently treat as a radix on repeated flags.
 */
export function parsePainRecallLimit(value: string): number {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function printHuman(result: PainRecallResult): void {
  const p = result.principle;
  console.log(`Principle:     ${p.canonicalId ?? p.requestedId} (${p.identityStatus})`);
  if (p.text) console.log(`Text:          ${p.text}`);
  console.log(`Status:        ${result.status}${result.statusDetail ? ` (${result.statusDetail})` : ''}`);
  console.log(`Sources:       ledger=${result.sources.ledger} trajectory=${result.sources.trajectoryDb} state=${result.sources.stateDb}`);
  console.log('─'.repeat(96));
  for (const entry of result.results) {
    console.log(`  ${entry.pain.occurredAt ?? '-'}  ${entry.pain.source ?? '-'}  host=${entry.pain.host}`);
    console.log(`    id: ${entry.painId} | association: ${entry.association.type} (${entry.association.confidence})`);
    if (entry.pain.reason) console.log(`    reason: ${entry.pain.reason}`);
    if (entry.pain.text) console.log(`    text:   ${entry.pain.text}`);
    for (const diagnosis of entry.diagnoses) {
      console.log(`    diagnosis: ${diagnosis.diagnosisId} [${diagnosis.category}] ${diagnosis.rootCause} (not an owner statement)`);
    }
    if (entry.correctionEvidence) {
      console.log(`    correction: ${entry.correctionEvidence.text}${entry.correctionEvidence.classification ? ` [${entry.correctionEvidence.classification}]` : ''}`);
    }
    console.log(`    availability: pain=${entry.availability.painEvent} diagnoses=${entry.availability.diagnoses} correction=${entry.availability.correctionEvidence}`);
  }
  console.log('─'.repeat(96));
  console.log(`Returned ${result.summary.returned} of ${result.summary.availableCandidates} associated pain(s)${result.summary.truncated ? ' (truncated)' : ''}.`);
  for (const item of result.unresolvedAssociations) {
    const who = item.painId !== undefined ? `pain ${item.painId}` : `candidate ${item.candidateId}`;
    console.error(`WARN: unresolved association: ${who}: ${item.reason}`);
  }
}

export async function handlePainRecall(opts: PainRecallOptions): Promise<void> {
  const json = opts.json === true;

  const principleId = typeof opts.principleId === 'string' ? opts.principleId.trim() : '';
  if (principleId.length === 0) {
    fail({
      message: '--principle-id <id> is required and must be a non-empty canonical ledger principle id',
      reason: 'principle_id_required',
      nextAction: 'Pass the principle\'s canonical ledger id (a UUID), e.g. pd pain recall --principle-id <uuid> --json.',
      json,
    });
    return; // guard: test stubs of process.exit continue execution
  }

  let limit = PAIN_RECALL_DEFAULT_LIMIT;
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < PAIN_RECALL_MIN_LIMIT || opts.limit > PAIN_RECALL_MAX_LIMIT) {
      fail({
        message: `invalid limit: limit must be an integer between ${PAIN_RECALL_MIN_LIMIT} and ${PAIN_RECALL_MAX_LIMIT}, got ${opts.limit}`,
        reason: 'invalid_limit',
        nextAction: `Pass --limit with a valid integer (${PAIN_RECALL_MIN_LIMIT}-${PAIN_RECALL_MAX_LIMIT}).`,
        json,
      });
      return; // guard: test stubs of process.exit continue execution
    }
    ({ limit } = opts);
  }

  let painId: string | undefined;
  if (opts.painId !== undefined) {
    const trimmed = typeof opts.painId === 'string' ? opts.painId.trim() : '';
    if (trimmed.length === 0) {
      fail({
        message: 'invalid pain id: --pain-id must be a non-empty pain id',
        reason: 'invalid_pain_id',
        nextAction: 'Pass a non-empty --pain-id or omit the flag.',
        json,
      });
      return; // guard: test stubs of process.exit continue execution
    }
    painId = trimmed;
  }

  let workspaceDir: string;
  try {
    workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  } catch (err: unknown) {
    // resolveWorkspaceDir throws when no workspace can be determined (no
    // --workspace, no PD_WORKSPACE_DIR, no config default, or an unparseable
    // config) — surface it through the standard envelope instead of letting a
    // raw exception escape --json mode (SPEC §4.4).
    fail({
      message: `workspace resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      reason: 'workspace_unresolved',
      nextAction: 'Pass --workspace <path>, set PD_WORKSPACE_DIR, or add workspace.default to .pd/config.yaml.',
      json,
    });
    return; // guard: test stubs of process.exit continue execution
  }

  let result: PainRecallResult;
  try {
    result = await recallPains(workspaceDir, {
      requestedPrincipleId: principleId,
      ...(painId !== undefined ? { painId } : {}),
      ...(typeof opts.context === 'string' && opts.context.trim().length > 0 ? { context: opts.context } : {}),
      limit,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    fail({
      message: `pain recall failed: ${message}`,
      reason: 'recall_failed',
      nextAction: 'Check the workspace state (pd health --json) and retry; this command never mutates state.',
      json,
    });
    return; // guard: test stubs of process.exit continue execution
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  // Domain failures that could not answer the query exit non-zero; ok /
  // no_matches / partial are successful reads (0).
  if (result.status !== 'ok' && result.status !== 'no_matches' && result.status !== 'partial') {
    process.exit(1);
  }
}
