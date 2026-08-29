import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import {
  fetchPrincipleDetail,
  fetchApprovalsGrouped,
  fetchLifecycleMetrics,
  fetchPrincipleTrajectory,
  fetchPrincipleGovernance,
  fetchPrincipleReceipts,
  approveApproval,
  rejectApproval,
  editApproval,
} from "../../api.js";
import type { PrincipleReceiptsData } from "../../api.js";
import { ReceiptCoverageDisclosure, getReceiptSourceStatusLabelKey } from "../../components/receipts/ReceiptCoverageDisclosure.js";
import { formatDate } from "../../utils/format-date.js";
import type { OwnerGovernanceView } from '@principles/core/runtime-v2';
import type {
  PrincipleDetail,
  PrincipleDetailData,
  ApprovalGroup,
  ApprovalsGroupedData,
  LifecycleMetricsData,
  TrajectoryData,
  TrajectoryStageData,
} from "../../api.js";

// ── Runtime validation (H section) ──────────────────────────────────────────
function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isString);
}

function safeString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Validate and normalize a PrincipleDetail from untrusted network data.
 * Returns a normalized object with safe defaults for all fields the page
 * actually accesses. Never returns null for individual fields — only for
 * completely unparseable top-level structures.
 *
 * Fields the page uses: id, text, status, triggerPattern, action,
 * derivedFromPainIds (length + map), rules (length).
 */
function validatePrincipleDetail(data: unknown): PrincipleDetailData | null {
  if (!isRecord(data)) return null;
  if (!Object.hasOwn(data, "principle") || !isRecord(data.principle)) return null;
  const raw = data.principle;

  // Required fields — fail loud if missing
  if (!Object.hasOwn(raw, "id") || !isString(raw.id)) return null;
  if (!Object.hasOwn(raw, "text") || !isString(raw.text)) return null;
  if (!Object.hasOwn(raw, "status") || !isString(raw.status)) return null;

  // Normalize fields the page accesses with safe defaults
  const normalized: Record<string, unknown> = {
    ...raw,
    triggerPattern: safeString(raw.triggerPattern),
    action: safeString(raw.action),
    derivedFromPainIds: safeStringArray(raw.derivedFromPainIds),
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };

  return { principle: normalized } as unknown as PrincipleDetailData;
}

function validateApprovalsGrouped(data: unknown): ApprovalsGroupedData | null {
  if (!isRecord(data)) return null;
  if (!Object.hasOwn(data, "groups") || !Array.isArray(data.groups)) return null;
  for (const g of data.groups) {
    if (!isRecord(g)) return null;
    if (!Object.hasOwn(g, "principleId") || !isString(g.principleId)) return null;
    if (!Object.hasOwn(g, "status") || !isString(g.status)) return null;
    if (!Object.hasOwn(g, "records") || !Array.isArray(g.records)) return null;
    for (const r of g.records) {
      if (!isRecord(r)) return null;
      if (!Object.hasOwn(r, "id") || !isString(r.id)) return null;
      if (!Object.hasOwn(r, "channel") || !isString(r.channel)) return null;
    }
  }
  return data as unknown as ApprovalsGroupedData;
}

function validateLifecycleMetrics(data: unknown): LifecycleMetricsData | null {
  if (!isRecord(data)) return null;
  if (!Object.hasOwn(data, "adherence") || !isRecord(data.adherence)) return null;
  const a = data.adherence;
  if (!Object.hasOwn(a, "insufficientData") || typeof a.insufficientData !== "boolean") return null;
  if (!Object.hasOwn(a, "note") || !isString(a.note)) return null;
  // rate can be number or null
  if (Object.hasOwn(a, "rate") && a.rate !== null && typeof a.rate !== "number") return null;
  if (!Object.hasOwn(data, "ruleMetrics") || !Array.isArray(data.ruleMetrics)) return null;
  return data as unknown as LifecycleMetricsData;
}

// ── Trajectory stage labels (i18n key mapping) ─────────────────────────────
const STAGE_LABEL_KEYS: Record<string, string> = {
  evidence: "principles.detail.stageEvidence",
  diagnosis: "principles.detail.stageDiagnosis",
  proposal: "principles.detail.stageProposal",
  review: "principles.detail.stageReview",
  deploy: "principles.detail.stageDeploy",
  behavior: "principles.detail.stageBehavior",
};

// ── Component ───────────────────────────────────────────────────────────────
export function getReceiptPresentation(effectCount: number): {
  headlineKey: 'principles.detail.receipts.headline' | 'principles.detail.receipts.headlinePresence';
  showZeroEffectExplanation: boolean;
} {
  return effectCount > 0
    ? { headlineKey: 'principles.detail.receipts.headline', showZeroEffectExplanation: false }
    : { headlineKey: 'principles.detail.receipts.headlinePresence', showZeroEffectExplanation: true };
}

// ── Governance control gating (PRI-582) ─────────────────────────────────────
// The governance projection is the authority for rendering Owner decision
// controls. When it cannot authorize them, the controls must not silently
// vanish: every blocked path carries a reason and, when known, a next action
// (ERR-002). The blocked reason is derived here as a pure function so the
// truth table is testable without mounting the component (UI tests run in
// node-env, no jsdom).
export type GovernanceControlBlock =
  | { source: 'server'; reason: string; nextAction?: string }
  | { source: 'i18n'; reasonKey: string; nextActionKey?: string };

export const GOVERNANCE_BLOCK_I18N_KEYS = {
  recoveryReason: 'principles.detail.governance.reason.recovery_required',
  recoveryNextAction: 'principles.detail.governance.next.inspect_recovery',
  noDecisionReason: 'principles.detail.governance.actionsNotAuthorized',
  nextActionLabel: 'principles.detail.governance.nextActionLabel',
} as const;

/**
 * Returns `null` when decision controls may render; otherwise the reason they
 * must stay hidden.
 */
export function deriveGovernanceControlBlock(input: {
  governance: { attention: { primary: 'none' | 'owner_required' | 'recovery_required' } } | null;
  governanceUnavailable: { reason: string; nextAction?: string } | null;
}): GovernanceControlBlock | null {
  const { governance, governanceUnavailable } = input;

  if (governance === null) {
    // Flag-off keeps the pre-projection experience: controls stay available and
    // no blocked notice is shown (ERR-102: disabled ≠ unavailable).
    if (governanceUnavailable === null) return null;
    return governanceUnavailable.nextAction === undefined
      ? { source: 'server', reason: governanceUnavailable.reason }
      : { source: 'server', reason: governanceUnavailable.reason, nextAction: governanceUnavailable.nextAction };
  }

  if (governance.attention.primary === 'owner_required') return null;

  if (governance.attention.primary === 'recovery_required') {
    return {
      source: 'i18n',
      reasonKey: GOVERNANCE_BLOCK_I18N_KEYS.recoveryReason,
      nextActionKey: GOVERNANCE_BLOCK_I18N_KEYS.recoveryNextAction,
    };
  }

  return { source: 'i18n', reasonKey: GOVERNANCE_BLOCK_I18N_KEYS.noDecisionReason };
}

export function PrincipleDetailPage() {
  const { t, i18n } = useTranslation("pages");
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [principle, setPrinciple] = useState<PrincipleDetail | null>(null);
  const [approvalGroup, setApprovalGroup] = useState<ApprovalGroup | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleMetricsData | null>(null);
  const [trajectory, setTrajectory] = useState<TrajectoryData | null>(null);
  const [governance, setGovernance] = useState<OwnerGovernanceView | null>(null);
  const [governanceUnavailable, setGovernanceUnavailable] = useState<{ reason: string; nextAction?: string } | null>(null);
  const [receipts, setReceipts] = useState<PrincipleReceiptsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Decision state
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showEditInput, setShowEditInput] = useState(false);
  const [editReason, setEditReason] = useState("");
  const [newArtifactId, setNewArtifactId] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Evidence ID copy state (Wave 6: stop showing raw UUIDs as primary content)
  const [evidenceCopied, setEvidenceCopied] = useState(false);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);

  // Fetch data
  const loadData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setApprovalGroup(null); // Clear previous approval group to prevent stale actionability (P1)
    setGovernance(null);
    setGovernanceUnavailable(null);
    setReceipts(null);
    try {
      const [pResult, aResult, lResult, tResult, gResult, rResult] = await Promise.all([
        fetchPrincipleDetail(id),
        fetchApprovalsGrouped(),
        fetchLifecycleMetrics(id),
        fetchPrincipleTrajectory(id),
        fetchPrincipleGovernance(id),
        fetchPrincipleReceipts(id),
      ]);

      if (!pResult.success) {
        setError(pResult.error ?? "Failed to load principle");
        return;
      }

      const pData = validatePrincipleDetail(pResult.data);
      if (!pData) {
        setError("Invalid principle data received");
        return;
      }
      setPrinciple(pData.principle);

      const aData = aResult.success ? validateApprovalsGrouped(aResult.data) : null;
      if (aData) {
        const group = aData.groups.find((g) => g.principleId === id);
        setApprovalGroup(group ?? null);
      } else {
        setApprovalGroup(null);
      }

      const lData = lResult.success ? validateLifecycleMetrics(lResult.data) : null;
      setLifecycle(lData);

      // Trajectory — validated at request layer via validateTrajectoryData
      if (tResult.success && tResult.data) {
        setTrajectory(tResult.data);
      } else {
        setTrajectory(null);
      }

      if (gResult.success && gResult.data) {
        setGovernance(gResult.data);
      } else if (!gResult.success && gResult.reason !== 'feature_disabled') {
        setGovernanceUnavailable({ reason: gResult.error, ...(gResult.nextAction === undefined ? {} : { nextAction: gResult.nextAction }) });
      }

      // PRI-533: receipt history (degraded carries reason + nextAction)
      if (rResult.success && rResult.data) {
        setReceipts(rResult.data);
      } else {
        setReceipts(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setApprovalGroup(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Actions ─────────────────────────────────────────────────────────────
  // Actionable Approval Check (PRI-387)
  let isActionable = false;
  let reasonKey = "";
  let defaultReason = "";

  if (!approvalGroup) {
    reasonKey = "principles.detail.reasonDataUnavailable";
    defaultReason = "数据暂不可用";
  } else if (approvalGroup.status !== "pending") {
    reasonKey = "principles.detail.reasonAlreadyHandled";
    defaultReason = "已处理";
  } else if (approvalGroup.records.length === 0) {
    reasonKey = "principles.detail.reasonNoRecords";
    defaultReason = "暂无待审批记录";
  } else {
    const hasMvpChannel = approvalGroup.records.some(
      (r) => r.channel === "prompt" || r.channel === "defer_archive"
    );
    if (!hasMvpChannel) {
      reasonKey = "principles.detail.reasonUnsupportedChannel";
      defaultReason = "不是 MVP 支持通道";
    } else {
      isActionable = true;
    }
  }
  // PRI-582: the projection authorizes the decision controls. When it cannot,
  // controls are hidden together with a truthful reason instead of the generic
  // “no Owner decision is required” copy, which inverted the real cause.
  const governanceBlock = deriveGovernanceControlBlock({ governance, governanceUnavailable });
  const showDecisionControls = governanceBlock === null;
  if (!showDecisionControls) {
    isActionable = false;
  }
  const governanceBlockedNextAction =
    governanceBlock === null
      ? undefined
      : governanceBlock.source === 'server'
        ? governanceBlock.nextAction
        : governanceBlock.nextActionKey === undefined
          ? undefined
          : t(governanceBlock.nextActionKey);

  const handleApprove = () => {
    if (!isActionable) return;
    setShowConfirm(true);
  };
  const cancelConfirm = () => setShowConfirm(false);

  // ── Apply decision to all records in the group ──────────────────────────
  // Constraint: "多通道审批记录在 UI 上收拢成对一条原则的单次治理决策"
  // When owner approves/rejects a principle, ALL pending records must receive
  // the same decision. Partial failure is reported loudly (ERR-002 / EP-03).
  async function applyDecisionToAllRecords(
    action: "approve" | "reject",
    reason?: string,
  ): Promise<{ allSucceeded: boolean; failedCount: number; totalCount: number }> {
    if (!approvalGroup) return { allSucceeded: false, failedCount: 0, totalCount: 0 };

    const records = approvalGroup.records;
    let failedCount = 0;

    for (const record of records) {
      const result =
        action === "approve"
          ? await approveApproval(record.id)
          : await rejectApproval(record.id, reason ?? "");

      if (!result.success) {
        failedCount++;
      }
    }

    return {
      allSucceeded: failedCount === 0,
      failedCount,
      totalCount: records.length,
    };
  }

  const confirmApprove = async () => {
    if (!isActionable || !approvalGroup || actionLoading) return;
    setActionLoading(true);
    try {
      const { allSucceeded, failedCount, totalCount } = await applyDecisionToAllRecords("approve");
      if (allSucceeded) {
        toast.success(t("principles.detail.approved"));
        setShowConfirm(false);
        loadData();
      } else {
        // Partial failure — fail loud (EP-03)
        toast.error(
          t("principles.detail.partialFailure", {
            defaultValue: `批准完成，但 ${failedCount}/${totalCount} 条记录失败。请检查后重试。`,
            failedCount,
            totalCount,
          }),
        );
        loadData();
      }
    } catch {
      toast.error(t("principles.detail.approveFailed"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = () => {
    if (!isActionable) return;
    setShowRejectInput(true);
  };
  const cancelReject = () => {
    setShowRejectInput(false);
    setRejectReason("");
  };

  const confirmReject = async () => {
    if (!isActionable || !approvalGroup || !rejectReason.trim() || actionLoading) return;
    setActionLoading(true);
    try {
      const { allSucceeded, failedCount, totalCount } = await applyDecisionToAllRecords("reject", rejectReason.trim());
      if (allSucceeded) {
        toast.success(t("principles.detail.rejected"));
        setShowRejectInput(false);
        setRejectReason("");
        loadData();
      } else {
        // Partial failure — fail loud (EP-03)
        toast.error(
          t("principles.detail.partialFailure", {
            defaultValue: `拒绝完成，但 ${failedCount}/${totalCount} 条记录失败。请检查后重试。`,
            failedCount,
            totalCount,
          }),
        );
        loadData();
      }
    } catch {
      toast.error(t("principles.detail.rejectFailed"));
    } finally {
      setActionLoading(false);
    }
  };

  const handlePark = () => {
    // No-op: Park is disabled and not available in this version.
  };

  const handleEdit = () => {
    if (!isActionable) return;
    setShowEditInput(true);
    setShowRejectInput(false);
    setShowConfirm(false);
  };

  const cancelEdit = () => {
    setShowEditInput(false);
    setEditReason("");
    setNewArtifactId("");
  };

  const currentArtifactId = approvalGroup?.records.find((r) => r.status === "pending")?.artifactId ?? "";

  const confirmEdit = async () => {
    if (!isActionable || !approvalGroup || !editReason.trim() || !newArtifactId.trim() || actionLoading) return;
    const pendingRecords = approvalGroup.records.filter((r) => r.status === "pending");
    // P1-5: guard against an empty pending set — without this the loop is a
    // no-op yet allSucceeded evaluates true, reporting a misleading success.
    if (pendingRecords.length === 0) {
      toast.error(t("principles.detail.editFailed", { defaultValue: "没有可编辑的待处理记录。" }));
      setShowEditInput(false);
      return;
    }
    setActionLoading(true);
    try {
      let failedCount = 0;
      let failureReason: string | undefined;
      for (const record of pendingRecords) {
        const result = await editApproval(record.id, newArtifactId.trim(), editReason.trim());
        if (!result.success) {
          failedCount++;
          if (!failureReason) {
            failureReason = result.nextAction ? `${result.error} ${result.nextAction}` : result.error;
          }
        }
      }
      const allSucceeded = failedCount === 0;
      if (allSucceeded) {
        toast.success(t("principles.detail.editSucceeded", { defaultValue: "已保存修订" }));
        setShowEditInput(false);
        setEditReason("");
        setNewArtifactId("");
        loadData();
      } else {
        // P1-4: thread the backend failureReason into the toast so the owner
        // sees WHY records failed (matches FocusPage behaviour). Previously
        // failureReason was computed but never used (dead code).
        toast.error(
          t("principles.detail.partialFailure", {
            defaultValue: `编辑完成，但 ${failedCount}/${pendingRecords.length} 条记录失败：${failureReason ?? t("principles.detail.unknownFailure", { defaultValue: "请检查服务日志。" })}`,
            failedCount,
            totalCount: pendingRecords.length,
            reason: failureReason ?? t("principles.detail.unknownFailure", { defaultValue: "请检查服务日志。" }),
          }),
        );
        loadData();
      }
    } catch {
      toast.error(t("principles.detail.editFailed", { defaultValue: "编辑失败，请稍后重试。" }));
    } finally {
      setActionLoading(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <PageShell>
        <PageLoading cardCount={1} label={t("principles.loading", { defaultValue: "Loading…" })} />
      </PageShell>
    );
  }

  if (error || !principle) {
    return (
      <PageShell>
        <Button variant="ghost" onClick={() => navigate("/principles")} className="mb-4">
          ← {t("principles.detail.backToList")}
        </Button>
        <div className="border border-danger/30 rounded-[var(--radius-md)] p-4">
          <p className="text-danger text-sm">{error ?? t("principles.notFound")}</p>
          <Button variant="outline" size="sm" onClick={loadData} className="mt-2">
            {t("principles.retry", { defaultValue: "Retry" })}
          </Button>
        </div>
      </PageShell>
    );
  }

  const isPending = approvalGroup?.status === "pending" || principle.status === "candidate" || principle.status === "probation";
  const hasRules = principle.rules.length > 0;
  const receiptPresentation = receipts?.status === 'ok'
    ? getReceiptPresentation(receipts.effectCount)
    : null;

  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Back link */}
      <Button variant="ghost" onClick={() => navigate("/principles")} className="mb-4 -ml-2">
        ← {t("principles.detail.backToList")}
      </Button>

      {/* ── Layer 1: Conclusion ─────────────────────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t("principles.detail.conclusion")}</SectionTitle>
        <h1 className="text-[22px] font-semibold text-ink leading-snug mb-3">
          {principle.text}
        </h1>
        <p className="text-ink-3 text-[14px] leading-relaxed mb-3">
          {t("principles.detail.policyNote")}
        </p>
        {/* Modify wording — DISABLED (MVP3, F.5 honest constraint) */}
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled>
            {t("principles.detail.modifyWording")}
          </Button>
          <span className="text-ink-4 text-[13px]">
            {t("principles.detail.modifyWordingNote")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            data-testid="principle-feedback"
            onClick={() => {
              const params = new URLSearchParams({ source: "principle_page", principleId: id ?? "" });
              navigate(`/report-problem?${params.toString()}`);
            }}
          >
            {t("reportProblem.entryFeedback")}
          </Button>
        </div>
      </section>

      {(governance !== null || governanceUnavailable !== null) && (
        <section className="mb-8" aria-labelledby="governance-summary-title">
          <SectionTitle>{t('principles.detail.governance.title')}</SectionTitle>
          {governance !== null ? (
            <div
              data-testid="governance-summary"
              className={`rounded-[var(--radius-md)] border p-4 ${governance.dataQuality.degraded ? 'border-amber/30 bg-amber/5' : 'border-gov/25 bg-gov/5'}`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 id="governance-summary-title" className="text-[18px] font-semibold text-ink">
                    {t(`principles.detail.${governance.summary.headlineCode}`, { defaultValue: governance.summary.headlineCode })}
                  </h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                    {t(`principles.detail.${governance.summary.reasonCode}`, { defaultValue: governance.summary.reasonCode })}
                  </p>
                </div>
                <span className="w-fit rounded-full border border-line px-2 py-1 font-mono text-[11px] text-ink-3">
                  {t(`principles.detail.governance.confidence.${governance.dataQuality.degraded ? 'degraded' : 'strong'}`)}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div><dt className="font-mono text-[11px] text-ink-4">{t('principles.detail.governance.principleState')}</dt><dd className="text-[13px] text-ink-2">{t(`principles.detail.governance.state.${governance.principleState.value}`)}</dd></div>
                <div><dt className="font-mono text-[11px] text-ink-4">{t('principles.detail.governance.process')}</dt><dd className="text-[13px] text-ink-2">{governance.process.stage === undefined ? t('principles.detail.governance.none') : t(`principles.detail.governance.stage.${governance.process.stage}`)}</dd></div>
                <div><dt className="font-mono text-[11px] text-ink-4">{t('principles.detail.governance.automation')}</dt><dd className="text-[13px] text-ink-2">{t(`principles.detail.governance.automationState.${governance.automation.state}`)}</dd></div>
              </dl>

              <div data-testid="governance-next-action" className="mt-4 border-l-2 border-l-gov pl-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">{t('principles.detail.governance.nextAction')}</p>
                <p className="text-[13px] text-ink-2">{t(`principles.detail.${governance.summary.nextActionCode}`, { defaultValue: governance.summary.nextActionCode })}</p>
              </div>

              {governance.attention.items.length > 0 && (
                <div className="mt-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">{t('principles.detail.governance.blockers')}</p>
                  <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
                    {governance.attention.items.map(item => <li key={`${item.kind}-${item.sourceRef.type}-${item.sourceRef.id}`}>{t(`principles.detail.governance.attention.${item.reasonCode}`, { defaultValue: item.reasonCode })}</li>)}
                  </ul>
                </div>
              )}

              {governance.dataQuality.degraded && (
                <div data-testid="governance-data-quality" className="mt-4 rounded-[var(--radius-sm)] border border-amber/20 p-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-amber">{t('principles.detail.governance.uncertainty')}</p>
                  <ul className="mt-1 space-y-1 text-[12px] text-ink-3">
                    {governance.dataQuality.issues.map((item, index) => <li key={`${item.source}-${item.reasonCode}-${index}`}>{t(`principles.detail.governance.issue.${item.reasonCode}`, { defaultValue: item.reasonCode })}</li>)}
                  </ul>
                </div>
              )}

            </div>
          ) : (
            <div data-testid="governance-data-quality" className="rounded-[var(--radius-md)] border border-amber/30 bg-amber/5 p-4" role="status">
              <h2 id="governance-summary-title" className="text-[16px] font-semibold text-ink">{t('principles.detail.governance.unavailable')}</h2>
              <p className="mt-1 text-[13px] text-ink-2">{t('principles.detail.governance.unavailableReason')}</p>
              <p className="mt-2 text-[12px] text-ink-3">{t('principles.detail.governance.unavailableNextAction')}</p>
            </div>
          )}
        </section>
      )}

      {/* ── PRI-533: Receipt history (生效履历) ─────────────────────────── */}
      {receipts !== null && (
        <section className="mb-8" aria-labelledby="receipt-history-title">
          <SectionTitle>{t('principles.detail.receipts.title')}</SectionTitle>
          {receipts.status === 'ok' ? (
            <div data-testid="receipt-history" className="rounded-[var(--radius-md)] border border-line p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {/* PRI-572: presence ≠ effect. The behavior-influence headline is
                    only justified by deterministic/self-reported effect records;
                    with effectCount=0 the claim degrades to context presence. */}
                <h2 id="receipt-history-title" className="text-[15px] font-semibold text-ink">
                  {receiptPresentation?.headlineKey === 'principles.detail.receipts.headline'
                    ? t(receiptPresentation.headlineKey, {
                        defaultValue: '',
                        effectCount: receipts.effectCount,
                        lastEffectAt: receipts.lastEffectAt ? formatDate(receipts.lastEffectAt, i18n.language) : '',
                      })
                    : t('principles.detail.receipts.headlinePresence')}
                </h2>
                <span data-testid="receipt-history-counts" className="font-mono text-[11px] text-ink-3">
                  {t('principles.detail.receipts.counts', { effectCount: receipts.effectCount, presenceCount: receipts.presenceCount })}
                </span>
              </div>
              {receiptPresentation?.showZeroEffectExplanation && (
                <p data-testid="receipt-history-zero-effect" className="mt-2 text-[12px] leading-relaxed text-ink-3">
                  {t('principles.detail.receipts.zeroEffect')}
                </p>
              )}
              {receipts.events.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {receipts.events.map((event, index) => (
                    <li key={`${event.createdAt}-${index}`} className={`flex flex-wrap items-baseline gap-2 text-[13px] ${event.level === 'presence' ? 'text-ink-4' : 'text-ink-2'}`}>
                      <span className="font-mono text-[11px] text-ink-4">{event.createdAt.slice(0, 16).replace('T', ' ')}</span>
                      <span className="font-mono text-[11px]">{t(`principles.detail.receipts.kind.${event.kind}`, { defaultValue: event.kind })}</span>
                      {event.digest && <span className="min-w-0 flex-1 truncate" title={event.digest}>{event.digest}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-ink-3">{t('principles.detail.receipts.empty')}</p>
              )}
              <p className="mt-3 text-[11px] leading-relaxed text-ink-4">{t('principles.detail.receipts.note')}</p>
              {/* PRI-590: evidence coverage disclosure — observed evidence, not full history */}
              <div className="mt-3 border-t border-line pt-3">
                <ReceiptCoverageDisclosure coverage={receipts.coverage} />
              </div>
            </div>
          ) : (
            <div data-testid="receipt-history-degraded" className="rounded-[var(--radius-md)] border border-amber/30 bg-amber/5 p-4" role="status">
              {/* PRI-590: localized zero-state headline (disabled vs unavailable), then the technical reason.
                  i18n.t (common ns) because the label key is a full path shared with the Activation page. */}
              <h3 className="text-[13px] font-semibold text-ink">{i18n.t(getReceiptSourceStatusLabelKey(receipts.coverage.sourceStatus))}</h3>
              <p className="mt-1 text-[13px] text-ink-2">{receipts.reason ?? t('principles.detail.receipts.unavailableReason')}</p>
              {receipts.nextAction && <p className="mt-1 text-[12px] text-ink-3">{receipts.nextAction}</p>}
            </div>
          )}
        </section>
      )}

      {/* ── Channel info (F.4 — read only, no selector) ─────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t("principles.detail.channel")}</SectionTitle>
        <p className="text-ink-2 text-[14px] leading-relaxed">
          {t("principles.detail.channelPromptReversible")}
        </p>
      </section>

      {/* ── Layer 2: Why ────────────────────────────────────────────────── */}
      <section className="mb-8">
        <SectionTitle>{t("principles.detail.whyExists")}</SectionTitle>

        {/* Applicable / Expected / Non-applicable / Side effects */}
        <div className="space-y-3 mb-6">
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {t("principles.detail.applicable", { defaultValue: "适用场景" })}
            </span>
            <p className="text-ink-2 text-[14px] leading-relaxed">
              {principle.triggerPattern || t("principles.detail.notSpecified", { defaultValue: "未指定" })}
            </p>
          </div>
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {t("principles.detail.expectedBehavior", { defaultValue: "预期行为" })}
            </span>
            <p className="text-ink-2 text-[14px] leading-relaxed">
              {principle.action || t("principles.detail.notSpecified", { defaultValue: "未指定" })}
            </p>
          </div>
        </div>

        {/* Evidence list — Wave 6: stop showing raw UUIDs as primary content.
            Same pattern as PainPage Layer 3: count line + copy-debug-id button
            is the primary action; raw IDs only appear in a collapsed tech-details
            panel for developer troubleshooting. The Owner never reads UUIDs in
            the main review flow. */}
        {principle.derivedFromPainIds.length > 0 && (
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {t("principles.detail.evidence")}
            </span>
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <p className="text-ink-2 text-[14px] leading-relaxed">
                {t("principles.detail.evidenceCount", {
                  defaultValue: "已关联 {{count}} 条证据记录",
                  count: principle.derivedFromPainIds.length,
                })}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    const summary = principle.derivedFromPainIds
                      .map((pid, i) => `pain_${i + 1}_id: ${pid}`)
                      .join("\n");
                    await navigator.clipboard.writeText(summary);
                    setEvidenceCopied(true);
                    setTimeout(() => setEvidenceCopied(false), 2000);
                  } catch (error) {
                    // clipboard unavailable — expand as fallback
                    console.warn("Evidence ID copy failed; expanding technical details.", error);
                    if (!evidenceExpanded) setEvidenceExpanded(true);
                  }
                }}
                className="font-mono text-[11px] h-7"
              >
                {evidenceCopied
                  ? t("principles.detail.evidenceCopied", { defaultValue: "已复制" })
                  : t("principles.detail.copyEvidenceId", { defaultValue: "复制证据 ID" })}
              </Button>
              <button
                type="button"
                onClick={() => setEvidenceExpanded((v) => !v)}
                className="font-mono text-[11px] text-ink-4 hover:text-ink-3 transition-colors underline-offset-2 hover:underline"
              >
                {t("principles.detail.expandTechDetails", { defaultValue: "展开技术细节" })}
              </button>
              {/* Wave 7: link to evidence chain page so Owner knows where to use the copied ID */}
              <Link
                to="/evidence"
                className="font-mono text-[11px] text-gov hover:underline transition-colors"
              >
                {t("principles.detail.viewEvidenceChain", { defaultValue: "在证据链页查看 →" })}
              </Link>
            </div>
            {evidenceExpanded && (
              <div className="mt-3 p-3 bg-paper-2 border border-line rounded-[var(--radius-sm)]">
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                  {principle.derivedFromPainIds.map((painId, idx) => (
                    <div key={`${painId}-${idx}`} className="contents">
                      <span className="font-mono text-ink-4">
                        {t("principles.detail.evidenceIdLabel", {
                          defaultValue: "证据 {{n}} ID",
                          n: idx + 1,
                        })}
                      </span>
                      <span className="font-mono text-ink-2 break-all">{painId}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Owner Reflection Three Questions ─────────────────────────────── */}
      <section className="mb-8 border-t border-line pt-6">
        <SectionTitle>{t("principles.detail.ownerReflection")}</SectionTitle>
        <div className="space-y-3">
          <div className="border-l-2 border-l-gov pl-3 text-ink-2 text-[13px] leading-relaxed">
            {t("principles.detail.reflectionQ1")}
          </div>
          <div className="border-l-2 border-l-gov pl-3 text-ink-2 text-[13px] leading-relaxed">
            {t("principles.detail.reflectionQ2")}
          </div>
          <div className="border-l-2 border-l-gov pl-3 text-ink-2 text-[13px] leading-relaxed">
            {t("principles.detail.reflectionQ3")}
          </div>
        </div>
      </section>

      {/* ── Layer 3: Full trajectory (collapsed by default, D section) ──── */}
      <details className="mb-8 border border-line rounded-[var(--radius-md)]">
        <summary className="px-4 py-3 cursor-pointer font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov">
          {t("principles.detail.trajectory")}
        </summary>
        <div className="px-4 pb-4 border-t border-line pt-4">
          {governance !== null && (
            <section className="mb-6" data-testid="governance-timeline">
              <SectionTitle>{t('principles.detail.governance.timeline')}</SectionTitle>
              {governance.timeline.length === 0 ? <p className="text-[13px] text-ink-4">{t('principles.detail.governance.timelineEmpty')}</p> : (
                <ol className="space-y-3 border-l border-line pl-4">
                  {governance.timeline.map((event, index) => {
                    const derived = event.code === 'revision_requested' || event.code === 'revision_reopened';
                    return <li key={`${event.sourceRef.type}-${event.sourceRef.id}-${event.code}-${index}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] text-ink-2">{t(`principles.detail.governance.timelineCode.${event.code}`, { defaultValue: event.code })}</span>
                        <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-4">{t(`principles.detail.governance.${derived ? 'derived' : 'fact'}`)}</span>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-4">{event.occurredAt ?? event.recordedAt}</p>
                    </li>;
                  })}
                </ol>
              )}
            </section>
          )}
          {/* Trajectory timeline — render from real data if available */}
          {trajectory?.degraded && (
            <div className="mb-4 p-3 bg-amber/5 border border-amber/20 rounded-[var(--radius-sm)]">
              <p className="text-amber text-[12px] font-mono">
                {trajectory.degraded.reason}
              </p>
              <p className="text-ink-4 text-[11px] mt-1">
                {trajectory.degraded.nextAction}
              </p>
            </div>
          )}

          <div className="space-y-4">
            {(trajectory?.stages ?? []).length > 0 ? (
              trajectory!.stages.map((stage: TrajectoryStageData) => (
                <div key={stage.key} className="flex gap-4">
                  <span className="font-mono text-[12px] text-ink-3 min-w-[80px]">
                    {t(STAGE_LABEL_KEYS[stage.key] ?? `principles.detail.stage${stage.key}`, { defaultValue: stage.key })}
                  </span>
                  <div className="flex-1">
                    {stage.status === 'available' ? (
                      <>
                        <p className="text-ink-2 text-[13px]">{stage.summary}</p>
                        {stage.detail && (
                          <p className="text-ink-3 text-[12px] mt-0.5">{stage.detail}</p>
                        )}
                        {stage.timestamp && (
                          <p className="text-ink-4 text-[11px] mt-0.5 font-mono">{stage.timestamp}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-ink-4 text-[13px]">
                        {stage.unavailableReason ?? '—'}
                        {stage.nextAction && (
                          <span className="block text-ink-4 text-[11px] mt-0.5">
                            {stage.nextAction}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              ))
            ) : (
              // Fallback: show loading state or no-data message
              ['evidence', 'diagnosis', 'proposal', 'review', 'deploy', 'behavior'].map((key) => (
                <div key={key} className="flex gap-4">
                  <span className="font-mono text-[12px] text-ink-3 min-w-[80px]">
                    {t(STAGE_LABEL_KEYS[key] ?? `principles.detail.stage${key}`, { defaultValue: key })}
                  </span>
                  <div className="flex-1">
                    <p className="text-ink-4 text-[13px]">
                      {trajectory === null
                        ? t("principles.detail.trajectoryLoadFailed", { defaultValue: "无法加载轨迹数据" })
                        : "—"}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Lifecycle metrics — only when principle has rules (F.1) */}
          {hasRules && lifecycle && (
            <div className="mt-6 pt-4 border-t border-line">
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                {t("principles.detail.lifecycleMetrics", { defaultValue: "生命周期指标" })}
              </span>
              {/* F.1 honest label */}
              <p className="text-amber text-[12px] font-mono mt-1 mb-3">
                {t("principles.detail.lifecycleNote")}
              </p>

              {lifecycle.adherence.insufficientData ? (
                <p className="text-ink-3 text-[13px] leading-relaxed">
                  {t("principles.detail.insufficientData")}
                </p>
              ) : (
                <div>
                  <p className="text-ink-2 text-[14px]">
                    {t("principles.detail.adherenceRate", { defaultValue: "遵守率" })}: {lifecycle.adherence.rate !== null ? `${(lifecycle.adherence.rate * 100).toFixed(1)}%` : "—"}
                  </p>
                  <p className="text-ink-3 text-[12px] mt-1">{lifecycle.adherence.note}</p>
                </div>
              )}

              {lifecycle.ruleMetrics.length > 0 && (
                <div className="mt-3">
                  {lifecycle.ruleMetrics.map((rm) => (
                    <div key={rm.ruleId} className="flex gap-3 text-[12px] font-mono text-ink-3">
                      <span>{rm.ruleId}</span>
                      <span>{t("principles.detail.triggered", { defaultValue: "触发" })}: {rm.triggered}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hasRules && !lifecycle && (
            <div className="mt-6 pt-4 border-t border-line">
              <p className="text-ink-3 text-[13px]">
                {t("principles.detail.lifecycleLoadFailed", { defaultValue: "无法加载生命周期指标。你可以稍后重试。" })}
              </p>
            </div>
          )}
        </div>
      </details>

      {/* ── Decision section (PRI-387) ────────────────────────────────────── */}
      {showDecisionControls && (
        <div className="border-t border-line pt-6 mt-6">
        <SectionTitle>{t("principles.detail.decisionTitle", { defaultValue: "决策操作" })}</SectionTitle>
        
        <div className="flex gap-3 flex-wrap items-center">
          <Button
            variant="default"
            onClick={handleApprove}
            disabled={!isActionable || actionLoading}
          >
            {t("principles.detail.approve")}
          </Button>

          <Button
            variant="outline"
            onClick={handleEdit}
            disabled={!isActionable || actionLoading}
          >
            {t("principles.detail.editAction", { defaultValue: "编辑" })}
          </Button>

          <Button
            variant="outline"
            onClick={handlePark}
            disabled
          >
            {t("principles.detail.park")}
          </Button>

          <Button
            variant="destructive"
            onClick={handleReject}
            disabled={!isActionable || actionLoading}
          >
            {t("principles.detail.reject")}
          </Button>

          {/* Park unavailable note */}
          <span className="text-ink-4 text-[13px]">
            ({t("principles.detail.parkUnavailable", { defaultValue: "暂存尚未可用" })})
          </span>
        </div>

        {/* Actionable or non-actionable status messages */}
        {!isActionable && (
          <p className="text-danger text-[13px] mt-3 font-mono">
            {t("principles.detail.unactionableReasonPrefix", { defaultValue: "不可操作原因: " })}
            {t(reasonKey, { defaultValue: defaultReason })}
          </p>
        )}

        {/* Confirmation bar (J.1) */}
        {isActionable && showConfirm && (
          <div className="mt-4 p-3 bg-gov/5 border border-gov/20 rounded-[var(--radius-md)]">
            <p className="text-ink-2 text-[13px] mb-3">
              {t("principles.detail.confirmApprove")}
            </p>
            <div className="flex gap-2">
              <Button variant="default" size="sm" onClick={confirmApprove} disabled={actionLoading}>
                {t("principles.detail.confirm")}
              </Button>
              <Button variant="outline" size="sm" onClick={cancelConfirm}>
                {t("principles.detail.cancel")}
              </Button>
            </div>
          </div>
        )}

        {/* Rejection reason input (inline, not dialog) */}
        {isActionable && showRejectInput && (
          <div className="mt-4 p-3 border border-danger/20 rounded-[var(--radius-md)]">
            <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
              {t("principles.detail.rejectReasonLabel", { defaultValue: "拒绝原因" })}
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("principles.detail.rejectReasonPlaceholder")}
              className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] min-h-[80px] resize-y focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
              aria-label={t("principles.detail.rejectReasonPlaceholder")}
            />
            <div className="flex gap-2 mt-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={confirmReject}
                disabled={!rejectReason.trim() || actionLoading}
              >
                {t("principles.detail.confirmReject")}
              </Button>
              <Button variant="outline" size="sm" onClick={cancelReject}>
                {t("principles.detail.cancel")}
              </Button>
            </div>
          </div>
        )}

        {/* Edit revision input (inline, not dialog) */}
        {isActionable && showEditInput && (
          <div className="mt-4 p-3 border border-gov/20 rounded-[var(--radius-md)]">
            <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
              {t("principles.detail.editReasonLabel", { defaultValue: "编辑原因" })}
            </label>
            <div className="mb-2 text-ink-4 text-[12px] font-mono">
              {t("principles.detail.currentArtifactLabel", { defaultValue: "当前工件" })}: {currentArtifactId}
            </div>
            <input
              type="text"
              value={newArtifactId}
              onChange={(e) => setNewArtifactId(e.target.value)}
              placeholder={t("principles.detail.editNewArtifactPlaceholder", { defaultValue: "输入新的已验证工件 ID" })}
              className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] mb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
              aria-label={t("principles.detail.editNewArtifactPlaceholder", { defaultValue: "输入新的已验证工件 ID" })}
            />
            <textarea
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              placeholder={t("principles.detail.editReasonPlaceholder", { defaultValue: "请说明编辑原因" })}
              className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] min-h-[80px] resize-y focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
            />
            <div className="flex gap-2 mt-2">
              <Button
                variant="default"
                size="sm"
                onClick={confirmEdit}
                disabled={!editReason.trim() || !newArtifactId.trim() || actionLoading}
              >
                {t("principles.detail.confirmEdit", { defaultValue: "确认编辑" })}
              </Button>
              <Button variant="outline" size="sm" onClick={cancelEdit}>
                {t("principles.detail.cancel")}
              </Button>
            </div>
          </div>
        )}
        </div>
      )}

      {/* PRI-582: decision controls are hidden when the governance projection
          cannot authorize them. Explain why instead of removing the section
          silently (ERR-002: every degraded path carries reason + nextAction). */}
      {governanceBlock !== null && (
        <div className="border-t border-line pt-6 mt-6" data-testid="governance-decision-blocked">
          <SectionTitle>{t("principles.detail.decisionTitle", { defaultValue: "决策操作" })}</SectionTitle>
          <p
            className="text-danger text-[13px] mt-3 font-mono"
            data-testid="governance-decision-blocked-reason"
          >
            {governanceBlock.source === 'server'
              ? governanceBlock.reason
              : t(governanceBlock.reasonKey)}
          </p>
          {governanceBlockedNextAction !== undefined && (
            <p
              className="text-ink-3 text-[13px] mt-1 font-mono"
              data-testid="governance-decision-blocked-next-action"
            >
              <span className="font-medium">{t(GOVERNANCE_BLOCK_I18N_KEYS.nextActionLabel)}</span>{" "}
              {governanceBlockedNextAction}
            </p>
          )}
        </div>
      )}
      </div>
    </PageShell>
  );
}
