import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import {
  fetchPrincipleDetail,
  fetchApprovalsGrouped,
  fetchLifecycleMetrics,
  approveApproval,
  rejectApproval,
} from "../../api.js";
import type {
  PrincipleDetail,
  PrincipleDetailData,
  ApprovalGroup,
  ApprovalsGroupedData,
  LifecycleMetricsData,
} from "../../api.js";

// ── Runtime validation (H section) ──────────────────────────────────────────
function validatePrincipleDetail(data: unknown): PrincipleDetailData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!d.principle || typeof d.principle !== "object") return null;
  return d as unknown as PrincipleDetailData;
}

function validateApprovalsGrouped(data: unknown): ApprovalsGroupedData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.groups)) return null;
  return d as unknown as ApprovalsGroupedData;
}

function validateLifecycleMetrics(data: unknown): LifecycleMetricsData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!d.adherence || typeof d.adherence !== "object") return null;
  return d as unknown as LifecycleMetricsData;
}

// ── Trajectory stages for Layer 3 ───────────────────────────────────────────
const TRAJECTORY_STAGES = [
  { key: "evidence", label: "evidence" },
  { key: "diagnosis", label: "diagnosis" },
  { key: "proposal", label: "proposal" },
  { key: "review", label: "review" },
  { key: "deploy", label: "deploy" },
  { key: "behavior", label: "behavior" },
];

// ── Component ───────────────────────────────────────────────────────────────
export function PrincipleDetailPage() {
  const { t } = useTranslation("pages");
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [principle, setPrinciple] = useState<PrincipleDetail | null>(null);
  const [approvalGroup, setApprovalGroup] = useState<ApprovalGroup | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Decision state
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch data
  const loadData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [pResult, aResult, lResult] = await Promise.all([
        fetchPrincipleDetail(id),
        fetchApprovalsGrouped(),
        fetchLifecycleMetrics(id),
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
      }

      const lData = lResult.success ? validateLifecycleMetrics(lResult.data) : null;
      setLifecycle(lData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const handleApprove = () => setShowConfirm(true);
  const cancelConfirm = () => setShowConfirm(false);

  const confirmApprove = async () => {
    if (!approvalGroup || actionLoading) return;
    setActionLoading(true);
    try {
      // Approve the first pending record in the group
      const pendingRecord = approvalGroup.records[0];
      if (!pendingRecord) {
        toast.error(t("principles.detail.approveFailed"));
        return;
      }
      const result = await approveApproval(pendingRecord.id);
      if (result.success) {
        toast.success(t("principles.detail.approved"));
        setShowConfirm(false);
        loadData();
      } else {
        toast.error(t("principles.detail.approveFailed"));
      }
    } catch {
      toast.error(t("principles.detail.approveFailed"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = () => setShowRejectInput(true);
  const cancelReject = () => {
    setShowRejectInput(false);
    setRejectReason("");
  };

  const confirmReject = async () => {
    if (!approvalGroup || !rejectReason.trim() || actionLoading) return;
    setActionLoading(true);
    try {
      const pendingRecord = approvalGroup.records[0];
      if (!pendingRecord) {
        toast.error(t("principles.detail.rejectFailed"));
        return;
      }
      const result = await rejectApproval(pendingRecord.id, rejectReason.trim());
      if (result.success) {
        toast.success(t("principles.detail.rejected"));
        setShowRejectInput(false);
        setRejectReason("");
        loadData();
      } else {
        toast.error(t("principles.detail.rejectFailed"));
      }
    } catch {
      toast.error(t("principles.detail.rejectFailed"));
    } finally {
      setActionLoading(false);
    }
  };

  const handlePark = () => {
    toast.success(t("principles.detail.parked"));
  };

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <PageShell>
        <p className="text-ink-3 text-sm">{t("principles.loading", { defaultValue: "Loading…" })}</p>
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

  return (
    <PageShell>
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
        </div>
      </section>

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

        {/* Evidence list */}
        {principle.derivedFromPainIds.length > 0 && (
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {t("principles.detail.evidence")}
            </span>
            <ul className="mt-2 space-y-1">
              {principle.derivedFromPainIds.map((painId, idx) => (
                <li key={painId} className="text-ink-2 text-[13px] font-mono">
                  {idx + 1}. {painId}
                </li>
              ))}
            </ul>
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
          {/* Trajectory timeline */}
          <div className="space-y-4">
            {TRAJECTORY_STAGES.map((stage) => (
              <div key={stage.key} className="flex gap-4">
                <span className="font-mono text-[12px] text-ink-3 min-w-[80px]">
                  {t("principles.detail.stage" + stage.key.charAt(0).toUpperCase() + stage.key.slice(1), { defaultValue: stage.label })}
                </span>
                <div className="flex-1">
                  <p className="text-ink-3 text-[13px]">
                    {t("principles.detail.stage" + stage.key.charAt(0).toUpperCase() + stage.key.slice(1) + "Desc", { defaultValue: "—" })}
                  </p>
                </div>
              </div>
            ))}
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

      {/* ── Decision bar ────────────────────────────────────────────────── */}
      {isPending && (
        <div className="border-t border-line pt-6">
          <div className="flex gap-3 flex-wrap">
            <Button variant="default" onClick={handleApprove} disabled={actionLoading}>
              {t("principles.detail.approve")}
            </Button>
            <Button variant="outline" onClick={handlePark} disabled={actionLoading}>
              {t("principles.detail.park")}
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={actionLoading}>
              {t("principles.detail.reject")}
            </Button>
          </div>

          {/* Confirmation bar (J.1) */}
          {showConfirm && (
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
          {showRejectInput && (
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
        </div>
      )}

      {/* Already decided state */}
      {!isPending && approvalGroup && (
        <div className="border-t border-line pt-6">
          <p className="text-ink-3 text-[13px]">
            {approvalGroup.status === "approved" && t("principles.detail.alreadyApproved", { defaultValue: "此原则已批准。" })}
            {approvalGroup.status === "rejected" && t("principles.detail.alreadyRejected", { defaultValue: "此原则已拒绝。" })}
          </p>
        </div>
      )}
    </PageShell>
  );
}
