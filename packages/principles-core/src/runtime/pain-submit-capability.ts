/**
 * Pain submit capability — the single Core entry point behind the
 * `pd_submit_pain` MCP tool (SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §5).
 *
 * Responsibilities, in order:
 *  1. validate the submission anchor against the live principle ledger;
 *  2. build the ONE legal MCP ingress report (`owner_manual` +
 *     `mcp_agent_assisted`, unbound, no host evidence) and run the SHARED
 *     `evaluatePainIngress()` gate — no second admission path;
 *  3. persist through `PainToPrincipleService.recordPain()` in async mode;
 *  4. return a receipt that never claims more than it can prove.
 *
 * Identity is NOT generated here: the MCP handler generates `painId` before
 * calling (so a timed-out write can still be reconciled) and `taskId` is
 * deterministically derived from it. Missing identity is an illegal call and
 * fails closed (§3.2, §5.7).
 */

import { PainToPrincipleService, type PainToPrincipleServiceOptions } from './pain-to-principle-service.js';
import { PrincipleTreeLedgerAdapter } from './adapter/principle-tree-ledger-adapter.js';
import { disposePainSignalBridgesForWorkspace } from './pain-signal-runtime-factory.js';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import { readLedgerFileState } from '../principle-tree-ledger.js';
import {
  createDiagnosticianTaskId,
} from './pain-signal-bridge.js';
import { evaluatePainIngress } from './pain-ingress.js';
import {
  parsePainIngressReport,
  type PainIngressReport,
  type PainDeviationAnchor,
} from './pain-ingress-payload.js';
import { deriveProvenanceFromIngressFacts } from './pain-ingress-payload.js';
import type { GovernanceHostKind } from './pain-signal-bridge.js';
import type { PainAnchor, PainAnchorType } from './context-payload.js';

export const SUBMIT_PAIN_CAPABILITY_ID = 'pd_submit_pain' as const;
export const SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION = 'pd.pain-submit-receipt.v1' as const;

export type PainSubmitAnchorType = PainAnchorType;

export type PainSubmitPainType =
  | 'principle_deviation'
  | 'tool_failure'
  | 'subagent_error'
  | 'user_frustration';

/** What the MCP handler passes after schema validation. Never contains
 * `score`, `severity`, `approved`, `sessionId` or paths (§5.3/§5.5). */
export interface PainSubmitInput {
  readonly reason: string;
  readonly anchorType: PainSubmitAnchorType;
  readonly anchorRef: string;
  readonly painType?: PainSubmitPainType;
}

export interface PainSubmitCapabilityOptions {
  /** Startup-bound workspace. Never taken from model input (§5.1). */
  readonly workspaceDir: string;
  /** Startup-bound state directory (`<workspace>/.state`) that owns the
   * principle ledger. Passed in so this capability performs no path I/O. */
  readonly stateDir: string;
  /** Handler-generated identity (format `mcp_<epoch_ms>_<8-hex>`). */
  readonly painId: string;
  /** Deterministic `createDiagnosticianTaskId(painId)`; may be omitted and
   * re-derived, but a mismatching value fails closed. */
  readonly taskId?: string;
  /** Observability only — never used for admission or mode (§6.6.3). */
  readonly hostKind?: GovernanceHostKind;
  /** Workspace-effective config loaded at MCP startup (same authority the CLI
   * uses). Without it the async submission can only be created if the state
   * directory already carries a resolvable runtime config. */
  readonly effectiveConfig?: PainToPrincipleServiceOptions['effectiveConfig'];
  readonly getEnvVar?: (name: string) => string | undefined;
  /** Test/DI seam: overrides the service factory. Production leaves it unset. */
  readonly serviceFactory?: (deps: {
    workspaceDir: string;
    stateDir: string;
    ledgerAdapter: PrincipleTreeLedgerAdapter;
  }) => Pick<PainToPrincipleService, 'recordPain'>;
}

export type PainSubmitStatus =
  | 'submitted'
  /** Write began but its outcome could not be confirmed (§5.7). */
  | 'submit_unconfirmed'
  | 'refused'
  | 'failed';

export interface PainSubmitError {
  readonly code: string;
  readonly message: string;
}

export interface PainSubmitReceipt {
  readonly schemaVersion: typeof SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION;
  readonly capability: typeof SUBMIT_PAIN_CAPABILITY_ID;
  readonly status: PainSubmitStatus;
  readonly painId: string | null;
  readonly taskId: string | null;
  readonly workspaceDir: string;
  /** v1 never returns `mode` — the MCP process cannot prove a consumer is
   * alive (§5.4.2). The field stays for a future honest signal. */
  readonly diagnosis: { readonly status: 'pending'; readonly mode?: 'auto' | 'manual' } | null;
  readonly anchor: { readonly type: PainSubmitAnchorType; readonly ref: string } | null;
  readonly provenance: string | null;
  readonly warnings: readonly string[];
  readonly error: PainSubmitError | null;
  readonly nextAction: string | null;
}

export interface AnchorValidationResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly nextAction?: string;
  readonly warnings?: string[];
}

const ANCHOR_ID_PATTERN = /^(?<id>[^@\s]+)@(?<version>\d+)$/u;
const ANCHOR_INSTRUCTION_PATTERN = /^[^#\s]+#\S+$/u;

/**
 * §5.6.1 — the server can only prove existence, version and status. Scope
 * applicability and priority arbitration are NOT checkable here and must be
 * disclosed by the agent inside `reason`.
 */
export function validateSubmissionAnchor(input: {
  stateDir: string;
  anchorType: PainSubmitAnchorType;
  anchorRef: string;
}): AnchorValidationResult {
  const { stateDir, anchorType, anchorRef } = input;

  if (anchorType === 'agent_instruction') {
    if (!ANCHOR_INSTRUCTION_PATTERN.test(anchorRef)) {
      return {
        ok: false,
        code: 'anchor_invalid',
        message: 'agent_instruction anchorRef must look like <path>#<section>',
        nextAction: 'Provide the Instructions path and section, or use owner_expectation.',
      };
    }
    return { ok: true };
  }
  if (anchorType === 'owner_expectation') {
    // Non-empty is already guaranteed by the schema; nothing else is
    // machine-checkable about a conversation quote.
    if (anchorRef.trim().length === 0) {
      return {
        ok: false,
        code: 'anchor_invalid',
        message: 'owner_expectation anchorRef must name where the Owner said it in this conversation',
        nextAction: 'Quote the Owner statement with its location, or do not submit.',
      };
    }
    return { ok: true };
  }

  const match = ANCHOR_ID_PATTERN.exec(anchorRef);
  const principleId = match?.groups?.id;
  const principleVersion = match?.groups?.version;
  if (principleId === undefined || principleVersion === undefined) {
    return {
      ok: false,
      code: 'anchor_invalid',
      message: 'established_principle anchorRef must look like <principleId>@<version>',
      nextAction: 'Use <principleId>@<version> from the workspace ledger (`.state/principle_training_state.json`).',
    };
  }

  const { ledger, availability } = readLedgerFileState(stateDir);
  if (availability.status === 'unreadable') {
    return {
      ok: false,
      code: 'anchor_unverifiable',
      message: `The principle ledger could not be read (${availability.problem}); the anchor cannot be verified.`,
      nextAction: 'Repair the ledger (`.state/principle_training_state.json`) and retry; do not resubmit as a different anchor type.',
    };
  }
  if (availability.status === 'empty') {
    return {
      ok: false,
      code: 'anchor_not_found',
      message: `Principle ${principleId} was not found because the ledger is empty.`,
      nextAction: 'The workspace ledger is empty; use owner_expectation or agent_instruction instead.',
    };
  }

  const {principles} = ledger.tree;
  if (!Object.hasOwn(principles, principleId)) {
    return {
      ok: false,
      code: 'anchor_not_found',
      message: `Principle ${principleId} is not present in the workspace ledger.`,
      nextAction: 'Use an id from the workspace ledger (`.state/principle_training_state.json`), or use owner_expectation / agent_instruction.',
    };
  }
  const principle = principles[principleId];
  if (principle === undefined) {
    return {
      ok: false,
      code: 'anchor_not_found',
      message: `Principle ${principleId} is not present in the workspace ledger.`,
      nextAction: 'Use an id from the workspace ledger (`.state/principle_training_state.json`), or use owner_expectation / agent_instruction.',
    };
  }
  if (String(principle.version) !== principleVersion) {
    return {
      ok: false,
      code: 'anchor_not_found',
      message: `Principle ${principleId} exists at version ${String(principle.version)}, not ${principleVersion}.`,
      nextAction: 'Use the current version reported by `pd principle list`.',
    };
  }
  if (principle.status !== 'active' && principle.status !== 'probation') {
    return {
      ok: false,
      code: 'anchor_not_currently_valid',
      message: `Principle ${principleId} is '${principle.status}' and cannot serve as the basis of a current deviation (only active/probation can).`,
      nextAction: 'Use owner_expectation or agent_instruction for this submission; a candidate/archived/deprecated principle is background only.',
    };
  }

  const warnings = principle.status === 'probation'
    ? [`anchor_probation: principle ${principleId} is on probation — the deviation is valid, but the principle is still being validated.`]
    : [];
  return { ok: true, warnings };
}

function isIngressReport(
  value: PainIngressReport | { error: string; message: string },
): value is PainIngressReport {
  return Object.hasOwn(value, 'painType');
}

/** The single legal MCP ingress report (§6.6.3). */
export function buildMcpIngressReport(input: {
  painId: string;
  input: PainSubmitInput;
  anchor: PainDeviationAnchor | undefined;
}): PainIngressReport | { error: string; message: string } {
  const parsed = parsePainIngressReport({
    identity: { kind: 'manual_pain_id', painId: input.painId },
    painType: input.input.painType ?? 'principle_deviation',
    source: 'mcp_agent_assisted',
    reason: input.input.reason,
    origin: { kind: 'owner_manual', channel: 'mcp_agent_assisted' },
    correlation: { status: 'unbound', reason: 'missing_host_session' },
    evidence: { status: 'unavailable', reason: 'not_applicable_unbound' },
    ...(input.anchor ? { deviationAnchor: input.anchor } : {}),
  });
  if (!parsed.ok) {
    return { error: parsed.reasonCode, message: parsed.message };
  }
  return parsed.report;
}

interface RefusalInput {
  options: PainSubmitCapabilityOptions;
  code: string;
  message: string;
  nextAction: string;
}

/** Deterministic task id for a handler-generated pain id (§5.5 step 5). The
 * MCP handler calls this BEFORE the write so a timed-out submission can be
 * reconciled by id (§5.7). */
export function deriveSubmitTaskId(painId: string): string {
  return createDiagnosticianTaskId(painId);
}

/** Receipt for a call rejected before any write (schema/anchor/admission).
 * Identity is known because the handler generated it first. */
export function buildRefusedSubmitReceipt(input: {
  painId: string | null;
  taskId: string | null;
  workspaceDir: string;
  code: string;
  message: string;
  nextAction: string;
}): PainSubmitReceipt {
  return {
    schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
    capability: SUBMIT_PAIN_CAPABILITY_ID,
    status: 'refused',
    painId: input.painId,
    taskId: input.taskId,
    workspaceDir: input.workspaceDir,
    diagnosis: null,
    anchor: null,
    provenance: null,
    warnings: [],
    error: { code: input.code, message: input.message },
    nextAction: input.nextAction,
  };
}

function refused(input: RefusalInput): PainSubmitReceipt {
  return buildRefusedSubmitReceipt({
    painId: input.options.painId || null,
    taskId: input.options.taskId ?? null,
    workspaceDir: input.options.workspaceDir,
    code: input.code,
    message: input.message,
    nextAction: input.nextAction,
  });
}

/** Receipt for "the write began and its outcome is unknown" (§5.7). It never
 * claims the task exists and never claims it does not. */
export function buildUnconfirmedSubmitReceipt(input: {
  painId: string;
  taskId: string;
  workspaceDir: string;
  message: string;
}): PainSubmitReceipt {
  return {
    schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
    capability: SUBMIT_PAIN_CAPABILITY_ID,
    status: 'submit_unconfirmed',
    painId: input.painId,
    taskId: input.taskId,
    workspaceDir: input.workspaceDir,
    diagnosis: { status: 'pending' },
    anchor: null,
    provenance: null,
    warnings: [],
    error: { code: 'submit_unconfirmed', message: input.message },
    nextAction: `Run \`pd task show ${input.taskId}\` to reconcile; do not resubmit blindly.`,
  };
}

export type SubmittedTaskRecheck = 'found' | 'not_found' | 'unreadable';

/** Minimal `submitted` receipt for a write that outlived the deadline but was
 * confirmed by the bounded read-back (§5.7). It reports only the task row. */
export function buildReconciledSubmitReceipt(input: {
  painId: string;
  taskId: string;
  workspaceDir: string;
}): PainSubmitReceipt {
  return {
    schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
    capability: SUBMIT_PAIN_CAPABILITY_ID,
    status: 'submitted',
    painId: input.painId,
    taskId: input.taskId,
    workspaceDir: input.workspaceDir,
    diagnosis: { status: 'pending' },
    anchor: null,
    provenance: null,
    warnings: [
      'reconciled_after_timeout: the write outlived the deadline; the task row was confirmed by a bounded read-back (diagnosis not yet run).',
    ],
    error: null,
    nextAction: `Run \`pd task show ${input.taskId}\` to follow the diagnosis.`,
  };
}

/**
 * §5.7 bounded read-back: does the task produced by THIS `painId` exist?
 *
 * Read-only, no bootstrap (a missing state.db must not be created by a
 * recheck). Only an exact `input_ref === painId` hit counts as "found": a task
 * under the same id but a different pain would be foreign state, and claiming
 * it would be a false success. `unreadable` is "outcome unknown", never
 * "not created" (rc-9).
 */
export async function recheckSubmittedTask(options: {
  workspaceDir: string;
  painId: string;
  taskId: string;
}): Promise<SubmittedTaskRecheck> {
  let manager: RuntimeStateManager | undefined;
  try {
    manager = new RuntimeStateManager({
      workspaceDir: options.workspaceDir,
      readonly: true,
      bootstrapIfMissing: false,
    });
    await manager.initialize();
    const task = await manager.getTask(options.taskId);
    if (task === null) return 'not_found';
    return task.inputRef === options.painId ? 'found' : 'not_found';
  } catch {
    return 'unreadable';
  } finally {
    if (manager !== undefined) {
      try {
        await manager.close();
      } catch {
        /* best-effort: a close failure cannot change the observed outcome */
      }
    }
  }
}


/**
 * Submit one pain. Never throws: every failure is a structured receipt so the
 * MCP handler can map it onto `isError` without guessing.
 */
export async function submitPainCapability(
  options: PainSubmitCapabilityOptions,
  input: PainSubmitInput,
): Promise<PainSubmitReceipt> {
  // §3.2 / §5.7: identity is the handler's, and missing identity is an
  // illegal call — fail closed before any write.
  if (typeof options.painId !== 'string' || options.painId.trim().length === 0) {
    return refused({
      options,
      code: 'invalid_call',
      message: 'painId is required: it must be generated by the MCP handler before the write.',
      nextAction: 'Call the tool again through the MCP server; do not call the capability directly.',
    });
  }
  const expectedTaskId = createDiagnosticianTaskId(options.painId);
  if (options.taskId !== undefined && options.taskId !== expectedTaskId) {
    return refused({
      options,
      code: 'invalid_call',
      message: `taskId '${options.taskId}' does not match the deterministic id for painId '${options.painId}' (${expectedTaskId}).`,
      nextAction: 'Call the tool again through the MCP server; identity must not be overridden.',
    });
  }

  const { stateDir } = options;

  const anchorCheck = validateSubmissionAnchor({
    stateDir,
    anchorType: input.anchorType,
    anchorRef: input.anchorRef,
  });
  if (!anchorCheck.ok) {
    return refused({
      options,
      code: anchorCheck.code ?? 'anchor_invalid',
      message: anchorCheck.message ?? 'The anchor could not be validated.',
      nextAction: anchorCheck.nextAction ?? 'Use owner_expectation or agent_instruction, or fix the anchor reference.',
    });
  }

  // §6.2/§11: every anchor source lands in diagnostic_json as {type, ref};
  // deviationAnchor remains the verified principle shortcut for
  // `established_principle` only.
  const anchorMatch = ANCHOR_ID_PATTERN.exec(input.anchorRef);
  const anchorId = anchorMatch?.groups?.id;
  const anchorVersion = anchorMatch?.groups?.version;
  const deviationAnchor: PainDeviationAnchor | undefined = input.anchorType === 'established_principle'
    && anchorId !== undefined && anchorVersion !== undefined
    ? { principleId: anchorId, principleVersion: anchorVersion }
    : undefined;
  const structuredAnchor: PainAnchor = { type: input.anchorType, ref: input.anchorRef };

  const report = buildMcpIngressReport({
    painId: options.painId,
    input,
    anchor: deviationAnchor,
  });
  if (!isIngressReport(report)) {
    return refused({
      options,
      code: report.error,
      message: report.message,
      nextAction: 'Fix the submission content and retry; nothing was written.',
    });
  }

  const decided = evaluatePainIngress(report);
  if (decided.action !== 'submit') {
    const code = decided.action === 'refuse' ? decided.reasonCode : `ingress_${decided.action}`;
    const message = decided.action === 'refuse' ? decided.warning : `Ingress decision was '${decided.action}', not 'submit'.`;
    const nextAction = decided.action === 'refuse' ? decided.nextAction : 'Retry with a complete, verifiable anchor.';
    return refused({ options, code, message, nextAction });
  }
  const decision = decided;

  const provenance = deriveProvenanceFromIngressFacts(
    decision.painIngress.origin,
    decision.painIngress.correlation,
  );

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  const service = options.serviceFactory
    ? options.serviceFactory({ workspaceDir: options.workspaceDir, stateDir, ledgerAdapter })
    : new PainToPrincipleService({
      workspaceDir: options.workspaceDir,
      stateDir,
      ledgerAdapter,
      owner: 'pd-mcp-server',
      autoIntakeEnabled: false,
      asyncMode: true,
      ...(options.effectiveConfig ? { effectiveConfig: options.effectiveConfig } : {}),
      ...(options.getEnvVar ? { getEnvVar: options.getEnvVar } : {}),
    });

  try {
    const result = await service.recordPain({
      painId: options.painId,
      painType: report.painType,
      source: report.source,
      reason: report.reason,
      taskId: expectedTaskId,
      provenance,
      painIngress: decision.painIngress,
      // §6.7: keep observability ON so Console and Recall see this pain.
      recordObservability: true,
      ...(deviationAnchor ? { deviationAnchor } : {}),
      anchor: structuredAnchor,
      ...(options.hostKind ? { hostKind: options.hostKind } : {}),
    });
    // PRI-624 precedent: a process that only submits must not pin the
    // workspace SQLite file. Disposal is best-effort; the durable fact is
    // already written, so a cleanup failure cannot change the receipt.
    await disposePainSignalBridgesForWorkspace(options.workspaceDir);

    if (result.status === 'failed') {
      // §5.7 / T06: a duplicate is an idempotency outcome the Owner can
      // distinguish from a real write failure — never collapse them.
      const duplicate = /UNIQUE constraint failed|already exists|duplicate/i.test(result.message ?? '');
      if (duplicate) {
        return {
          schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
          capability: SUBMIT_PAIN_CAPABILITY_ID,
          status: 'refused',
          painId: options.painId,
          taskId: expectedTaskId,
          workspaceDir: options.workspaceDir,
          diagnosis: { status: 'pending' },
          anchor: { type: input.anchorType, ref: input.anchorRef },
          provenance,
          warnings: [],
          error: {
            code: 'task_duplicate',
            message: `A diagnosis task already exists for painId '${options.painId}'; nothing was duplicated.`,
          },
          nextAction: `Run \`pd task show ${expectedTaskId}\` to follow the existing diagnosis.`,
        };
      }
      return {
        schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
        capability: SUBMIT_PAIN_CAPABILITY_ID,
        status: 'failed',
        painId: options.painId,
        taskId: result.taskId ?? expectedTaskId,
        workspaceDir: options.workspaceDir,
        diagnosis: null,
        anchor: { type: input.anchorType, ref: input.anchorRef },
        provenance,
        warnings: result.observabilityWarnings ?? [],
        error: {
          code: result.failureCategory ?? 'write_failed',
          message: result.message ?? 'The pain task could not be created.',
        },
        nextAction: result.nextAction ?? `Run \`pd task show ${expectedTaskId}\` to check whether a task exists.`,
      };
    }

    const warnings = [...(decision.warnings ?? []), ...(anchorCheck.warnings ?? [])];
    return {
      schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
      capability: SUBMIT_PAIN_CAPABILITY_ID,
      status: 'submitted',
      painId: options.painId,
      // §5.7: the identity the handler generated BEFORE the write is the
      // receipt identity; a different id from the service is a contract
      // violation, not something to silently reconcile.
      taskId: expectedTaskId,
      workspaceDir: options.workspaceDir,
      diagnosis: { status: 'pending' },
      anchor: { type: input.anchorType, ref: input.anchorRef },
      provenance,
      warnings,
      error: null,
      nextAction: result.nextAction ?? null,
    };
  } catch (err: unknown) {
    // §9: an exception is "outcome unknown", never "not created".
    return {
      schemaVersion: SUBMIT_PAIN_RECEIPT_SCHEMA_VERSION,
      capability: SUBMIT_PAIN_CAPABILITY_ID,
      status: 'submit_unconfirmed',
      painId: options.painId,
      taskId: expectedTaskId,
      workspaceDir: options.workspaceDir,
      diagnosis: { status: 'pending' },
      anchor: { type: input.anchorType, ref: input.anchorRef },
      provenance,
      warnings: [],
      error: {
        code: 'submit_unconfirmed',
        message: `The submission outcome is unknown: ${err instanceof Error ? err.message : String(err)}`,
      },
      nextAction: `Run \`pd task show ${expectedTaskId}\` to reconcile; do not resubmit blindly.`,
    };
  }
}
