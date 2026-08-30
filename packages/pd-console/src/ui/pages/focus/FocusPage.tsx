import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { DailyThoughtCard } from "../../components/focus/daily-thought-card.js";
import { ShinyText } from "../../components/ui/shiny-text.js";
import {
  fetchGovernanceQueue,
  fetchApprovalsGrouped,
  approveApproval,
  rejectApproval,
  editApproval,
  fetchAllActivations,
  fetchOwnerDecisions,
} from "../../api.js";
import type {
  GovernanceQueueData,
  ApprovalsGroupedData,
  ApprovalGroup,
  StagnationSignal,
  DegradedSignal,
  ActivationRecord,
} from "../../api.js";
import type { OwnerDecisionItemData } from "../../utils/validators.js";
import { OwnerDecisionCard } from "./OwnerDecisionCard.js";
import { fetchGovernanceExperience } from "../../api.js";
import type {
  GovernanceExperienceSnapshot,
  GovernanceExperienceReasonCode,
  GovernanceExperienceNextActionCode,
  GovernancePrimaryAttention,
  WorkspaceEnvironment,
  GovernanceActivityCategorySummary,
} from "@principles/core/runtime-v2";

type DecisionResult =
  | { success: true }
  | { success: false; error: string; nextAction?: string };

export function summarizeDecisionResults(results: readonly DecisionResult[]): {
  allSucceeded: boolean;
  failedCount: number;
  failureReason?: string;
} {
  const failures = results.filter((result): result is Extract<DecisionResult, { success: false }> => !result.success);
  const first = failures[0];
  return {
    allSucceeded: failures.length === 0,
    failedCount: failures.length,
    ...(first
      ? { failureReason: first.nextAction ? `${first.error} ${first.nextAction}` : first.error }
      : {}),
  };
}

// ── Approval group validator (not in validators.ts, page-specific) ─────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateApprovalGroup(raw: unknown): ApprovalGroup | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "principleId") ||
    !Object.hasOwn(raw, "principleTitle") ||
    !Object.hasOwn(raw, "status") ||
    !Object.hasOwn(raw, "records")
  ) {
    return null;
  }
  const principleId = raw.principleId;
  const principleTitle = raw.principleTitle;
  const status = raw.status;
  const records = raw.records;
  if (
    typeof principleId !== "string" ||
    typeof principleTitle !== "string" ||
    typeof status !== "string" ||
    !["pending", "approved", "rejected"].includes(status) ||
    !Array.isArray(records)
  ) {
    return null;
  }
  const validRecords: ApprovalGroup["records"] = [];
  for (const r of records) {
    if (!isRecord(r)) return null;
    if (
      !Object.hasOwn(r, "id") ||
      !Object.hasOwn(r, "artifactId") ||
      !Object.hasOwn(r, "channel") ||
      !Object.hasOwn(r, "createdAt") ||
      !Object.hasOwn(r, "status") ||
      typeof r.id !== "string" ||
      typeof r.artifactId !== "string" ||
      typeof r.channel !== "string" ||
      typeof r.createdAt !== "string" ||
      typeof r.status !== "string"
    ) {
      return null;
    }
    validRecords.push({
      id: r.id,
      artifactId: r.artifactId,
      channel: r.channel,
      createdAt: r.createdAt,
      status: r.status,
    });
  }
  // Wave 7: candidateDescription is optional — present when backend could
  // extract human-readable content from the artifact contentJson.
  // ERR-009: if field exists but is wrong type, fail loud (return null).
  let candidateDescription: string | undefined;
  if (Object.hasOwn(raw, "candidateDescription")) {
    if (typeof raw.candidateDescription !== "string") return null;
    candidateDescription = raw.candidateDescription;
  }
  return {
    principleId,
    principleTitle,
    candidateDescription,
    status: status as "pending" | "approved" | "rejected",
    records: validRecords,
  };
}

function validateApprovalsGroupedData(raw: unknown): ApprovalsGroupedData | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "groups") ||
    !Object.hasOwn(raw, "generatedAt")
  ) {
    return null;
  }
  const groups = raw.groups;
  const generatedAt = raw.generatedAt;
  if (!Array.isArray(groups) || typeof generatedAt !== "string") {
    return null;
  }
  const validatedGroups: ApprovalGroup[] = [];
  for (const g of groups) {
    const validated = validateApprovalGroup(g);
    if (validated === null) return null;
    validatedGroups.push(validated);
  }
  return {
    groups: validatedGroups,
    generatedAt,
    note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined,
  };
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

// ── Channel label helper ─────────────────────────────────────────────────────

function getChannelLabel(channel: string, t: (key: string) => string): string {
  switch (channel) {
    case "prompt":
      return t("pages.focus.channelPrompt");
    case "defer_archive":
      return t("pages.focus.channelDeferArchive");
    case "code_tool_hook":
      return t("pages.focus.channelCodeToolHook");
    default:
      return channel;
  }
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

function PendingReviewCard({
  group,
  onDecisionApplied,
}: {
  group: ApprovalGroup;
  onDecisionApplied: () => void;
}) {
  const { t } = useTranslation();
  const primaryChannel = group.records[0]?.channel ?? "prompt";
  const channelLabel = getChannelLabel(primaryChannel, t);
  const isReversible = primaryChannel === "prompt" || primaryChannel === "defer_archive";

  // Inline review state (Wave 7: no more 404 jump to /principles/<fake-id>)
  const [actionLoading, setActionLoading] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showEditInput, setShowEditInput] = useState(false);
  const [editReason, setEditReason] = useState("");
  const [newArtifactId, setNewArtifactId] = useState("");

  const isActionable = group.status === "pending" && group.records.some((r) => r.status === "pending");

  // Display title: prefer candidateDescription (human-readable) over principleTitle
  // (which falls back to a fabricated principleId when the principle isn't in ledger).
  const displayTitle = group.candidateDescription
    ?? group.principleTitle
    ?? t("pages.focus.untitledCandidate", { defaultValue: "待命名候选原则" });

  async function applyDecisionToAllRecords(
    action: "approve" | "reject",
    reason?: string,
  ): Promise<{ allSucceeded: boolean; failedCount: number; totalCount: number; failureReason?: string }> {
    // Only process pending records — skip already-approved/rejected to avoid
    // stable partial failures on mixed-status groups.
    const pendingRecords = group.records.filter((r) => r.status === "pending");
    const results: DecisionResult[] = [];
    for (const record of pendingRecords) {
      const result =
        action === "approve"
          ? await approveApproval(record.id)
          : await rejectApproval(record.id, reason ?? "");
      results.push(result);
    }
    return { ...summarizeDecisionResults(results), totalCount: pendingRecords.length };
  }

  const handleApprove = async () => {
    if (!isActionable || actionLoading) return;
    setActionLoading(true);
    try {
      const { allSucceeded, failedCount, totalCount, failureReason } = await applyDecisionToAllRecords("approve");
      if (allSucceeded) {
        toast.success(t("pages.focus.approveSucceeded", { defaultValue: "已批准" }));
        onDecisionApplied();
      } else {
        toast.error(
          t("pages.focus.partialFailure", {
            defaultValue: `批准完成，但 ${failedCount}/${totalCount} 条记录失败。`,
            failedCount,
            totalCount,
            reason: failureReason ?? t("pages.focus.unknownFailure", { defaultValue: "请检查服务日志。" }),
          }),
        );
        onDecisionApplied();
      }
    } catch {
      toast.error(t("pages.focus.approveFailed", { defaultValue: "批准失败，请稍后重试。" }));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!isActionable || actionLoading || !rejectReason.trim()) return;
    setActionLoading(true);
    try {
      const { allSucceeded, failedCount, totalCount, failureReason } = await applyDecisionToAllRecords("reject", rejectReason.trim());
      if (allSucceeded) {
        toast.success(t("pages.focus.rejectSucceeded", { defaultValue: "已拒绝" }));
        setShowRejectInput(false);
        setRejectReason("");
        onDecisionApplied();
      } else {
        toast.error(
          t("pages.focus.partialFailure", {
            defaultValue: `拒绝完成，但 ${failedCount}/${totalCount} 条记录失败。`,
            failedCount,
            totalCount,
            reason: failureReason ?? t("pages.focus.unknownFailure", { defaultValue: "请检查服务日志。" }),
          }),
        );
        onDecisionApplied();
      }
    } catch {
      toast.error(t("pages.focus.rejectFailed", { defaultValue: "拒绝失败，请稍后重试。" }));
    } finally {
      setActionLoading(false);
    }
  };

  const currentArtifactId = group.records.find((r) => r.status === "pending")?.artifactId ?? "";

  const handleEdit = async () => {
    if (!isActionable || actionLoading || !editReason.trim() || !newArtifactId.trim()) return;
    setActionLoading(true);
    try {
      const pendingRecords = group.records.filter((r) => r.status === "pending");
      const results: DecisionResult[] = [];
      for (const record of pendingRecords) {
        const result = await editApproval(record.id, newArtifactId.trim(), editReason.trim());
        results.push(
          result.success
            ? { success: true }
            : { success: false, error: result.error, nextAction: result.nextAction },
        );
      }
      const { allSucceeded, failedCount, failureReason } = summarizeDecisionResults(results);
      const totalCount = results.length;
      if (allSucceeded) {
        toast.success(t("pages.focus.editSucceeded", { defaultValue: "已保存修订" }));
        setShowEditInput(false);
        setEditReason("");
        setNewArtifactId("");
        onDecisionApplied();
      } else {
        toast.error(
          t("pages.focus.partialFailure", {
            defaultValue: `编辑完成，但 ${failedCount}/${totalCount} 条记录失败。`,
            failedCount,
            totalCount,
            reason: failureReason ?? t("pages.focus.unknownFailure", { defaultValue: "请检查服务日志。" }),
          }),
        );
        onDecisionApplied();
      }
    } catch {
      toast.error(t("pages.focus.editFailed", { defaultValue: "编辑失败，请稍后重试。" }));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <article className="relative pl-[22px] py-[18px] pr-[18px] bg-panel border border-line rounded-[6px] transition-colors">
      {/* Left border indicator */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[6px] bg-gov" />

      {/* Tags row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
          {channelLabel}
        </span>
        {isReversible && (
          <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {primaryChannel === "prompt" ? t("pages.focus.tagReversible") : t("pages.focus.tagLowRisk")}
          </span>
        )}
      </div>

      {/* Title — human-readable candidate description, NOT the fabricated principleId */}
      <div className="mt-[14px] mb-2 font-semibold text-ink leading-snug">
        {displayTitle}
      </div>

      {/* Evidence summary (inset well) */}
      <div className="mt-2 px-3 py-2 bg-surface/60 border-l-2 border-gov text-ink-3 text-[13px] leading-snug">
        {t("pages.focus.evidenceSummary", { count: group.records.length })}
      </div>

      {/* Inline review actions (Wave 7: no more 404 jump) */}
      <div className="flex gap-2 mt-4 flex-wrap items-center">
        <button
          type="button"
          onClick={handleApprove}
          disabled={!isActionable || actionLoading}
          data-testid={`approve-btn-${group.principleId}`}
          className="inline-flex items-center border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {actionLoading ? t("common.loading") + "…" : t("pages.focus.approveAction", { defaultValue: "批准" })}
        </button>
        <button
          type="button"
          onClick={() => { setShowEditInput((v) => !v); setShowRejectInput(false); }}
          disabled={!isActionable || actionLoading}
          data-testid={`edit-btn-${group.principleId}`}
          className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.focus.editAction", { defaultValue: "编辑" })}
        </button>
        <button
          type="button"
          onClick={() => { setShowRejectInput((v) => !v); setShowEditInput(false); }}
          disabled={!isActionable || actionLoading}
          data-testid={`reject-btn-${group.principleId}`}
          className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.focus.rejectAction", { defaultValue: "拒绝" })}
        </button>
        <Link
          to="/evidence"
          className="inline-flex items-center text-gov text-[12.5px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.focus.viewFullChain")}
        </Link>
      </div>

      {/* Rejection reason input (inline, not dialog) */}
      {showRejectInput && (
        <div className="mt-3 p-3 border border-danger/20 rounded-[var(--radius-md)]">
          <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
            {t("pages.focus.rejectReasonLabel", { defaultValue: "拒绝原因（必填）" })}
          </label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            data-testid={`reject-reason-${group.principleId}`}
            placeholder={t("pages.focus.rejectReasonPlaceholder", { defaultValue: "请说明拒绝原因" })}
            className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] min-h-[80px] resize-y focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
          />
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={handleReject}
              disabled={!rejectReason.trim() || actionLoading}
              data-testid={`confirm-reject-${group.principleId}`}
              className="inline-flex items-center border border-danger text-danger bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-danger/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("pages.focus.confirmReject", { defaultValue: "确认拒绝" })}
            </button>
            <button
              type="button"
              onClick={() => { setShowRejectInput(false); setRejectReason(""); }}
              className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors"
            >
              {t("pages.focus.cancelAction", { defaultValue: "取消" })}
            </button>
          </div>
        </div>
      )}

      {/* Edit revision input (inline, not dialog) */}
      {showEditInput && (
        <div className="mt-3 p-3 border border-gov/20 rounded-[var(--radius-md)]">
          <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
            {t("pages.focus.editReasonLabel", { defaultValue: "编辑原因（必填）" })}
          </label>
          <div className="mb-2 text-ink-4 text-[12px] font-mono">
            {t("pages.focus.currentArtifactLabel", { defaultValue: "当前工件" })}: {currentArtifactId}
          </div>
          <input
            type="text"
            value={newArtifactId}
            onChange={(e) => setNewArtifactId(e.target.value)}
            data-testid={`edit-new-artifact-${group.principleId}`}
            placeholder={t("pages.focus.editNewArtifactPlaceholder", { defaultValue: "输入新的已验证工件 ID" })}
            className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] mb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
            aria-label={t("pages.focus.editNewArtifactPlaceholder", { defaultValue: "输入新的已验证工件 ID" })}
          />
          <textarea
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
            data-testid={`edit-reason-${group.principleId}`}
            placeholder={t("pages.focus.editReasonPlaceholder", { defaultValue: "请说明编辑原因" })}
            className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] min-h-[80px] resize-y focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
          />
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={handleEdit}
              disabled={!editReason.trim() || !newArtifactId.trim() || actionLoading}
              data-testid={`confirm-edit-${group.principleId}`}
              className="inline-flex items-center border border-gov text-gov bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-gov/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("pages.focus.confirmEdit", { defaultValue: "确认编辑" })}
            </button>
            <button
              type="button"
              onClick={() => { setShowEditInput(false); setEditReason(""); setNewArtifactId(""); }}
              className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors"
            >
              {t("pages.focus.cancelAction", { defaultValue: "取消" })}
            </button>
          </div>
        </div>
      )}
    </article>
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
  const [copiedCommandIdx, setCopiedCommandIdx] = useState<number | null>(null);
  const attention = EXPERIENCE_ATTENTION[snapshot.summary.primaryAttention];
  const categoryOf = (category: GovernanceActivityCategorySummary["category"]) =>
    snapshot.activity.categories.find(entry => entry.category === category);
  const decision = categoryOf("needs_decision");
  const recovery = categoryOf("needs_recovery");
  const blocked = categoryOf("blocked");
  const processing = categoryOf("processing");
  const actionOf = (kind: GovernanceExperienceSnapshot["readiness"]["governanceActions"][number]["kind"]) =>
    snapshot.readiness.governanceActions.find(action => action.kind === kind);
  const rulecodeAction = actionOf("rulecode_owner_decision");
  const pauseAction = actionOf("emergency_pause");
  const firstIssue = snapshot.dataQuality.issueGroups[0];
  const ownerGuide = deriveOwnerConfigureGuide(snapshot.readiness.ownerIdentityConfiguration);
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
      <div className="mt-2 text-[12px] text-ink-4 leading-relaxed" data-testid="experience-readiness">
        {t(`pages.focus.experience.readiness.identity.${snapshot.readiness.ownerIdentityConfiguration}`)}
        {" · "}
        {t("pages.focus.experience.readiness.principleApproval")}
        {t(`pages.focus.experience.readiness.rulecode.${rulecodeAction?.status === "blocked" ? "blocked" : "ready"}`)}
        {t(`pages.focus.experience.readiness.pause.${pauseAction?.observedAuthority === "break_glass" ? "breakGlass" : "owner"}`)}
      </div>
      {ownerGuide !== null && (
        <div className="mt-3 border border-line rounded-[6px] bg-panel px-3 py-2.5" data-testid="owner-configure-guide">
          <div className="text-[13px] font-medium">{t("pages.focus.experience.ownerGuide.title")}</div>
          <div className="mt-0.5 text-[12px] text-ink-3 leading-relaxed">{t("pages.focus.experience.ownerGuide.intro")}</div>
          <div className="mt-2 space-y-2">
            {ownerGuide.commands.map((cmd, idx) => (
              <div key={cmd.labelKey} className="border border-line rounded-[4px] overflow-hidden bg-surface">
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="font-mono text-[11px] uppercase text-ink-3">{t(cmd.labelKey)}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(cmd.command);
                        setCopiedCommandIdx(idx);
                        setTimeout(() => setCopiedCommandIdx(null), 2000);
                      } catch (error) {
                        // clipboard unavailable — keep the command visible as fallback
                        console.warn("Owner configure command copy failed.", error);
                      }
                    }}
                    className="font-mono text-[11px] text-gov hover:text-gov-2"
                  >
                    {copiedCommandIdx === idx
                      ? t("pages.focus.experience.ownerGuide.copied")
                      : t("pages.focus.experience.ownerGuide.copy")}
                  </button>
                </div>
                <pre className="px-2.5 pb-2 pt-0.5 text-[11px] font-mono text-ink-2 leading-relaxed overflow-x-auto whitespace-pre-wrap">
                  {cmd.command}
                </pre>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-amber leading-relaxed" data-testid="owner-guide-token-auth-hint">
            {t("pages.focus.experience.ownerGuide.tokenAuthHint")}
          </p>
          <a
            href={ownerGuide.docUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[12px] text-gov underline hover:text-gov-2"
          >
            {t("pages.focus.experience.ownerGuide.docLink")}
          </a>
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

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setGroupedErrorReason(null);
    setRuleCodeErrorReason(null);

    const [experienceResult, queueResult, groupedResult, activationsResult] = await Promise.all([
      experienceMode ? fetchGovernanceExperience() : Promise.resolve(null),
      experienceMode ? Promise.resolve(null) : fetchGovernanceQueue(),
      fetchApprovalsGrouped(),
      fetchAllActivations(),
    ]);

    if (experienceMode) {
      if (experienceResult === null || !experienceResult.success) {
        setLoadingState("error");
        setErrorMessage(experienceResult === null ? t("pages.focus.experience.error.snapshotUnavailable") : experienceResult.error);
        return;
      }
      setExperienceData(experienceResult.data);
      setQueueData(null);
    } else {
      // Queue data is already validated by the API layer (validateGovernanceQueue)
      if (queueResult === null || !queueResult.success) {
        setLoadingState("error");
        setErrorMessage(queueResult === null ? t("pages.focus.loadError") : queueResult.error);
        return;
      }
      setQueueData(queueResult.data);
      setExperienceData(null);
    }

    // Validate grouped data (ERR-002: degradation with reason)
    if (!groupedResult.success) {
      setGroupedData(null);
      setGroupedErrorReason(groupedResult.error ?? "Approvals data unavailable");
    } else {
      const validatedGrouped = validateApprovalsGroupedData(groupedResult.data);
      setGroupedData(validatedGrouped);
      if (validatedGrouped === null) {
        setGroupedErrorReason("Approvals data has unexpected shape");
      }
    }
    if (activationsResult.success) {
      setRuleCodeItems(
        activationsResult.data.activations.filter(
          (item) => item.channel === "code_tool_hook" && item.status === "active",
        ),
      );
    } else {
      setRuleCodeItems([]);
      setRuleCodeErrorReason(activationsResult.error);
    }

    // PRI-629: 统一 Owner Inbox (decision-capable NHR + approvals + rulecode)。
    // 投影失败不阻塞页面 (rc-9 降级 — 显示原因,治理摘要仍可用)。
    const decisionsResult = await fetchOwnerDecisions();
    if (decisionsResult.success) {
      setOwnerDecisionItems(decisionsResult.data.items);
      setOwnerDecisionError(null);
    } else {
      setOwnerDecisionItems([]);
      setOwnerDecisionError(decisionsResult.error ?? "Owner decisions unavailable");
    }

    setLoadingState("loaded");
  }, [experienceMode, t]);

  useEffect(() => {
    if (!flagsResolved) return;
    loadData();
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

  // Map codes to i18n text
  // Governance Recovery Actions v1: tasks_need_human_review interpolates the
  // needs_human_review task count, not the approvals count.
  const humanReviewCount = queueData?.pendingHumanReviewCount ?? 0;
  const stateReasonCount = stateReasonCode === "tasks_need_human_review" ? humanReviewCount : pendingCount;
  const stateReason = getStateReasonText(stateReasonCode, t, stateReasonCount);
  const nextAction = getNextActionText(nextActionCode, t);

  return (
    <PageShell>
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
        {t("pages.focus.title")}
      </ShinyText>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.focus.subtitle")}
      </p>

      {/* Governance summary — single source: experience snapshot when the flag
          is on (PRI-586), legacy queue panel otherwise. Never both. */}
      {experienceMode && experienceData !== null ? (
        <ExperienceSummaryCard snapshot={experienceData} />
      ) : !experienceMode ? (
      <div className="mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]">
        <div className="flex items-center gap-2 mb-1">
          {/* State badge */}
          <span
            className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
              governanceState === "owner_review_ready"
                ? "bg-gov/10 text-gov border border-gov/20"
                : governanceState === "degraded"
                  ? "bg-amber/10 text-amber border border-amber/20"
                  : governanceState === "in_progress"
                    ? "bg-green/10 text-green border border-green/20"
                    : "text-ink-4 border border-line bg-surface/80"
            }`}
            role="status"
          >
            {t(`pages.focus.stateLabel.${governanceState}`)}
          </span>
        </div>
        <div className="text-ink-2 text-[13px] leading-relaxed mt-1">
          {stateReason}
        </div>
        <div className="text-ink-4 text-[13px] leading-relaxed mt-1">
          <span className="font-medium">{t("pages.focus.nextActionLabel")}</span>{" "}
          {nextAction}
        </div>
      </div>
      ) : null}

      {/* PRI-629: 需要你决定 — 统一 Owner Inbox。两种治理摘要模式下都渲染;
          N = 真实可执行决策数 (INV-01),不是 lifecycle/NHR/failed 计数。 */}
      <section aria-label={t("pages.focus.ownerDecision.sectionTitle")} className="mb-7" data-testid="owner-decisions-section">
        <div className="flex items-baseline gap-2 mb-3">
          <SectionTitle>{t("pages.focus.ownerDecision.sectionTitle")}</SectionTitle>
          <span className="font-mono text-ink-4 text-[12px]">
            {ownerDecisionError !== null
              ? t("pages.focus.ownerDecision.unavailable")
              : `· ${ownerDecisionItems.length}`}
          </span>
        </div>
        {ownerDecisionError !== null && (
          <p className="text-ink-4 text-[12.5px]">{t("pages.focus.ownerDecision.loadError")}</p>
        )}
        {ownerDecisionError === null && ownerDecisionItems.length === 0 && (
          <p className="text-ink-4 text-[13px]">{t("pages.focus.ownerDecision.empty")}</p>
        )}
        {ownerDecisionItems.map((item) => (
          <OwnerDecisionCard
            key={item.reviewKey}
            item={item}
            onResolved={() => { void loadData(); }}
          />
        ))}
      </section>

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

      {/* Daily thought — pause before judgment (reflection content, not governance status).
          Intentionally retained in BOTH modes: this PR migrates only the governance STATUS
          source; whether reflection stays on Focus after graduation is PRI-589
          (Focus Information Architecture Cleanup). */}
      <DailyThoughtCard />

      {experienceMode && experienceData !== null && experienceData.summary.primaryAttention === "all_clear" && pendingGroups.length === 0 && (
        <div className="mt-4">
          <OnboardingGuide />
        </div>
      )}

      {/* Layer 2: Why — three sections with evidence summaries */}

      {(ruleCodeErrorReason || ruleCodePending.length > 0 || ruleCodeAlerts.length > 0) && (
        <section className="mt-8" aria-labelledby="section-rulecode-owner">
          <SectionTitle id="section-rulecode-owner">{t("pages.focus.ruleCodeOwnerQueue")}</SectionTitle>
          {ruleCodeErrorReason && (
            <div className="mb-3 rounded border border-amber/30 bg-panel p-4 text-[12px] text-ink-3">
              <div className="font-medium text-amber">{t("pages.focus.ruleCodeUnavailable")}</div>
              <div className="mt-1 font-mono">{ruleCodeErrorReason}</div>
              <div className="mt-1">{t("pages.focus.ruleCodeUnavailableNextAction")}</div>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {ruleCodePending.length > 0 && (
              <Link to="/activation" className="rounded border border-gov/30 bg-panel p-4 hover:border-gov">
                <div className="font-medium text-ink">{t("pages.focus.ruleCodePending")}</div>
                <div className="mt-1 text-[12px] text-ink-3">
                  {t("pages.focus.ruleCodePendingCount", { count: ruleCodePending.length })}
                </div>
              </Link>
            )}
            {ruleCodeAlerts.length > 0 && (
              <Link to="/activation" className="rounded border border-danger/30 bg-panel p-4 hover:border-danger">
                <div className="font-medium text-danger">{t("pages.focus.ruleCodeAlerts")}</div>
                <div className="mt-1 text-[12px] text-ink-3">
                  {t("pages.focus.ruleCodeAlertCount", { count: ruleCodeAlerts.length })}
                </div>
              </Link>
            )}
          </div>
        </section>
      )}

      {/* Section 1: Pending Review */}
      <section id="section-pending" className="mt-8" aria-labelledby="section-pending">
        <SectionTitle id="section-pending">
          {t("pages.focus.sectionPending")}
        </SectionTitle>

        {pendingGroups.length > 0 ? (
          <div className="space-y-[14px]">
            {pendingGroups.map((group) => (
              <PendingReviewCard key={group.principleId} group={group} onDecisionApplied={loadData} />
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {approvalDataUnavailable
              ? (groupedErrorReason
                ? `${t("pages.focus.loadError")} (${groupedErrorReason})`
                : t("pages.focus.loadError"))
              : t("pages.focus.emptyPending")}
          </div>
        )}
      </section>

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

      {/* Footer — one line (US-1.7) */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.focus.footer")}
      </footer>
      </div>
    </PageShell>
  );
}
