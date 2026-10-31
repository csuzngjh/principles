import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { DailyThoughtCard } from "../../components/focus/daily-thought-card.js";
import { ShinyText } from "../../components/ui/shiny-text.js";
import {
  fetchGovernanceQueue,
  fetchApprovalsGrouped,
  fetchAllActivations,
  fetchOwnerDecisions,
  fetchRuleBindingQueue,
} from "../../api.js";
import type {
  GovernanceQueueData,
  ApprovalsGroupedData,
  StagnationSignal,
  DegradedSignal,
  ActivationRecord,
} from "../../api.js";
import type { OwnerDecisionItemData } from "../../utils/validators.js";
import { selectApprovalGroupDisplayTitle, showsUnlinkedCandidateNote, validateApprovalsGroupedData } from "./focus-validation.js";
import { splitReadingTitleBody } from "../../utils/reading-layout.js";
import { OwnerWorkbench, type OwnerWorkItem } from "./OwnerWorkbench.js";
import { ApprovalSubjectReading } from "./ApprovalSubjectReading.js";
import type { RuleBindingQueueView } from "../../../shared/rule-candidate-binding-contract.js";
import { OwnerDecisionCard } from "./OwnerDecisionCard.js";
import { RuleCandidateBindingPanel, deriveRuleBindingCardState } from './RuleCandidateBindingPanel.js';

import { fetchGovernanceExperience, fetchOwnerDecisionInbox } from "../../api.js";
import type { OwnerDecisionInboxData } from "../../api.js";
import type {
  GovernanceExperienceSnapshot,
  GovernanceExperienceReasonCode,
  GovernanceExperienceNextActionCode,
  GovernancePrimaryAttention,
  WorkspaceEnvironment,
  GovernanceActivityCategorySummary,
} from "@principles/core/runtime-v2";

type DecisionResult =
  | { success: true; warning?: string }
  | { success: false; error: string; nextAction?: string };

/**
 * PRI-889: 「需要你决定」区的决策卡来源选择。
 * 分组审批数据可用时，activation_approval 决策由 PendingReviewCard（带
 * 批准/拒绝/修订按钮）承载，同名的 OwnerDecisionCard（只剩死链 CTA）不再
 * 重复渲染；分组数据不可用时全部保留 —— 决策不静默消失（rc-9）。
 */
export function selectDecisionSurfaceItems<T extends { kind: string }>(
  ownerDecisionItems: readonly T[],
  groupedAvailable: boolean,
): T[] {
  return groupedAvailable
    ? ownerDecisionItems.filter((item) => item.kind !== "activation_approval")
    : [...ownerDecisionItems];
}

export function summarizeDecisionResults(results: readonly DecisionResult[]): {
  allSucceeded: boolean;
  failedCount: number;
  failureReason?: string;
  successWarnings: string[];
} {
  const failures = results.filter((result): result is Extract<DecisionResult, { success: false }> => !result.success);
  const first = failures[0];
  const successWarnings = results
    .flatMap((result) => (result.success && typeof result.warning === "string" ? [result.warning] : []));
  return {
    allSucceeded: failures.length === 0,
    failedCount: failures.length,
    ...(first
      ? { failureReason: first.nextAction ? `${first.error} ${first.nextAction}` : first.error }
      : {}),
    successWarnings,
  };
}

/**
 * SPEC-PD-UIUX-001 R2: how the owner-inbox display items map onto the Focus
 * page after the reading-order rework. Pure display partitioning — no
 * permission or lifecycle decisions happen here.
 *
 * - decision items whose principleId matches an on-screen action card are NOT
 *   duplicated as full cards (one primary action surface per object); the
 *   match uses the verified principleId association field, never titles;
 * - unmatched decision items are preserved (with their own entry) — objects
 *   are never hidden for visual tidiness;
 * - two different decisions of the same principle are never merged: each
 *   action card keeps its own object; this partition only affects the
 *   display-only inbox projection;
 * - blocked items follow the inbox.attention semantics: 'individual' items
 *   render one card each, everything else gets one aggregate count;
 * - historical unknowns stay an explanatory notice (not part of the todo
 *   count).
 */
export function partitionInboxForDisplay<T extends { principleId: string; inbox: { group: string; attention: string } }>(
  inbox: {
    groups: {
      decision: T[];
      blocked: T[];
      recovery: T[];
    };
    historicalUnknown: { count: number };
  },
  actionCardPrincipleIds: ReadonlySet<string>,
): {
  unmatchedDecisions: T[];
  blockedIndividual: T[];
  blockedAggregate: T[];
  recovery: T[];
  pendingTotal: number;
} {
  const blockedIndividual = inbox.groups.blocked.filter((item) => item.inbox.attention === "individual");
  const blockedAggregate = inbox.groups.blocked.filter((item) => item.inbox.attention !== "individual");
  const unmatchedDecisions = inbox.groups.decision.filter((item) => !actionCardPrincipleIds.has(item.principleId));
  return {
    unmatchedDecisions,
    blockedIndividual,
    blockedAggregate,
    recovery: inbox.groups.recovery,
    // 待处理口径: decision + blocked-individual + recovery (INV-01 lineage).
    pendingTotal: inbox.groups.decision.length + blockedIndividual.length + inbox.groups.recovery.length,
  };
}

/**
 * SPEC-PD-UIUX-001 R2 (Owner review round 2): the conclusion strip's headline
 * and total must agree with the objects actually on screen and with the inbox
 * response contract.
 *
 * Modes (display-only; no permission derivation):
 * - 'unavailable' — inbox projection off (feature_disabled surfaces as
 *   ownerInbox===null with NO error) or the request failed: the pending count
 *   CANNOT be confirmed; never allClear.
 * - 'degraded' — the inbox answered HTTP-success but carries
 *   `degraded: { reason, nextAction }` (e.g. principle ledger unreadable, the
 *   server then returns EMPTY groups): counts cannot be trusted; the strip
 *   shows the server's reason + nextAction and never allClear.
 * - 'ok' — counts are trusted.
 *
 * Counting (S2): displayTotal = actionableCount + inbox pending items NOT
 * already represented by an on-screen action card. The association is the
 * verified principleId field (partition.unmatchedDecisions are inbox items
 * WITHOUT a card). One inbox item matching N cards of the same principle
 * counts the N cards (each is a distinct decision); disjoint sets sum.
 */
export function deriveConclusionDisplay(input: {
  ownerInbox: { groups: { decision: unknown[] }; degraded?: { reason: string; nextAction: string } } | null;
  ownerInboxError: string | null;
  partition: { pendingTotal: number; unmatchedDecisions: unknown[] } | null;
  actionableCount: number;
}): {
  mode: 'ok' | 'degraded' | 'unavailable';
  displayTotal: number;
  actionableCount: number;
  degraded?: { reason: string; nextAction: string };
} {
  if (input.ownerInbox === null || input.ownerInboxError !== null || input.partition === null) {
    return { mode: 'unavailable', displayTotal: input.actionableCount, actionableCount: input.actionableCount };
  }
  const matchedDecisions = input.ownerInbox.groups.decision.length - input.partition.unmatchedDecisions.length;
  const uncoveredInboxPending = Math.max(0, input.partition.pendingTotal - matchedDecisions);
  const base = {
    actionableCount: input.actionableCount,
  };
  if (input.ownerInbox.degraded !== undefined) {
    return {
      mode: 'degraded',
      displayTotal: input.actionableCount + uncoveredInboxPending,
      ...base,
      degraded: input.ownerInbox.degraded,
    };
  }
  return {
    mode: 'ok',
    displayTotal: input.actionableCount + uncoveredInboxPending,
    ...base,
  };
}

/**
 * SPEC-PD-UIUX-001 R2 (Owner review S3): EVERY conclusion branch must express
 * governance readiness the same way — "actionable now" is only claimable when
 * the actions are not locked. One matrix, one source.
 */
export function resolveConclusionActionableKey(mode: 'ok' | 'degraded' | 'unavailable', locked: boolean): string {
  if (locked) return "pages.focus.conclusion.actionableLocked";
  if (mode === 'unavailable') return "pages.focus.conclusion.actionableWithoutTotal";
  return "pages.focus.conclusion.actionableUnlocked";
}

// ── i18n code mapping helpers ─────────────────────────────────────────────

/** Map a stateReasonCode to an i18n key, with optional interpolation params. */
function getStateReasonText(
  code: string,
  t: (key: string, params?: Record<string, unknown>) => string,
  pendingReviewCount: number,
): string {
  const i18nKey = `pages.focus.stateReason.${code}`;
  const text = t(i18nKey, { count: pendingReviewCount });
  // If i18n key is not found, t() returns the key itself — fall back to code
  return text === i18nKey ? code : text;
}

/** Map a nextActionCode to an i18n key. */
function getNextActionText(
  code: string,
  t: (key: string) => string,
): string {
  const i18nKey = `pages.focus.nextAction.${code}`;
  const text = t(i18nKey);
  return text === i18nKey ? code : text;
}

/** Map a degraded signal reasonCode to an i18n key. */
function getDegradedReasonText(
  code: string,
  t: (key: string) => string,
): string {
  const i18nKey = `pages.focus.degradedReason.${code}`;
  const text = t(i18nKey);
  return text === i18nKey ? code : text;
}

/** Map a degraded signal nextActionCode to an i18n key. */
function getDegradedNextActionText(
  code: string,
  t: (key: string) => string,
): string {
  const i18nKey = `pages.focus.degradedNextAction.${code}`;
  const text = t(i18nKey);
  return text === i18nKey ? code : text;
}

// ── Owner identity configure guide (PRI-578 PR-3-B) ──────────────────────────
// Show a copyable command + doc link whenever the snapshot reports the Owner
// identity as missing — regardless of which issue owns the headline (recovery /
// degraded can outrank setup_required on busy workspaces). Guidance only: no
// persistence, no new write path (host env vars remain the single source).

export interface OwnerConfigureCommand {
  /** i18n key for the shell label, e.g. "pages.focus.experience.ownerGuide.cmdPowerShell". */
  labelKey: string;
  /** Exact multi-line command to set both variables in that shell. */
  command: string;
}

export interface OwnerConfigureGuide {
  docUrl: string;
  commands: readonly OwnerConfigureCommand[];
}

export const OWNER_CONFIGURE_DOC_URL =
  "https://github.com/csuzngjh/principles/blob/main/docs/runbooks/ops/owner-identity-configuration.md";

export const OWNER_CONFIGURE_COMMANDS: readonly OwnerConfigureCommand[] = [
  {
    labelKey: "pages.focus.experience.ownerGuide.cmdPowerShell",
    command:
      "[Environment]::SetEnvironmentVariable('PD_OWNER_ID', '<owner-id>', 'User')\n[Environment]::SetEnvironmentVariable('PD_OWNER_CREDENTIAL_ID', '<credential-id>', 'User')",
  },
  {
    labelKey: "pages.focus.experience.ownerGuide.cmdBash",
    command:
      "echo 'export PD_OWNER_ID=\"<owner-id>\"' >> ~/.bashrc\necho 'export PD_OWNER_CREDENTIAL_ID=\"<credential-id>\"' >> ~/.bashrc\nsource ~/.bashrc",
  },
];

/** Returns the configure guide when the Owner identity is missing, else null. */
export function deriveOwnerConfigureGuide(
  ownerIdentityConfiguration: string | undefined,
): OwnerConfigureGuide | null {
  if (ownerIdentityConfiguration !== "missing") return null;
  return { docUrl: OWNER_CONFIGURE_DOC_URL, commands: OWNER_CONFIGURE_COMMANDS };
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ProseSummary({
  pendingCount,
  deviationCount,
  stagnationCount,
  evidenceCount,
}: {
  pendingCount: number;
  deviationCount: number;
  stagnationCount: number;
  evidenceCount: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="text-sm leading-relaxed text-ink-2 mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]"
      role="status"
      aria-live="polite"
    >
      <span className="text-ink-3">{t("pages.focus.summaryLabel")}</span>{" "}
      <span className="font-mono font-semibold text-ink">{pendingCount}</span>{" "}
      <span className="text-ink-3">{t("pages.focus.summaryPending")}</span>{" "}
      /{" "}
      {evidenceCount > 0 ? (
        <>
          <span className="font-mono font-semibold text-ink">{evidenceCount}</span>{" "}
          <span className="text-ink-3">{t("pages.focus.summaryEvidence")}</span>{" "}
        </>
      ) : (
        <>
          <span className="font-mono font-semibold text-ink">{deviationCount}</span>{" "}
          <span className="text-ink-3">{t("pages.focus.summaryDeviation")}</span>{" "}
        </>
      )}
      /{" "}
      <span className="font-mono font-semibold text-ink">{stagnationCount}</span>{" "}
      <span className="text-ink-3">{t("pages.focus.summaryStagnation")}</span>
    </div>
  );
}

// ── Wave 4: Feedback Stratification ──────────────────────────────────────────
// Shows three feedback layers by timescale, so the Owner sees what the system
// already handled vs. what actually needs their judgment. Implements the
// "feedback latency stratification" principle from the co-evolution article.

function FeedbackStratification({
  gateBlocksToday,
  inProgressCount,
  pendingCount,
}: {
  gateBlocksToday: number;
  inProgressCount: number;
  pendingCount: number;
}) {
  const { t } = useTranslation();
  // Hide entirely when all three are zero — no feedback to stratify.
  if (gateBlocksToday === 0 && inProgressCount === 0 && pendingCount === 0) {
    return null;
  }
  return (
    <div className="mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4 mb-3">
        {t("pages.focus.stratLabel")}
      </div>
      <div className="flex items-stretch gap-3 flex-wrap">
        {/* Layer 1: seconds-level — auto-blocked, sink down */}
        <div className="flex-1 min-w-[140px] px-3 py-2 bg-surface/60 border border-line rounded-[4px]">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono font-semibold text-[18px] text-ink-4 tabular-nums">{gateBlocksToday}</span>
            <span className="text-[12px] text-ink-3">{t("pages.focus.stratGateBlocks")}</span>
          </div>
          <div className="text-[11px] text-ink-4 mt-0.5 leading-snug">{t("pages.focus.stratGateBlocksHint")}</div>
        </div>
        {/* Layer 2: minutes/hours — system processing, neutral */}
        <div className="flex-1 min-w-[140px] px-3 py-2 bg-surface/60 border border-line rounded-[4px]">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono font-semibold text-[18px] text-teal-600 tabular-nums">{inProgressCount}</span>
            <span className="text-[12px] text-ink-3">{t("pages.focus.stratInProgress")}</span>
          </div>
          <div className="text-[11px] text-ink-4 mt-0.5 leading-snug">{t("pages.focus.stratInProgressHint")}</div>
        </div>
        {/* Layer 3: hours/days — needs Owner judgment, lift up */}
        <div className="flex-1 min-w-[140px] px-3 py-2 bg-gov/5 border border-gov/30 rounded-[4px] relative">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono font-semibold text-[18px] text-gov tabular-nums">{pendingCount}</span>
            <span className="text-[12px] text-gov">{t("pages.focus.stratPendingReview")}</span>
          </div>
          <div className="text-[11px] text-ink-4 mt-0.5 leading-snug">{t("pages.focus.stratPendingReviewHint")}</div>
          <span className="absolute -top-2 right-2 inline-flex items-center border border-gov/40 text-gov bg-panel rounded-[2px] px-[6px] py-0.5 font-mono text-[9px] uppercase tracking-wider">
            {t("pages.focus.stratYouAreHere")}
          </span>
        </div>
      </div>
    </div>
  );
}

function StagnationSignalCard({ signal }: { signal: StagnationSignal }) {
  const { t } = useTranslation();
  const label =
    signal.type === "never_activated"
      ? t("pages.focus.stagnationNeverActivated")
      : t("pages.focus.stagnationNoPain");

  return (
    <article className="relative pl-[22px] py-[14px] pr-[18px] bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px]">
      <div className="text-ink-2 text-sm leading-relaxed">
        <span className="font-medium text-ink">{label}</span>{" "}
        — {signal.principleId} · {signal.daysSince}{" "}
        {t("pages.focus.stagnationDaysSince")}
      </div>
      <Link
        to={`/activation`}
        className="inline-flex items-center mt-2 text-gov text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
      >
        {t("pages.focus.viewFullChain")} →
      </Link>
    </article>
  );
}

function DegradedSignalCard({ signal }: { signal: DegradedSignal }) {
  const { t } = useTranslation();
  const sourceLabel = signal.source === "internalization_task"
    ? t("pages.focus.degradedSourceInternalization")
    : signal.source === "chain_integrity"
      ? t("pages.focus.degradedSourceChainIntegrity")
      : signal.source === "source_unavailable"
        ? t("pages.focus.degradedSourceUnavailable")
        : signal.source;

  // Use i18n-mapped text from reasonCode/nextActionCode
  const reasonText = getDegradedReasonText(signal.reasonCode, t);
  const nextActionText = getDegradedNextActionText(signal.nextActionCode, t);

  return (
    <article className="relative pl-[22px] py-[14px] pr-[18px] bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px]">
      {/* Source label */}
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
          {sourceLabel}
        </span>
      </div>
      {/* Reason (i18n) */}
      <div className="text-ink-2 text-sm leading-relaxed">
        {reasonText}
      </div>
      {/* Raw debug detail — collapsed by default to avoid unsanitized last_error in main view */}
      {signal.reason && (
        <details className="mt-1">
          <summary className="text-ink-4 text-[11px] font-mono cursor-pointer hover:underline">
            {t("pages.focus.advancedDiagnostics")}
          </summary>
          <div className="text-ink-4 text-[12px] leading-snug mt-1 font-mono bg-surface/40 px-2 py-1 rounded-[3px] break-all">
            {signal.reason}
          </div>
        </details>
      )}
      {/* Next action (i18n) */}
      <div className="mt-2 text-ink-4 text-[13px] leading-snug">
        <span className="font-medium">{t("pages.focus.degradedNextActionLabel")}</span>{" "}
        {nextActionText}
      </div>
    </article>
  );
}

function OnboardingGuide() {
  const { t } = useTranslation();
  const steps = [
    t("pages.focus.onboardingStep1"),
    t("pages.focus.onboardingStep2"),
    t("pages.focus.onboardingStep3"),
    t("pages.focus.onboardingStep4"),
    t("pages.focus.onboardingStep5"),
  ];

  return (
    <div className="bg-panel border border-line rounded-[6px] p-6">
      <SectionTitle>{t("pages.focus.onboardingTitle")}</SectionTitle>
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3 text-ink-2 text-sm leading-relaxed">
            <span className="font-mono text-ink-4 text-[11px] mt-0.5 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * PRI-332: Shown when all counts are zero and sources are healthy.
 * Explains to the owner that PD has checked everything — not that PD is broken.
 */
function ZeroStateHealthy() {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-6">
      <p className="text-ink-2 text-sm leading-relaxed">
        {t("pages.focus.zeroStateHealthy")}
      </p>
    </div>
  );
}

/**
 * PRI-332: Shown when state_db_missing — first-time setup explanation.
 */
function ZeroStateDbMissing() {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-6">
      <p className="text-ink-2 text-sm leading-relaxed">
        {t("pages.focus.zeroStateDbMissing")}
      </p>
      <div className="mt-3 text-ink-4 text-[13px]">
        <span className="font-medium">{t("pages.focus.nextActionLabel")}</span>{" "}
        {getNextActionText("run_config_doctor", t)}
      </div>
    </div>
  );
}

function InProgressGuide({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-6">
      <SectionTitle>{t("pages.focus.inProgressTitle")}</SectionTitle>
      <p className="text-ink-2 text-sm leading-relaxed mt-2">
        {summary}
      </p>
      <p className="text-ink-4 text-[13px] leading-relaxed mt-3">
        {t("pages.focus.inProgressDetail")}
      </p>
    </div>
  );
}

function DegradedSummary({ signals }: { signals: DegradedSignal[] }) {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px] p-5">
      <SectionTitle>{t("pages.focus.degradedTitle")}</SectionTitle>
      <p className="text-ink-2 text-sm leading-relaxed mt-2">
        {t("pages.focus.degradedStateReason")}
      </p>
      <div className="mt-4 space-y-[10px]">
        {signals.map((signal, i) => (
          <DegradedSignalCard key={`${signal.source}-${i}`} signal={signal} />
        ))}
      </div>
    </div>
  );
}

// ── PRI-586: Governance Experience Snapshot display ─────────────────────────
// Exhaustive Record maps over the snapshot enums (ERR-106: no binary ternaries
// folding union members into a default branch). Exported for the i18n parity
// test; keys must exist in BOTH en.json and zh-CN.json (cr10).

export const EXPERIENCE_ATTENTION: Record<GovernancePrimaryAttention, { labelKey: string; badgeClass: string }> = {
  setup_required: { labelKey: "pages.focus.experience.attention.setupRequired", badgeClass: "bg-amber/10 text-amber border border-amber/20" },
  owner_decision_required: { labelKey: "pages.focus.experience.attention.ownerDecisionRequired", badgeClass: "bg-gov/10 text-gov border border-gov/20" },
  recovery_required: { labelKey: "pages.focus.experience.attention.recoveryRequired", badgeClass: "bg-amber/10 text-amber border border-amber/20" },
  degraded: { labelKey: "pages.focus.experience.attention.degraded", badgeClass: "bg-amber/10 text-amber border border-amber/20" },
  background_processing: { labelKey: "pages.focus.experience.attention.backgroundProcessing", badgeClass: "bg-green/10 text-green border border-green/20" },
  all_clear: { labelKey: "pages.focus.experience.attention.allClear", badgeClass: "text-ink-4 border border-line bg-surface/80" },
};

export const EXPERIENCE_REASON: Record<GovernanceExperienceReasonCode, string> = {
  "governance.exp.reason.owner_identity_missing": "pages.focus.experience.reason.ownerIdentityMissing",
  "governance.exp.reason.owner_identity_invalid": "pages.focus.experience.reason.ownerIdentityInvalid",
  "governance.exp.reason.owner_authentication_missing": "pages.focus.experience.reason.ownerAuthenticationMissing",
  "governance.exp.reason.approval_pending": "pages.focus.experience.reason.approvalPending",
  "governance.exp.reason.rulecode_owner_decision": "pages.focus.experience.reason.rulecodeOwnerDecision",
  "governance.exp.reason.no_pending_decision": "pages.focus.experience.reason.noPendingDecision",
  "governance.exp.reason.owner_decision_available": "pages.focus.experience.reason.ownerDecisionAvailable",
  "governance.exp.reason.break_glass_entry": "pages.focus.experience.reason.breakGlassEntry",
  "governance.exp.reason.recovery_required": "pages.focus.experience.reason.recoveryRequired",
  "governance.exp.reason.source_unavailable": "pages.focus.experience.reason.sourceUnavailable",
  "governance.exp.reason.config_invalid": "pages.focus.experience.reason.configInvalid",
  "governance.exp.reason.processing": "pages.focus.experience.reason.processing",
  "governance.exp.reason.workspace_clear": "pages.focus.experience.reason.workspaceClear",
  "governance.exp.reason.workspace_empty": "pages.focus.experience.reason.workspaceEmpty",
};

export const EXPERIENCE_NEXT_ACTION: Record<GovernanceExperienceNextActionCode, string> = {
  "governance.exp.next.configure_owner": "pages.focus.experience.next.configureOwner",
  "governance.exp.next.authenticate_console": "pages.focus.experience.next.authenticateConsole",
  "governance.exp.next.review_approvals": "pages.focus.experience.next.reviewApprovals",
  "governance.exp.next.inspect_recovery": "pages.focus.experience.next.inspectRecovery",
  "governance.exp.next.inspect_sources": "pages.focus.experience.next.inspectSources",
  "governance.exp.next.fix_config": "pages.focus.experience.next.fixConfig",
  "governance.exp.next.monitor": "pages.focus.experience.next.monitor",
  "governance.exp.next.none": "pages.focus.experience.next.none",
};

const EXPERIENCE_ENVIRONMENT: Record<WorkspaceEnvironment | "unknown", string> = {
  production: "pages.focus.experience.trust.environment.production",
  development: "pages.focus.experience.trust.environment.development",
  demo: "pages.focus.experience.trust.environment.demo",
  test: "pages.focus.experience.trust.environment.test",
  unknown: "pages.focus.experience.trust.environment.unknown",
};

function ExperienceSummaryCard({ snapshot }: { snapshot: GovernanceExperienceSnapshot }) {
  const { t } = useTranslation();
  const attention = EXPERIENCE_ATTENTION[snapshot.summary.primaryAttention];
  const categoryOf = (category: GovernanceActivityCategorySummary["category"]) =>
    snapshot.activity.categories.find(entry => entry.category === category);
  const decision = categoryOf("needs_decision");
  const recovery = categoryOf("needs_recovery");
  const blocked = categoryOf("blocked");
  const processing = categoryOf("processing");
  const firstIssue = snapshot.dataQuality.issueGroups[0];
  const governanceBlocked = snapshot.readiness.ownerIdentityConfiguration !== "configured"
    || snapshot.readiness.authenticationMode !== "authenticated";
  const blockerKey = snapshot.readiness.ownerIdentityConfiguration === "invalid"
    ? "pages.focus.experience.blocker.identityInvalid"
    : snapshot.readiness.ownerIdentityConfiguration === "missing"
      ? "pages.focus.experience.blocker.identityMissing"
      : "pages.focus.experience.blocker.authenticationMissing";
  return (
    <div className="mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]" data-testid="experience-summary">
      <div className="flex items-center gap-2 mb-1">
        <span className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${attention.badgeClass}`} role="status">
          {t(attention.labelKey)}
        </span>
      </div>
      <div className="text-ink-2 text-[13px] leading-relaxed mt-1" data-testid="experience-reason">
        {t(EXPERIENCE_REASON[snapshot.summary.reasonCode])}
      </div>
      <div className="text-ink-4 text-[13px] leading-relaxed mt-1">
        <span className="font-medium">{t("pages.focus.nextActionLabel")}</span>{" "}
        {t(EXPERIENCE_NEXT_ACTION[snapshot.summary.nextActionCode])}
      </div>
      {(decision !== undefined || recovery !== undefined || blocked !== undefined || processing !== undefined) && (
        <div className="text-[13px] text-ink-3 mt-2 leading-relaxed" data-testid="experience-activity">
          {decision !== undefined && (
            <span className="mr-4">{t("pages.focus.experience.activity.needsDecision", { count: decision.count })}</span>
          )}
          {recovery !== undefined && (
            <span className="mr-4">{t("pages.focus.experience.activity.needsRecovery", { count: recovery.count })}</span>
          )}
          {blocked !== undefined && <span className="mr-4">{t("pages.focus.experience.activity.blocked")}</span>}
          {/* Processing counts are deliberately folded — "Background processing", never a raw "Processing 405" headline. */}
          {processing !== undefined && (
            <span>{t("pages.focus.experience.activity.processing", { count: processing.count })}</span>
          )}
        </div>
      )}
      {governanceBlocked && (
        <div className="mt-3 flex items-center justify-between gap-3 border border-amber/30 rounded-[6px] bg-surface px-3 py-2.5" data-testid="owner-configure-guide">
          <p className="text-[12px] text-ink-3 leading-relaxed">{t(blockerKey)}</p>
          <Link to="/settings" className="shrink-0 text-[12px] text-gov underline hover:text-gov-2">
            {t("pages.focus.experience.blocker.goSettings")}
          </Link>
        </div>
      )}
      <div className="mt-1 text-[12px] text-ink-4" data-testid="experience-trust">
        {t(EXPERIENCE_ENVIRONMENT[snapshot.trustContext.environmentContext.environment])}
        {" · "}
        {t(`pages.focus.experience.trust.lineage.${snapshot.trustContext.lineageTransparency.confidence}`)}
      </div>
      {snapshot.dataQuality.degraded && (
        <div className="mt-2 text-[12px] text-amber leading-relaxed" data-testid="experience-data-quality">
          {t("pages.focus.experience.dataQuality.degraded", { count: firstIssue?.count ?? 0, reasonCode: firstIssue?.reasonCode ?? "" })}
        </div>
      )}
    </div>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";
type FocusSource = 'summary' | 'approvals' | 'activations' | 'bindings' | 'decisions' | 'inbox';
const FOCUS_SOURCES: FocusSource[] = ['summary', 'approvals', 'activations', 'bindings', 'decisions', 'inbox'];

export interface FocusPageProps {
  /** Feature flags from /api/v1/config/summary — gates the experience snapshot path. */
  featureFlags?: Record<string, { enabled: boolean } | undefined>;
}

export function FocusPage({ featureFlags }: FocusPageProps) {
  const { t } = useTranslation();
  // PRI-586: when governance_experience_v1 is enabled the governance summary
  // comes ONLY from the experience snapshot — the legacy queue endpoint is not
  // consulted (SPEC §14.2 no old-queue + snapshot merge). Approvals and
  // activations remain the MUTATION surface (action cards), not a status source.
  const experienceMode = featureFlags?.governance_experience_v1?.enabled === true;
  // Flags still loading (undefined): fire NEITHER governance status endpoint —
  // otherwise a transient legacy queue request goes out before the flag turns
  // experience mode on (wasted call + legacy-panel flash). Hold in `loading`.
  const flagsResolved = featureFlags !== undefined;
  const [bindingQueue, setBindingQueue] = useState<RuleBindingQueueView | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [completedMessage, setCompletedMessage] = useState<{ key: string; message: string } | null>(null);
  const requestEpoch = useRef(0);
  const [pendingSources, setPendingSources] = useState<FocusSource[]>(FOCUS_SOURCES);
  const [queueData, setQueueData] = useState<GovernanceQueueData | null>(null);
  const [experienceData, setExperienceData] = useState<GovernanceExperienceSnapshot | null>(null);
  const [groupedData, setGroupedData] = useState<ApprovalsGroupedData | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [groupedErrorReason, setGroupedErrorReason] = useState<string | null>(null);
  const [ruleCodeItems, setRuleCodeItems] = useState<ActivationRecord[]>([]);
  const [ruleCodeErrorReason, setRuleCodeErrorReason] = useState<string | null>(null);
  // PRI-629: 统一 Owner Inbox — 两种模式都加载 (决策与治理摘要模式正交)
  const [ownerDecisionItems, setOwnerDecisionItems] = useState<OwnerDecisionItemData[]>([]);
  const [ownerDecisionError, setOwnerDecisionError] = useState<string | null>(null);
  // Owner Decision Experience v1: canonical decision inbox (3 groups + aggregate
  // historical notice). Display-only; degradation is observable, never silent.
  const [ownerInbox, setOwnerInbox] = useState<OwnerDecisionInboxData | null>(null);
  const [ownerInboxError, setOwnerInboxError] = useState<string | null>(null);
  // PD_PROMPT_CAPACITY_V1 R-A1: request-level target host for the prompt
  // capacity forecast + approve precheck. Set from the 未确认 banner when the
  // workspace's applicable hosts would take different routes; request-scoped
  // only — no persisted host configuration is created here.
  const [promptTargetHost, setPromptTargetHost] = useState<"openclaw" | "codex" | "workbuddy" | null>(null);

  const loadData = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoadingState("loaded");
    setPendingSources(FOCUS_SOURCES);
    setExperienceData(null); setQueueData(null); setGroupedData(null);
    setRuleCodeItems([]); setBindingQueue(null); setOwnerDecisionItems([]); setOwnerInbox(null);
    setErrorMessage(null);
    setGroupedErrorReason(null);
    setRuleCodeErrorReason(null);
    setBindingError(null); setOwnerDecisionError(null); setOwnerInboxError(null);

    // Each source publishes independently. A stalled history/inbox request must
    // not hide already available decisions; old request epochs cannot publish.
    async function settle<T>(source: FocusSource, request: Promise<T>, apply: (value: T) => void, fail: (message: string) => void) {
      try {
        const result = await request;
        if (epoch === requestEpoch.current) apply(result);
      } catch (error) {
        if (epoch === requestEpoch.current) fail(error instanceof Error ? error.message : t('pages.focus.loadError'));
      } finally {
        if (epoch === requestEpoch.current) setPendingSources(current => current.filter(item => item !== source));
      }
    }
    await Promise.all([
      experienceMode
        ? settle('summary', fetchGovernanceExperience(), result => {
          if (result.success) setExperienceData(result.data); else setErrorMessage(result.error);
        }, setErrorMessage)
        : settle('summary', fetchGovernanceQueue(), result => {
          if (result.success) setQueueData(result.data); else setErrorMessage(result.error);
        }, setErrorMessage),
      settle('approvals', fetchApprovalsGrouped(promptTargetHost ?? undefined), result => {
        if (!result.success) { setGroupedErrorReason(result.error); return; }
        const data = validateApprovalsGroupedData(result.data);
        setGroupedData(data);
        if (data === null) setGroupedErrorReason(t('pages.focus.workbench.approvalsUnavailable'));
      }, setGroupedErrorReason),
      settle('activations', fetchAllActivations(promptTargetHost ?? undefined), result => {
        if (result.success) setRuleCodeItems(result.data.activations.filter(item => item.channel === 'code_tool_hook' && item.status === 'active'));
        else setRuleCodeErrorReason(result.error);
      }, setRuleCodeErrorReason),
      settle('bindings', fetchRuleBindingQueue(), result => {
        if (result.success) setBindingQueue(result.data); else setBindingError(result.error);
      }, setBindingError),
      settle('decisions', fetchOwnerDecisions(), result => {
        if (result.success) setOwnerDecisionItems(result.data.items); else setOwnerDecisionError(result.error);
      }, setOwnerDecisionError),
      settle('inbox', fetchOwnerDecisionInbox(), result => {
        if (result.success) setOwnerInbox(result.data);
        else if (result.reason !== 'feature_disabled') setOwnerInboxError(result.error);
      }, setOwnerInboxError),
    ]);
  }, [experienceMode, t, promptTargetHost]);

  function changePromptTargetHost(host: typeof promptTargetHost) {
    if (host === promptTargetHost) return;
    requestEpoch.current++;
    setPendingSources(FOCUS_SOURCES);
    setCompletedMessage(null);
    setPromptTargetHost(host);
  }

  useEffect(() => {
    if (!flagsResolved) return;
    void loadData();
    return () => { requestEpoch.current++; };
  }, [flagsResolved, loadData]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
          {t("pages.focus.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.focus.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.focus.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const pendingGroups = groupedData?.groups.filter((g) => g.status === "pending") ?? [];
  const groupedAvailable = groupedData !== null;
  const decisionItems = selectDecisionSurfaceItems(ownerDecisionItems, groupedAvailable);
  // Single source for "the inline approval cards are on screen" — the section
  // count and the empty state must agree on it.
  const showApprovalCards = groupedAvailable && pendingGroups.length > 0;
  const pendingCount = queueData?.pendingReviewCount ?? 0;
  const deviationCount = queueData?.behaviorDeviationCount ?? 0;
  const stagnationSignals = queueData?.stagnationSignals ?? [];
  const stagnationCount = stagnationSignals.length;
  const governanceState = queueData?.governanceState ?? "none";
  const stateReasonCode = queueData?.stateReasonCode ?? "no_pipeline_activity";
  const nextActionCode = queueData?.nextActionCode ?? "wait_for_pipeline";
  const inProgressSummary = queueData?.inProgressSummary;
  const degradedSignals = queueData?.degradedSignals;
  const evidenceCount = queueData?.evidenceInProgressCount ?? 0;
  const gateBlocksToday = queueData?.gateBlocksToday ?? 0;
  const approvalDataUnavailable = (groupedData === null || groupedData.groups.length === 0) && pendingCount > 0;
  const ruleCodePending = ruleCodeItems.filter(item => item.action === 'code_tool_hook_shadow_activate' && item.enforcement !== 'safety_isolated');
  const ruleCodeAlerts = ruleCodeItems.filter(item => item.enforcement === 'safety_isolated');

  // PRI-787: 决策动作被治理就绪门锁定时，必须在卡片上给出可见原因（rc-9 —
  // 未知就绪状态或新宿主的材料仍在读取时，允许阅读，不放行动作。
  const ownerActionsLockedReason = pendingSources.includes('summary') || (experienceMode && experienceData === null)
    ? t("pages.focus.workbench.permissionsUnknown")
    : experienceData === null
    || (experienceData.readiness.authenticationMode === "authenticated"
      && experienceData.readiness.ownerIdentityConfiguration === "configured")
    ? null
    : t(
      experienceData.readiness.authenticationMode !== "authenticated"
        ? "pages.focus.ownerDecision.actionsLockedAuth"
        : "pages.focus.ownerDecision.actionsLockedIdentity",
    );

  // ── SPEC-PD-UIUX-001 R2: one primary action surface per decision object ──
  // Matching uses the verified principleId association field (never titles).
  // See partitionInboxForDisplay for the semantics.
  const actionCardPrincipleIds = new Set<string>();
  for (const item of decisionItems) {
    if (item.principleId !== undefined) actionCardPrincipleIds.add(item.principleId);
  }
  for (const group of pendingGroups) actionCardPrincipleIds.add(group.principleId);
  const inboxPartition = ownerInbox !== null && ownerInboxError === null
    ? partitionInboxForDisplay(ownerInbox, actionCardPrincipleIds)
    : null;
  const inboxBlockedIndividual = inboxPartition?.blockedIndividual ?? [];
  const inboxBlockedAggregate = inboxPartition?.blockedAggregate ?? [];
  const inboxRecovery = inboxPartition?.recovery ?? [];
  const unmatchedInboxDecisions = inboxPartition?.unmatchedDecisions ?? [];
  // 待处理口径 (INV-01 lineage): decision + blocked-individual + recovery —
  // same three groups the inbox renders; historical unknowns stay explanatory.
  const inboxPendingTotal = inboxPartition?.pendingTotal ?? 0;
  // 可操作口径: the action cards actually on screen (decision cards + approval
  // cards) — the same number the「需要你决定」section header shows.
  const actionableCount = (ownerDecisionError === null ? decisionItems.length : 0)
    + (showApprovalCards ? pendingGroups.length : 0);
  // Review round 2 (P2): the headline never claims allClear from the inbox
  // alone, degraded payloads surface their reason, and the total is the
  // association-deduped union of on-screen cards and inbox items — see
  // deriveConclusionDisplay.
  const conclusionDisplay = deriveConclusionDisplay({
    ownerInbox,
    ownerInboxError,
    partition: inboxPartition,
    actionableCount,
  });

  // Map codes to i18n text
  // Governance Recovery Actions v1: tasks_need_human_review interpolates the
  // needs_human_review task count, not the approvals count.
  const humanReviewCount = queueData?.pendingHumanReviewCount ?? 0;
  const stateReasonCount = stateReasonCode === "tasks_need_human_review" ? humanReviewCount : pendingCount;
  const stateReason = getStateReasonText(stateReasonCode, t, stateReasonCount);
  const nextAction = getNextActionText(nextActionCode, t);

  const sourcesUncertain = pendingSources.length > 0 || conclusionDisplay.mode === 'degraded' || experienceData?.dataQuality.degraded === true
    || ruleCodeErrorReason !== null || errorMessage !== null || ownerDecisionError !== null || groupedErrorReason !== null || bindingError !== null || ownerInboxError !== null;
  const workItems: OwnerWorkItem[] = [
    ...ruleCodePending.filter(item => !decisionItems.some(decision => decision.kind === 'rulecode_decision' && decision.taskId === item.activationId)).map(item => ({ key: `activation:${item.activationId}`, title: splitReadingTitleBody(t('pages.focus.workbench.rulePromotion')).title,
      kind: t('pages.focus.workbench.rulePromotion'), summary: t('pages.focus.workbench.promotionSummary'), reference: item.activationId,
      content: <div className="text-sm leading-relaxed text-ink-2"><p>{t('pages.focus.workbench.promotionSummary')}</p><Link to={`/activation?activationId=${encodeURIComponent(item.activationId)}`} className="mt-4 inline-block text-gov underline">{t('pages.focus.workbench.openActivation')}</Link></div> })),
    ...decisionItems.map(item => ({ key: `decision:${item.reviewKey}`, title: splitReadingTitleBody(item.title).title,
      kind: t('pages.focus.workbench.taskDecision'), summary: item.summary, reference: item.taskId,
      content: <OwnerDecisionCard key={`${item.reviewKey}:${promptTargetHost ?? 'default'}`} item={item} governanceReady={ownerActionsLockedReason === null}
        actionsLockedReason={ownerActionsLockedReason ?? undefined} onResolved={() => { setCompletedMessage({ key: `decision:${item.reviewKey}`, message: t('pages.focus.workbench.decisionRecorded') }); void loadData(); }} /> })),
    ...pendingGroups.flatMap(group => group.records.filter(record => record.status === 'pending').map((record, index) => ({
      key: `approval:${record.id}`, title: new Set(group.records.map(entry => entry.artifactId)).size > 1 ? t('pages.focus.workbench.versionNeedsReview', { index: index + 1 }) : splitReadingTitleBody(selectApprovalGroupDisplayTitle(group) ?? t('pages.focus.untitledCandidate')).title,
      kind: t(record.channel === 'prompt' ? 'pages.focus.workbench.promptReview' : record.channel === 'defer_archive' ? 'pages.focus.workbench.archiveReview' : 'pages.focus.workbench.ruleReview'),
      summary: t('pages.focus.workbench.approvalSummary'),
      content: <ApprovalSubjectReading key={`${record.id}:${promptTargetHost ?? 'default'}`} principleId={group.principleId} approvalId={record.id} artifactId={record.artifactId} channel={record.channel} lockedReason={ownerActionsLockedReason ?? undefined}
        targetHost={promptTargetHost ?? undefined} revisionReview={new Set(group.records.filter(entry => entry.status === 'pending').map(entry => entry.artifactId)).size === 1 ? group.revisionReview : undefined}
        revisionReviewUnavailable={group.revisionReviewUnavailable}
        sourceUnlinked={showsUnlinkedCandidateNote(group)}
        promptInjection={groupedData?.promptInjection}
        budgetNotice={groupedData?.promptInjection?.truncated === true && groupedData.promptInjection.capacityStatus !== 'unconfirmed' ? t(
          groupedData.promptInjection.productionRotates === true ? group.fitsPromptBudget === true ? group.promptBudgetTierFit === 'model_dependent'
            ? 'pages.focus.approveQueueBadgeRotationModelDependent' : 'pages.focus.approveQueueBadgeRotation' : 'pages.focus.approveQueueBadgeOversized' : 'pages.focus.approveQueueBadge',
          { used: groupedData.promptInjection.usedChars, budget: groupedData.promptInjection.budget }) : undefined}
        onResolved={message => { setCompletedMessage({ key: `approval:${record.id}`, message }); void loadData(); }} />,
    }))),
    ...(bindingQueue?.items ?? []).filter(item => !['bound_generating', 'bound_advanced', 'bound_not_built'].includes(deriveRuleBindingCardState(item))).map(item => ({ key: `binding:${item.candidateId}`, title: splitReadingTitleBody(item.text).title,
      kind: t('pages.focus.workbench.bindingReview'), summary: item.pain.text ?? t('pages.focus.workbench.bindingSummary'), reference: item.candidateId,
      content: <RuleCandidateBindingPanel key={item.candidateId} candidateId={item.candidateId} onChanged={() => { void loadData(); }} /> })),
  ];

  return (
    <PageShell className="max-w-[1120px] owner-workbench-container">
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.focus.eyebrow")}
      </div>
      <ShinyText
        as="h1"
        className="text-[29px] font-semibold tracking-tight text-ink mb-2"
        duration={4.5}
        brightness={0.5}
        disabled={pendingCount === 0}
      >
        {t('pages.focus.workbench.title')}
      </ShinyText>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t('pages.focus.workbench.subtitle')}
      </p>

      {/* SPEC-PD-UIUX-001 R2 Layer 1: 当前结论 — readiness, one lock reason,
          and 待处理/可操作 counts FIRST, before any object lists. The
          per-object lock notices and the secondary status cards below keep
          their own explanations; this strip never re-derives permissions —
          it displays existing server state (readiness + inbox + action cards). */}
      <section
        aria-label={t("pages.focus.conclusion.sectionTitle")}
        data-testid="focus-conclusion"
        className="mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]"
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
              experienceMode && experienceData !== null
                ? EXPERIENCE_ATTENTION[experienceData.summary.primaryAttention].badgeClass
                : governanceState === "owner_review_ready"
                  ? "bg-gov/10 text-gov border border-gov/20"
                  : governanceState === "degraded"
                    ? "bg-amber/10 text-amber border border-amber/20"
                    : governanceState === "in_progress"
                      ? "bg-green/10 text-green border border-green/20"
                      : "text-ink-4 border border-line bg-surface/80"
            }`}
            role="status"
            data-testid="focus-conclusion-badge"
          >
            {sourcesUncertain ? t('pages.focus.workbench.sourcesPending') : workItems.length > 0 ? t('pages.focus.workbench.title') : experienceMode && experienceData !== null
              ? t(EXPERIENCE_ATTENTION[experienceData.summary.primaryAttention].labelKey)
              : t(`pages.focus.stateLabel.${governanceState}`)}
          </span>
          <div className="text-ink-2 text-[13px] leading-relaxed" data-testid="focus-conclusion-counts">
            <span className="font-medium">{t('pages.focus.workbench.count', { count: workItems.length })}</span>
            {sourcesUncertain && <span className="ml-2 text-amber" data-testid="focus-conclusion-uncertain">{t('pages.focus.workbench.uncertain')}</span>}
          </div>
        </div>
        {conclusionDisplay.mode === 'degraded' && conclusionDisplay.degraded && (
          <div
            className="mt-3 border border-amber/30 rounded-[6px] bg-surface px-3 py-2.5"
            data-testid="focus-conclusion-degraded"
          >
            <p className="text-[12px] text-ink-3 leading-relaxed">
              {t("pages.focus.conclusion.degradedLabel")} {conclusionDisplay.degraded.reason}
            </p>
            <p className="mt-1 text-[12px] text-ink-3 leading-relaxed">{conclusionDisplay.degraded.nextAction}</p>
          </div>
        )}
        {ownerActionsLockedReason !== null && (
          <div
            id="focus-global-lock-notice"
            className="mt-3 flex items-start justify-between gap-3 border border-amber/30 rounded-[6px] bg-surface px-3 py-2.5"
            data-testid="focus-conclusion-lock"
          >
            <p className="text-[12px] text-ink-3 leading-relaxed">{ownerActionsLockedReason}</p>
            <Link to="/settings" className="shrink-0 text-[12px] text-gov underline hover:text-gov-2">
              {t("pages.focus.ownerDecision.goSettingsCta")}
            </Link>
          </div>
        )}
        <details className="mt-2 text-ink-4 text-[11.5px] leading-relaxed"><summary className="cursor-pointer">{t('pages.focus.workbench.countExplanation')}</summary>
          <p className="mt-2" data-testid="focus-conclusion-scope-note">{t("pages.focus.conclusion.countsNote")}</p>
        </details>
      </section>

      {(errorMessage || bindingError) && <div role="alert" className="mb-5 border-l-2 border-amber pl-3 text-sm leading-relaxed text-ink-3">
        <p>{t('pages.focus.workbench.uncertain')}</p><p className="mt-1 text-[12px]">{errorMessage ?? bindingError}</p>
        <button type="button" onClick={() => { void loadData(); }} className="mt-2 text-gov underline">{t('pages.focus.workbench.retry')}</button>
      </div>}
      {ruleCodeAlerts.length > 0 && <section role="alert" className="mb-5 border-l-2 border-danger pl-3 text-sm text-ink">
        <p>{t('pages.focus.workbench.safetyAlert', { count: ruleCodeAlerts.length })}</p>
        <Link to="/activation" className="mt-2 inline-block text-gov underline">{t('pages.focus.workbench.openActivation')}</Link>
      </section>}
      {groupedErrorReason && <p role="alert" className="mb-4 text-[13px] text-amber">{t('pages.focus.workbench.approvalsUnavailable')}</p>}
      <OwnerWorkbench items={workItems} completed={completedMessage} uncertain={sourcesUncertain} />

      {/* PRI-629: 需要你决定 — 统一 Owner Inbox。两种治理摘要模式下都渲染;
          N = 真实可执行决策数 (INV-01),不是 lifecycle/NHR/failed 计数。 */}
      <section aria-label={t("pages.focus.ownerDecision.sectionTitle")} className="mb-7" data-testid="owner-decisions-section">
        {ownerDecisionError !== null && <p role="alert" className="text-amber text-[13px]">{t('pages.focus.ownerDecision.loadError')}</p>}
        {/* 分组数据不可用时 OwnerDecisionCard 保持原渲染（含降级 CTA），决策不静默消失（rc-9）——见 selectDecisionSurfaceItems。 */}
        {/* PD_PROMPT_CAPACITY_V1 R-A1: 适用宿主会走不同路由且未选择目标宿主时，
            明确标注"当前宿主容量未确认"并分别展示各宿主的能力——不猜测 FIFO 或轮转。 */}
        {(() => {
          const unconfirmed = groupedData?.promptInjection;
          if (unconfirmed === undefined || unconfirmed.capacityStatus !== "unconfirmed") return null;
          return (
          <div
            className="mb-4 rounded-[3px] border border-amber/40 bg-amber/5 px-3 py-2 text-[12.5px] leading-relaxed text-amber"
            data-testid="prompt-capacity-unconfirmed-banner"
          >
            <p>
              {t("pages.focus.promptCapacityUnconfirmed", {
                defaultValue: "当前宿主容量未确认：本工作区适用的宿主会走不同的注入路由，以下数字未绑定具体宿主。",
              })}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {(unconfirmed.perHost ?? []).map((entry) => (
                <li key={entry.hostKind} data-testid={`prompt-capacity-perhost-${entry.hostKind}`}>
                  {t("pages.focus.promptCapacityPerHostEntry", {
                    host: entry.hostKind === "openclaw" ? "OpenClaw" : entry.hostKind === "workbuddy" ? "WorkBuddy" : "Codex",
                    billing: entry.route === "shared_render"
                      ? t("pages.focus.promptCapacitySharedRoute")
                      : t("pages.focus.promptCapacityListRoute"),
                    used: entry.usedChars,
                    // PRI-1017: each host shows ITS OWN budget basis (runtime
                    // observation or its own honest fallback) — never the
                    // shared headline number.
                    budget: entry.budget ?? unconfirmed.budget,
                    full: entry.truncated ? t("pages.focus.promptCapacityPerHostFull") : "",
                    observed: entry.budgetObservedAt !== undefined
                      ? t("pages.focus.promptCapacityPerHostObserved", {
                          defaultValue: "（预算来自该宿主最近一次运行时观测，观测于 {{observedAt}}）",
                          observedAt: entry.budgetObservedAt,
                        })
                      // PRI-1020: a declared basis is the Owner's own config
                      // fact — label it as a declaration, never as an
                      // observation.
                      : entry.budgetCapacitySource === "operator_declared"
                        ? t("pages.focus.promptCapacityPerHostDeclared", {
                            defaultValue: "（预算来自工作区配置声明）",
                          })
                        : "",
                  })}
                  {entry.budgetFallbackReason !== undefined && (
                    <span data-testid={`prompt-capacity-perhost-reason-${entry.hostKind}`}>
                      {" · "}
                      {t(`pages.focus.budgetFallbackReason.${entry.budgetFallbackReason}`, {
                        defaultValue: entry.budgetFallbackReason,
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {unconfirmed.nextAction !== undefined && (
              <p className="mt-1 text-ink-2">{unconfirmed.nextAction}</p>
            )}
            <div className="mt-2 flex gap-2">
              {(["openclaw", "codex", "workbuddy"] as const).map((host) => (
                <button
                  key={host}
                  type="button"
                  onClick={() => changePromptTargetHost(host)}
                  data-testid={`prompt-capacity-pick-${host}`}
                  className={`inline-flex items-center border rounded-[3px] px-[10px] py-[4px] transition-colors ${
                    promptTargetHost === host ? "border-amber bg-amber/10" : "border-line hover:border-line-2"
                  }`}
                >
                  {t("pages.focus.promptCapacityViewAsHost", { host: host === "openclaw" ? "OpenClaw" : host === "workbuddy" ? "WorkBuddy" : "Codex" })}
                </button>
              ))}
              {promptTargetHost !== null && (
                <button
                  type="button"
                  onClick={() => changePromptTargetHost(null)}
                  data-testid="prompt-capacity-pick-clear"
                  className="inline-flex items-center border border-line rounded-[3px] px-[10px] py-[4px] hover:border-line-2"
                >
                  {t("pages.focus.promptCapacityClearHost", { defaultValue: "清除选择" })}
                </button>
              )}
            </div>
          </div>
          );
        })()}
      </section>

      {/* SPEC-PD-UIUX-001 R2 Layer 3: 被阻塞与需要恢复 — from the owner inbox.
          Individual-attention items stay fully exposed (never mechanically
          collapsed); aggregate-attention blocked objects get one count line;
          decision items WITHOUT a rendered action card stay visible here so no
          legal todo disappears. Historical unknowns remain an explanatory
          notice, never a todo card. */}
      <section aria-label={t("pages.focus.ownerAttention.sectionTitle")} className="mb-7" data-testid="owner-attention-section">
        <div className="flex items-baseline gap-2 mb-3">
          <SectionTitle>{t("pages.focus.ownerAttention.sectionTitle")}</SectionTitle>
          {ownerInbox !== null && ownerInboxError === null && (
            <span className="font-mono text-ink-4 text-[12px]" data-testid="owner-attention-counts">
              {`· ${t("pages.focus.ownerAttention.blockedCount", { count: ownerInbox.groups.blocked.length })} · ${t("pages.focus.ownerAttention.recoveryCount", { count: inboxRecovery.length })}`}
            </span>
          )}
        </div>
        {ownerInboxError !== null && (
          <p className="text-ink-4 text-[12.5px]">{t("pages.focus.ownerInbox.loadError")}</p>
        )}
        {ownerInbox !== null && ownerInboxError === null && (
          <>
            {ownerInbox.groups.blocked.length === 0
              && inboxRecovery.length === 0
              && unmatchedInboxDecisions.length === 0 && (
              <p className="text-ink-4 text-[13px]">{t("pages.focus.ownerAttention.empty")}</p>
            )}
            {unmatchedInboxDecisions.length > 0 && (
              <p className="mb-2 text-ink-4 text-[12px] leading-relaxed" data-testid="owner-attention-unmatched-note">
                {t("pages.focus.ownerAttention.unmatchedTitle")}
              </p>
            )}
            {unmatchedInboxDecisions.map((item) => (
              <InboxItem key={item.principleId} item={item} t={t} note={t("pages.focus.ownerAttention.unmatchedItemNote")} />
            ))}
            {inboxBlockedIndividual.map((item) => (
              <InboxItem key={item.principleId} item={item} t={t} />
            ))}
            {inboxRecovery.map((item) => (
              <InboxItem key={item.principleId} item={item} t={t} />
            ))}
            {inboxBlockedAggregate.length > 0 && (
              <p className="mt-2 text-ink-4 text-[12.5px] leading-relaxed" data-testid="owner-attention-aggregate-notice">
                {t("pages.focus.ownerAttention.blockedAggregate", { count: inboxBlockedAggregate.length })}
                {" "}
                <Link to="/principles" className="text-gov hover:underline">
                  {t("pages.focus.ownerInbox.viewLibrary")}
                </Link>
              </p>
            )}
            {ownerInbox.historicalUnknown.count > 0 && (
              <p className="text-ink-4 text-[12.5px] leading-relaxed mt-2" data-testid="owner-inbox-aggregate-notice">
                {ownerInbox.historicalUnknown.reasonText}
                {" "}
                <Link to="/principles" className="text-gov hover:underline">
                  {t("pages.focus.ownerInbox.viewLibrary")}
                </Link>
              </p>
            )}
          </>
        )}
      </section>

      <details className="mt-8 border-t border-line pt-5" data-testid="focus-runtime-records">
        <summary className="cursor-pointer text-[14px] text-ink-3">{t('pages.focus.workbench.runtimeRecords')}</summary>
        <div className="mt-5">
          <details className="mb-6"><summary className="cursor-pointer text-sm text-gov">{t('pages.focus.ruleBinding.title')}</summary><RuleCandidateBindingPanel onChanged={() => { void loadData(); }} /></details>
      {/* Governance blocker/recovery follows the actual decision index so the
          first actionable card remains visible in common Companion viewports. */}
      {experienceMode && experienceData !== null && !(experienceData.summary.primaryAttention === 'all_clear' && (sourcesUncertain || workItems.length > 0)) ? (
        <ExperienceSummaryCard snapshot={experienceData} />
      ) : !experienceMode ? (
        <div className="mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
              governanceState === "owner_review_ready" ? "bg-gov/10 text-gov border border-gov/20"
                : governanceState === "degraded" ? "bg-amber/10 text-amber border border-amber/20"
                  : governanceState === "in_progress" ? "bg-green/10 text-green border border-green/20"
                    : "text-ink-4 border border-line bg-surface/80"
            }`} role="status">
              {t(`pages.focus.stateLabel.${governanceState}`)}
            </span>
          </div>
          <div className="text-ink-2 text-[13px] leading-relaxed mt-1">{stateReason}</div>
          <div className="text-ink-4 text-[13px] leading-relaxed mt-1">
            <span className="font-medium">{t("pages.focus.nextActionLabel")}</span>{" "}{nextAction}
          </div>
        </div>
      ) : null}

      {/* Queue-derived widgets render only in legacy mode — in experience mode
          their inputs would be stale zeros, which would misinform (SPEC §14.2). */}
      {!experienceMode && (
        <>
      {/* Prose summary — one line, tabular nums */}
      <ProseSummary
        pendingCount={pendingCount}
        deviationCount={deviationCount}
        stagnationCount={stagnationCount}
        evidenceCount={evidenceCount}
      />

      {/* Wave 4: Feedback stratification — three timescale layers */}
      <FeedbackStratification
        gateBlocksToday={gateBlocksToday}
        inProgressCount={evidenceCount}
        pendingCount={pendingCount}
      />

      {/* State-specific guides — PRI-332: distinguish healthy empty from degraded */}
      {!experienceMode && governanceState === "none" && pendingCount === 0 && deviationCount === 0 && stagnationCount === 0 && (
        stateReasonCode === "state_db_missing" ? (
          <ZeroStateDbMissing />
        ) : (
          <>
            <ZeroStateHealthy />
            <div className="mt-4">
              <OnboardingGuide />
            </div>
          </>
        )
      )}

      {governanceState === "in_progress" && inProgressSummary && (
        <InProgressGuide summary={inProgressSummary} />
      )}

      {/* PRI-332: Always show degraded signals when present, regardless of governance state.
          Don't hide degraded sources behind state-specific guides (ERR-002). */}
      {degradedSignals && degradedSignals.length > 0 && (
        <DegradedSummary signals={degradedSignals} />
      )}
        </>
      )}

      {experienceMode && experienceData !== null && experienceData.summary.primaryAttention === "all_clear" && !sourcesUncertain && workItems.length === 0 && (
        <div className="mt-4">
          <OnboardingGuide />
        </div>
      )}

      {/* Layer 2: Why — three sections with evidence summaries */}

      {/* Section 2: Behavior Deviations / Evidence (queue-derived; legacy mode only) */}
      {!experienceMode && (
      <section className="mt-8" aria-labelledby="section-deviation">
        <SectionTitle id="section-deviation">
          {evidenceCount > 0
            ? t("pages.focus.sectionEvidenceInProgress")
            : t("pages.focus.sectionDeviation")}
        </SectionTitle>

        {deviationCount > 0 ? (
          <>
            <div className="text-ink-2 text-sm mb-3">
              <span className="font-mono font-semibold text-ink">{deviationCount}</span>{" "}
              {t("pages.focus.deviationCount", { count: deviationCount })}
            </div>
            {/* Deviation disclaimer (F.2: no fake aggregation) */}
            <div className="text-ink-4 text-[13px] bg-surface/60 border-l-2 border-amber px-3 py-2 mb-4">
              {t("pages.focus.deviationDisclaimer")}
            </div>
            {/* Layer 3: Full trajectory — collapsed by default */}
            <details className="group">
              <summary className="text-gov text-[13px] cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2">
                {t("pages.focus.viewFullChain")}
              </summary>
              <div className="mt-2 pl-4 border-l-2 border-line text-ink-3 text-[13px]">
                {t("pages.focus.deviationDetailPending")}
              </div>
            </details>
          </>
        ) : evidenceCount > 0 ? (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.focus.evidenceInProgress", { count: evidenceCount })}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.focus.emptyDeviation")}
          </div>
        )}
      </section>
      )}

      {/* Section 3: System Signals (stagnation) — queue-derived; legacy mode only */}
      {!experienceMode && (
      <section className="mt-8" aria-labelledby="section-signals">
        <SectionTitle id="section-signals">
          {t("pages.focus.sectionSignals")}
        </SectionTitle>

        {stagnationSignals.length > 0 ? (
          <div className="space-y-[10px]">
            {stagnationSignals.map((signal) => (
              <StagnationSignalCard key={signal.principleId} signal={signal} />
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.focus.emptySignals")}
          </div>
        )}
      </section>
      )}

        </div>
      </details>

      {/* Reflection remains visible below the decision workspace, outside runtime history. */}
      <div className="mt-8"><DailyThoughtCard /></div>

      {/* Footer — one line (US-1.7) */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.focus.footer")}
      </footer>
      </div>
    </PageShell>
  );
}

/** Owner Decision Experience v1 inbox item — display-only (SPEC §11.1). */
function InboxItem({ item, t, note }: { item: OwnerDecisionInboxData['groups']['decision'][number]; t: (key: string, opts?: Record<string, unknown>) => string; note?: string }) {
  return (
    <div className="mb-2 rounded-[var(--radius-md)] border border-line p-3" data-testid="owner-inbox-item">
      <div className="flex flex-wrap items-baseline gap-2">
        <Link to={`/principles/${encodeURIComponent(item.principleId)}`} className="text-ink text-[13.5px] font-medium hover:underline">
          {item.learnedPrinciple.status === 'known'
            ? item.learnedPrinciple.text
            : item.learnedPrinciple.reasonText}
        </Link>
        <span className="font-mono text-[11px] text-ink-4 border border-line rounded-[2px] px-1.5 py-0.5">
          {t(`pages.focus.ownerInbox.group.${item.inbox.group}`)}
        </span>
      </div>
      {/* Review round (P3): unmatched entries have NO action surface, so the
          inbox's review-flavored ownerText ("choose approve or reject") would
          promise actions that do not exist here — use the neutral note. */}
      <p className="mt-1 text-ink-3 text-[12.5px] leading-relaxed">{note ?? item.nextAction.ownerText}</p>
    </div>
  );
}
