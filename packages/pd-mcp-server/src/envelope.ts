/**
 * Tool result envelope assembly — SPEC-PD-MCP-GATE4-001 §4.6/§4.8, obeying
 * Gate 3 v0.5 §10.1.
 *
 * `isError: true` is used for exactly two families (§4.8):
 *   1. disclosure assertion failure (the withheld capability shell already
 *      says `unavailable` + `disclosure_assertion_failed`);
 *   2. Adapter execution failure — response_budget_exceeded,
 *      tool_execution_failed (unexpected exception / 10 s deadline /
 *      shutting down / saturated by orphaned timed-out calls).
 * Ordinary business states (ok / no_matches / partial / not_found / plain
 * unavailable / invalid_input) return the capability envelope verbatim with
 * no isError marker.
 *
 * Adapter failure envelopes reuse the capability shell shape so the Agent
 * always sees one `pd.capability.v1` JSON document. Messages carry a stable
 * code + next action; they never contain stacks, paths, env values or raw
 * business text (§4.8: no internal details to the Agent).
 */
import {
  CAPABILITY_SCHEMA_VERSION,
  OD_A_DISCLOSURE_PROFILE,
  RECALL_PAIN_CAPABILITY_ID,
  type PainRecallCapabilityResult,
} from '@principles/core/runtime/pain-recall-capability';
import type { PainSubmitReceipt } from '@principles/core/runtime/pain-submit-capability';
import { RESPONSE_BUDGET_BYTES, withinBudget } from './budget.js';

/** MCP tool result as produced by the handler (single text content block,
 * `structuredContent` intentionally never used — §4.6). The shapes match the
 * SDK's expected result type (mutable content array + index signature). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [extra: string]: unknown;
}

export function textResult(text: string, isError?: boolean): ToolResult {
  return isError === undefined
    ? { content: [{ type: 'text' as const, text }] }
    : { content: [{ type: 'text' as const, text }], isError };
}

/** Adapter failure envelope in the capability shell shape (§7.2 null form). */
export function adapterFailureEnvelope(code: string, message: string): PainRecallCapabilityResult {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capability: RECALL_PAIN_CAPABILITY_ID,
    disclosureProfile: OD_A_DISCLOSURE_PROFILE,
    status: 'unavailable',
    data: null,
    provenance: { workspaceBinding: 'configured', sources: [] },
    warnings: [],
    error: { code, message },
    nextAction: {
      code: 'retry_or_report',
      message: 'If this repeats, run the PD host health check (pd health) and include the MCP stage in the report.',
    },
  };
}

/** §4.8 — does this capability envelope require `isError: true`?
 * Only the disclosure assertion failure (the capability withheld its
 * payload); every ordinary business status stays a normal result. */
export function requiresIsError(envelope: PainRecallCapabilityResult): boolean {
  return envelope.status === 'unavailable' && envelope.error?.code === 'disclosure_assertion_failed';
}

/**
 * Assemble the final tool result from a capability envelope.
 *
 * Order: serialize → budget check → emit. Over budget returns
 * `response_budget_exceeded` (Adapter execution failure, isError: true).
 * The failure envelope is asserted to fit the budget itself (§4.6).
 */
export function assembleResult(envelope: PainRecallCapabilityResult):
  { ok: true; result: ToolResult }
  | { ok: false; overBudgetBytes: number } {
  const json = JSON.stringify(envelope);
  if (withinBudget(json)) {
    return { ok: true, result: textResult(json, requiresIsError(envelope) ? true : undefined) };
  }
  return { ok: false, overBudgetBytes: Buffer.byteLength(json, 'utf8') };
}

/**
 * §5.4.3 — assemble a `pd_submit_pain` receipt under the transport budget.
 *
 * Unlike the read tool, an over-budget receipt must never be replaced by a
 * generic failure: the write may have happened. The order is
 * full receipt → minimal receipt (same fields, observability dropped) →
 * explicit statement carrying `taskId`. Only when even "written + taskId"
 * cannot be expressed is `isError: true` allowed — and that message says the
 * outcome is UNKNOWN, never "not created".
 */
export function assembleSubmitResult(
  receipt: PainSubmitReceipt,
  budgetBytes: number = RESPONSE_BUDGET_BYTES
): { result: ToolResult; degraded: 'none' | 'minimal' | 'untransportable' } {
  const isError = receipt.status === 'failed' ? true : undefined;

  const full = JSON.stringify(receipt);
  if (withinBudget(full, budgetBytes)) {
    return { result: textResult(full, isError), degraded: 'none' };
  }

  const minimal = JSON.stringify({
    status: receipt.status,
    painId: receipt.painId,
    taskId: receipt.taskId,
    workspaceDir: receipt.workspaceDir,
    diagnosis: receipt.diagnosis,
  });
  if (withinBudget(minimal, budgetBytes)) {
    return { result: textResult(minimal, isError), degraded: 'minimal' };
  }

  const taskId = receipt.taskId ?? 'unknown';
  const statement =
    receipt.status === 'submitted' || receipt.status === 'submit_unconfirmed'
      ? `Submission status is '${receipt.status}'; taskId is '${taskId}'. The full receipt exceeded the transport budget. Reconcile with \`pd task show ${taskId}\` before any retry.`
      : `Submission status is '${receipt.status}'; taskId is '${taskId}'. The full receipt exceeded the transport budget.`;
  if (withinBudget(statement, budgetBytes)) {
    return { result: textResult(statement), degraded: 'untransportable' };
  }

  return {
    result: textResult(
      JSON.stringify({
        status: 'unavailable',
        error: {
          code: 'response_budget_exceeded',
          message:
            'The receipt could not be expressed within the transport budget; the write outcome is UNKNOWN (it may already have been written). Reconcile before retrying.',
        },
        nextAction: {
          code: 'reconcile',
          message: `Run \`pd task list --kind diagnostician\` and \`pd task show ${taskId}\` before any retry.`,
        },
      }),
      true
    ),
    degraded: 'untransportable',
  };
}
