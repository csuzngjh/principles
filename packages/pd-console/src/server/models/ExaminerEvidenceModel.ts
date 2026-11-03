/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §4/§5 — Examiner production-evidence read model.
 *
 * A pure DERIVED projection: composes the existing console models and the
 * host-runtime production projection into ONE per-principle evidence
 * aggregate for the Examiner Principle Evaluation page. It owns no storage,
 * writes nothing, and creates no second evidence truth (P4) — every fact is
 * read through the authority that already owns it:
 *
 *   ledger          PrinciplesConsoleModel (principle_training_state.json)
 *   activations     ActivationsConsoleModel (state.db activations + artifacts)
 *   prompt inject.  readPromptActivationInjectionStatuses (host-runtime,
 *                   built on the SAME production projection the runtime uses)
 *   receipts        ReceiptsConsoleModel (principle_applications + coverage)
 *   evidence audit  ReceiptsConsoleModel.getEvidenceAudit
 *                   (SqliteInterventionEvidenceStore.readAuditRelations)
 *
 * Honesty contract (SPEC §4.3/§5.5):
 *   - Projection / Submitted / Presence / Context Present / Runtime Loaded
 *     stay DISTINCT — nothing is promoted.
 *   - `agent_claimed` never becomes `runtime_verified`.
 *   - Unavailable evidence is reported as DEGRADED/UNAVAILABLE with reason
 *     and nextAction — empty data is never presented as "zero events".
 *   - RuleHost evidence is surfaced as its own lane; it is never counted as
 *     prompt-consumption evidence.
 */
import { readPromptActivationInjectionStatuses, type PromptActivationInjectionStatus } from '@principles/host-runtime';
import type { ReceiptEvidenceCoverage } from '@principles/core/runtime-v2';
import type { PromptInjectionRouteSummaryWire } from '../../shared/prompt-injection-contract.js';
import type { PrincipleReceipts } from './ReceiptsConsoleModel.js';
import { ReceiptsConsoleModel } from './ReceiptsConsoleModel.js';
import { PrinciplesConsoleModel, CorePrincipleNotGovernedError } from './PrinciplesConsoleModel.js';
import { ActivationsConsoleModel, type ActivationsResponse } from './ActivationsConsoleModel.js';

/** Bounded per-kind sample shown on the evaluation page (audit stays paged). */
const AUDIT_SAMPLE_LIMIT = 5;

export interface ExaminerEvidenceDeliverySample {
  evidenceId: string;
  recordedAt: string;
  sourceKind: string;
  confirmation: string;
  outcome: string;
  targetKind: string;
}

export interface ExaminerEvidenceApplicationSample {
  evidenceId: string;
  recordedAt: string;
  sourceKind: string;
  proofMethod: string;
  action: string;
}

export interface ExaminerEvidenceRecordSample {
  evidenceId: string;
  recordedAt: string;
  sourceKind: string;
  summary: string;
}

/** P1-3: per-kind pagination truth, passed through verbatim from the audit. */
export interface ExaminerEvidenceKindPage {
  hasMore: boolean;
  nextCursor: { recordedAt: string; evidenceId: string } | null;
}

export interface ExaminerEvidenceAuditProjection {
  status: 'ok' | 'degraded';
  reason?: string;
  nextAction?: string;
  /** P1-3: LOADED counts (the audit page window) — never presented as totals. */
  counts: { deliveries: number; applications: number; episodes: number; effects: number; outcomes: number };
  /** P1-3: pagination truth per kind — hasMore=true means MORE records exist. */
  pages: Record<'delivery' | 'application' | 'behavior_episode' | 'effect' | 'outcome', ExaminerEvidenceKindPage>;
  /** True when ANY kind reports hasMore — the UI shows a "more exist" band. */
  anyHasMore: boolean;
  /** Delivery confirmations observed in the audit window (never promoted). */
  deliveryConfirmations: { prepared: number; submitted: number; hostAccepted: number; contextPresent: number; runtimeLoaded: number };
  /** Application proof split — agent claims are NOT runtime verification. */
  applicationProof: { agentClaimed: number; runtimeVerified: number };
  unresolvedReferences: number;
  capabilityDeclarations: { hostKind: string; capability: string; status: string; maxConfirmation?: string; note?: string }[];
  samples: {
    deliveries: ExaminerEvidenceDeliverySample[];
    applications: ExaminerEvidenceApplicationSample[];
    episodes: ExaminerEvidenceRecordSample[];
    effects: ExaminerEvidenceRecordSample[];
    outcomes: ExaminerEvidenceRecordSample[];
  };
  asOf: string | null;
  coverage: ReceiptEvidenceCoverage | null;
}

export interface ExaminerPromptActivationRow {
  activationId: string;
  action: string;
  status: string;
  activatedAt: string | null;
  deactivatedAt: string | null;
  enforcement?: string;
  warning?: string;
}

export interface ExaminerRuleCodeRow {
  activationId: string;
  action: string;
  mode?: string;
  status: string;
  enforcement?: string;
  targetRef: string;
  warning?: string;
}

export interface ExaminerActivationProjection {
  status: 'ok' | 'degraded';
  reason?: string;
  nextAction?: string;
  prompt: ExaminerPromptActivationRow[];
  ruleCode: ExaminerRuleCodeRow[];
  promptInjectionRoute?: PromptInjectionRouteSummaryWire;
}

export interface ExaminerInjectionProjection {
  status: 'available' | 'degraded';
  /** Present when no status could be computed at all (fail-loud, rc-9). */
  globalReason?: string;
  statuses: {
    activationId: string;
    status: string;
    inCurrentWindow?: boolean;
    costChars?: number;
    budget?: number;
    route?: string;
    reason?: string;
  }[];
  budgetProvenance?: {
    capacitySource?: string;
    capacityStatus?: string;
    contextWindowTokens?: number;
    policyVersion?: string;
    fallbackReason?: string;
  };
  warnings: string[];
}

export interface ExaminerPrincipleEvidence {
  asOf: string;
  principleId: string;
  principle: {
    id: string;
    text: string;
    status: string;
    ruleCount: number;
    derivedFromPainIds: string[];
    evaluability: string;
    painPreventedCount: number;
    adherenceRate: number;
    valueScore: number;
    runtimeDeactivated?: boolean;
    /** Asset status ≠ runtime activation — pinned for the UI (SPEC §4.1). */
    ledgerStatusNote: string;
  };
  activation: ExaminerActivationProjection;
  injection: ExaminerInjectionProjection;
  receipts: PrincipleReceipts;
  evidenceAudit: ExaminerEvidenceAuditProjection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Bounded episode/effect/outcome sample summary from the payload (untrusted).
 * Shortened by CODE POINTS — a UTF-16 slice can split a surrogate pair and
 * render U+FFFD in the Owner-facing panel (EP-11).
 */
function recordSummary(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const candidate = payload.observationSummary ?? payload.actionSummary ?? payload.feedbackText ?? payload.resultSummary;
  const text = typeof candidate === 'string' ? candidate : '';
  const codePoints = Array.from(text);
  return codePoints.length > 160 ? `${codePoints.slice(0, 157).join('')}…` : text;
}

export class ExaminerEvidenceModel {
  constructor(private readonly workspaceDir: string) {}

  /**
   * One principle's full production-evidence aggregate. The caller has
   * already validated the principle id charset; a principle that is not in
   * the ledger returns null (route answers 404 — never a fabricated entry).
   */
  async getPrincipleEvidence(principleId: string): Promise<ExaminerPrincipleEvidence | null> {
    const asOf = new Date().toISOString();

    // 1. Ledger facts (the authoritative principle asset source).
    const principlesModel = new PrinciplesConsoleModel(this.workspaceDir);
    let detailOutput: Awaited<ReturnType<PrinciplesConsoleModel['getPrincipleDetail']>>;
    try {
      detailOutput = await principlesModel.getPrincipleDetail(principleId);
    } catch (error) {
      // Core principles are not workspace-governed objects: they have no
      // production-evidence aggregate here, so the route answers the same
      // 404 as any other principle absent from the workspace ledger.
      if (error instanceof CorePrincipleNotGovernedError) return null;
      throw error;
    }
    if (!detailOutput) return null;
    const detail = detailOutput.principle;

    // 2. Activation lifecycle rows (prompt + RuleCode lanes) — full reuse of
    //    the activations read model, filtered to this principle. A read error
    //    degrades the ACTIVATION lane only: the ledger facts below still
    //    answer, and the lane carries reason + nextAction (never "zero").
    const activationsModel = new ActivationsConsoleModel(this.workspaceDir);
    let activations: ActivationsResponse;
    try {
      activations = await activationsModel.getActivations();
    } catch (error) {
      activations = {
        activations: [],
        status: 'degraded',
        reason: `activation read failed: ${error instanceof Error ? error.message : String(error)}`,
        nextAction: 'check workspace .pd/state.db readability and the activation schema',
      };
    }
    const rows = activations.activations.filter((row) => row.principleId === principleId);
    const activation: ExaminerActivationProjection = {
      status: activations.status,
      reason: activations.reason,
      nextAction: activations.nextAction,
      promptInjectionRoute: activations.promptInjectionRoute,
      prompt: rows
        .filter((row) => row.channel === 'prompt')
        .map((row) => ({
          activationId: row.activationId,
          action: row.action,
          status: row.status,
          activatedAt: row.activatedAt,
          deactivatedAt: row.deactivatedAt,
          enforcement: row.enforcement,
          warning: row.warning,
        })),
      ruleCode: rows
        .filter((row) => row.channel === 'code_tool_hook')
        .map((row) => ({
          activationId: row.activationId,
          action: row.action,
          mode: row.mode,
          status: row.status,
          enforcement: row.enforcement,
          targetRef: row.targetRef,
          warning: row.warning,
        })),
    };

    // 3. Injection statuses from the SAME production projection the runtime
    //    uses (route + budget provenance + per-activation single-item facts).
    const injectionReport = await readPromptActivationInjectionStatuses({ workspaceDir: this.workspaceDir });
    const targetStatuses: PromptActivationInjectionStatus[] = injectionReport.statuses.filter((row) => row.principleId === principleId);
    const injection: ExaminerInjectionProjection = {
      status: injectionReport.globalReason ? 'degraded' : 'available',
      globalReason: injectionReport.globalReason,
      statuses: targetStatuses.map((row) => ({
        activationId: row.activationId,
        status: row.status,
        inCurrentWindow: row.inCurrentWindow,
        costChars: row.costChars,
        budget: row.budget,
        route: row.route,
        reason: row.reason,
      })),
      budgetProvenance: injectionReport.budgetProvenance
        ? {
            capacitySource: injectionReport.budgetProvenance.capacitySource,
            capacityStatus: injectionReport.budgetProvenance.capacityStatus,
            contextWindowTokens: injectionReport.budgetProvenance.contextWindowTokens,
            policyVersion: injectionReport.budgetProvenance.policyVersion,
            fallbackReason: injectionReport.budgetProvenance.fallbackReason,
          }
        : undefined,
      warnings: injectionReport.warnings.slice(0, 20),
    };

    // 4. Receipts + 5. evidence audit through the existing receipts model.
    const receiptsModel = new ReceiptsConsoleModel(this.workspaceDir);
    const receipts = await receiptsModel.getPrincipleReceipts(principleId);
    const audit = await receiptsModel.getEvidenceAudit({ type: 'principle', principleId });

    const deliveryConfirmations = { prepared: 0, submitted: 0, hostAccepted: 0, contextPresent: 0, runtimeLoaded: 0 };
    for (const record of audit.deliveries) {
      const confirmation = stringOrUndefined(isRecord(record.payload) ? record.payload.confirmation : undefined);
      if (confirmation === 'prepared') deliveryConfirmations.prepared += 1;
      else if (confirmation === 'submitted') deliveryConfirmations.submitted += 1;
      else if (confirmation === 'host_accepted') deliveryConfirmations.hostAccepted += 1;
      else if (confirmation === 'context_present') deliveryConfirmations.contextPresent += 1;
      else if (confirmation === 'runtime_loaded') deliveryConfirmations.runtimeLoaded += 1;
    }
    const applicationProof = { agentClaimed: 0, runtimeVerified: 0 };
    for (const record of audit.applications) {
      const proof = stringOrUndefined(isRecord(record.payload) ? record.payload.proofMethod : undefined);
      if (proof === 'runtime_verified') applicationProof.runtimeVerified += 1;
      else if (proof === 'agent_claimed') applicationProof.agentClaimed += 1;
    }

    // P1-3: pagination truth rides through verbatim — the counts above are
    // LOADED-window sizes, and hasMore per kind tells the Owner more records
    // exist beyond this read.
    const pages = {
      delivery: { hasMore: audit.pages.delivery.hasMore, nextCursor: audit.pages.delivery.nextCursor },
      application: { hasMore: audit.pages.application.hasMore, nextCursor: audit.pages.application.nextCursor },
      behavior_episode: { hasMore: audit.pages.behavior_episode.hasMore, nextCursor: audit.pages.behavior_episode.nextCursor },
      effect: { hasMore: audit.pages.effect.hasMore, nextCursor: audit.pages.effect.nextCursor },
      outcome: { hasMore: audit.pages.outcome.hasMore, nextCursor: audit.pages.outcome.nextCursor },
    };
    const anyHasMore = Object.values(pages).some((page) => page.hasMore);
    const evidenceAudit: ExaminerEvidenceAuditProjection = {
      status: audit.status,
      reason: audit.reason,
      nextAction: audit.nextAction,
      counts: {
        deliveries: audit.deliveries.length,
        applications: audit.applications.length,
        episodes: audit.episodes.length,
        effects: audit.effects.length,
        outcomes: audit.outcomes.length,
      },
      pages,
      anyHasMore,
      deliveryConfirmations,
      applicationProof,
      unresolvedReferences: audit.unresolvedReferences.length,
      capabilityDeclarations: audit.capabilityDeclarations.slice(0, 12).map((declaration) => ({
        hostKind: String(declaration.hostKind),
        capability: String(declaration.capability),
        status: String(declaration.status),
        maxConfirmation: stringOrUndefined(declaration.maxConfirmation),
        note: stringOrUndefined(declaration.note),
      })),
      samples: {
        deliveries: audit.deliveries.slice(0, AUDIT_SAMPLE_LIMIT).map((record) => ({
          evidenceId: record.evidenceId,
          recordedAt: record.recordedAt,
          sourceKind: String(record.sourceKind),
          confirmation: stringOrUndefined(isRecord(record.payload) ? record.payload.confirmation : undefined) ?? 'unknown',
          outcome: stringOrUndefined(isRecord(record.payload) ? record.payload.outcome : undefined) ?? 'unknown',
          targetKind: stringOrUndefined(isRecord(record.payload) ? record.payload.targetKind : undefined) ?? 'unknown',
        })),
        applications: audit.applications.slice(0, AUDIT_SAMPLE_LIMIT).map((record) => ({
          evidenceId: record.evidenceId,
          recordedAt: record.recordedAt,
          sourceKind: String(record.sourceKind),
          proofMethod: stringOrUndefined(isRecord(record.payload) ? record.payload.proofMethod : undefined) ?? 'unknown',
          action: stringOrUndefined(isRecord(record.payload) ? record.payload.action : undefined) ?? 'unknown',
        })),
        episodes: audit.episodes.slice(0, AUDIT_SAMPLE_LIMIT).map((record) => ({
          evidenceId: record.evidenceId,
          recordedAt: record.recordedAt,
          sourceKind: String(record.sourceKind),
          summary: recordSummary(record.payload),
        })),
        effects: audit.effects.slice(0, AUDIT_SAMPLE_LIMIT).map((record) => ({
          evidenceId: record.evidenceId,
          recordedAt: record.recordedAt,
          sourceKind: String(record.sourceKind),
          summary: recordSummary(record.payload),
        })),
        outcomes: audit.outcomes.slice(0, AUDIT_SAMPLE_LIMIT).map((record) => ({
          evidenceId: record.evidenceId,
          recordedAt: record.recordedAt,
          sourceKind: String(record.sourceKind),
          summary: recordSummary(record.payload),
        })),
      },
      asOf: audit.asOf,
      coverage: audit.coverage ?? null,
    };

    return {
      asOf,
      principleId,
      principle: {
        id: detail.id,
        text: detail.text,
        status: detail.status,
        ruleCount: detail.ruleCount,
        derivedFromPainIds: detail.derivedFromPainIds,
        evaluability: detail.evaluability,
        painPreventedCount: detail.painPreventedCount,
        adherenceRate: detail.adherenceRate,
        valueScore: detail.valueScore,
        runtimeDeactivated: detail.runtimeDeactivated,
        ledgerStatusNote: 'ledger status is the ASSET lifecycle — it is not runtime activation; the runtime rows below are the activation truth',
      },
      activation,
      injection,
      receipts,
      evidenceAudit,
    };
  }
}
