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
  approveApproval,
  rejectApproval,
  editApproval,
} from "../../api.js";
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
export function PrincipleDetailPage() {
  const { t } = useTranslation("pages");
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [principle, setPrinciple] = useState<PrincipleDetail | null>(null);
  const [approvalGroup, setApprovalGroup] = useState<ApprovalGroup | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleMetricsData | null>(null);
  const [trajectory, setTrajectory] = useState<TrajectoryData | null>(null);
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
    try {
      const [pResult, aResult, lResult, tResult] = await Promise.all([
        fetchPrincipleDetail(id),
        fetchApprovalsGrouped(),
        fetchLifecycleMetrics(id),
        fetchPrincipleTrajectory(id),
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
      </div>
    </PageShell>
  );
}
