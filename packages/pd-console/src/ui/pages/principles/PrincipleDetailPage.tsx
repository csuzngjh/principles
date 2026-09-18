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
  fetchOwnerDecisionView,
  approveApproval,
  rejectApproval,
  editApproval,
  disableActivation,
} from "../../api.js";
import type { PrincipleReceiptsData } from "../../api.js";
import type { OwnerDecisionViewCore, Action as OwnerAction } from "@principles/core/runtime-v2";
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

/**
 * Validate and normalize a PrincipleDetail from untrusted network data.
 * Returns a normalized object with safe defaults for all fields the page
 * actually accesses. Never returns null for individual fields — only for
 * completely unparseable top-level structures.
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
    triggerPattern: typeof raw.triggerPattern === "string" ? raw.triggerPattern : "",
    action: typeof raw.action === "string" ? raw.action : "",
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
// Kept as an exported pure function (tested) describing the LEGACY governance
// summary card's display state. Since Owner Decision Experience v1
// (SPEC §8/Phase C) it NO LONGER decides Owner-facing action eligibility —
// that is the backend OwnerDecisionViewCore's available_actions.
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

// ── Owner Decision helpers (Owner Decision Experience v1) ───────────────────

/** Narrative fields render as items; unknown carries its owner-facing reason. */
export type NarrativeRender =
  | { status: 'known'; texts: string[] }
  | { status: 'unknown'; reason: string };

export function narrativeTexts(field: { status: string } & Record<string, unknown>): NarrativeRender {
  if (field.status === 'known' && Array.isArray(field.value)) {
    const texts: string[] = [];
    for (const item of field.value) {
      if (isRecord(item) && isString(item.text)) texts.push(item.text);
    }
    return { status: 'known', texts };
  }
  const reason = isRecord(field.reason) && isString(field.reason.ownerText) ? field.reason.ownerText : '';
  return { status: 'unknown', reason };
}

/** Resolves the concrete mutation target id for an action (never from URL). */
export function actionTargetId(action: { targetRefs: Array<{ kind: string; id: string }> }, kind: 'approval' | 'activation'): string | null {
  const ref = action.targetRefs.find((target) => target.kind === kind);
  return ref?.id ?? null;
}

// Codex review P2 fix (localization): the decision panel's CHROME (action
// labels, next action, blocker headline) localizes in the client via stable
// semantic codes; narrative CONTENT (artifact-derived text) stays in its
// source language — the model-generated material cannot be translated by a
// key lookup, so a full locale-carried response remains a follow-up.
const ACTION_LABEL_KEY: Record<string, string> = {
  approve: 'principles.detail.ownerDecision.actionLabel.approve',
  reject: 'principles.detail.ownerDecision.actionLabel.reject',
  edit_approval: 'principles.detail.ownerDecision.actionLabel.edit_approval',
  disable: 'principles.detail.ownerDecision.actionLabel.disable',
};

export function localizeActionLabel(action: { semantic: string; label: string }, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const key = ACTION_LABEL_KEY[action.semantic];
  if (key === undefined) return action.label;
  const localized = t(key, { defaultValue: '' });
  return localized === '' ? action.label : localized;
}

export function localizeNextAction(code: string, ownerText: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const localized = t(`principles.detail.ownerDecision.next.${code}`, { defaultValue: '' });
  return localized === '' ? ownerText : localized;
}

export function localizeBlocker(code: string, ownerText: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const safeKey = code.replace(/[^a-zA-Z0-9_.]/g, '_');
  const localized = t(`principles.detail.ownerDecision.blocker.${safeKey}`, { defaultValue: '' });
  return localized === '' ? ownerText : localized;
}

const DECISION_STATE_LABEL_KEY: Record<OwnerDecisionViewCore['decisionState'], string> = {
  needs_owner_decision: 'principles.detail.ownerDecision.state.needs_owner_decision',
  processing: 'principles.detail.ownerDecision.state.processing',
  blocked: 'principles.detail.ownerDecision.state.blocked',
  recovery_needed: 'principles.detail.ownerDecision.state.recovery_needed',
  decided: 'principles.detail.ownerDecision.state.decided',
  no_action: 'principles.detail.ownerDecision.state.no_action',
};

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
  const [ownerDecision, setOwnerDecision] = useState<OwnerDecisionViewCore | null>(null);
  const [ownerDecisionUnavailable, setOwnerDecisionUnavailable] = useState<{ reason: string } | null>(null);
  const [receipts, setReceipts] = useState<PrincipleReceiptsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Decision action state — driven by backend available_actions only.
  const [pendingAction, setPendingAction] = useState<OwnerAction | null>(null);
  const [rejectReason, setRejectReason] = useState("");
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
    setOwnerDecision(null);
    setOwnerDecisionUnavailable(null);
    setReceipts(null);
    try {
      const [pResult, aResult, lResult, tResult, gResult, dResult, rResult] = await Promise.all([
        fetchPrincipleDetail(id),
        fetchApprovalsGrouped(),
        fetchLifecycleMetrics(id),
        fetchPrincipleTrajectory(id),
        fetchPrincipleGovernance(id),
        fetchOwnerDecisionView(id),
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

      // Owner Decision Experience v1: the canonical first layer. feature_disabled
      // mirrors the governance flag-off path (no owner-decision data, no error).
      if (dResult.success && dResult.data) {
        setOwnerDecision(dResult.data);
      } else if (!dResult.success && dResult.reason !== 'feature_disabled') {
        setOwnerDecisionUnavailable({ reason: dResult.error });
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

  // ── Owner decision actions (SPEC §8.4: mutation service is the authority) ─
  // The view's actions are advisory; every submission goes through the real
  // mutation service. On failure: show the service reason, invalidate stale
  // actions, re-GET the view. Never auto-retry a mutation.
  const submitOwnerAction = async (action: OwnerAction, reason?: string): Promise<void> => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      let failed = false;
      let failureDetail = '';
      const settle = (result: { success: boolean; error?: string; nextAction?: string }): void => {
        if (!result.success) {
          failed = true;
          failureDetail = `${result.error ?? ''}${result.nextAction ? ` ${result.nextAction}` : ''}`.trim();
        }
      };
      if (action.semantic === 'approve') {
        const approvalId = actionTargetId(action, 'approval');
        if (approvalId === null) {
          toast.error(t("principles.detail.ownerDecision.invalidTarget", { defaultValue: "动作目标缺失，无法提交。" }));
          return;
        }
        settle(await approveApproval(approvalId));
      } else if (action.semantic === 'reject') {
        const approvalId = actionTargetId(action, 'approval');
        if (approvalId === null) {
          toast.error(t("principles.detail.ownerDecision.invalidTarget", { defaultValue: "动作目标缺失，无法提交。" }));
          return;
        }
        settle(await rejectApproval(approvalId, reason ?? ""));
      } else if (action.semantic === 'edit_approval') {
        const approvalId = actionTargetId(action, 'approval');
        if (approvalId === null || reason === undefined || newArtifactId.trim() === '') {
          toast.error(t("principles.detail.ownerDecision.invalidTarget", { defaultValue: "动作目标缺失，无法提交。" }));
          return;
        }
        settle(await editApproval(approvalId, newArtifactId.trim(), reason));
      } else if (action.semantic === 'disable') {
        const activationId = actionTargetId(action, 'activation');
        if (activationId === null) {
          toast.error(t("principles.detail.ownerDecision.invalidTarget", { defaultValue: "动作目标缺失，无法提交。" }));
          return;
        }
        settle(await disableActivation(activationId));
      } else {
        return; // unknown semantics are never rendered; belt-and-suspenders
      }
      if (!failed) {
        toast.success(t("principles.detail.ownerDecision.actionDone", { defaultValue: "操作已提交。" }));
      } else {
        // SPEC §8.4: surface the service's real refusal reason and let the
        // fresh GET decide what is actionable now — never auto-retry.
        toast.error(t("principles.detail.ownerDecision.actionFailed", {
          defaultValue: "操作被拒绝：{{detail}} 可用操作已刷新，请基于最新状态重新决定。",
          detail: failureDetail === '' ? t("principles.detail.unknownFailure", { defaultValue: "请检查服务日志。" }) : failureDetail,
        }));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
      setPendingAction(null);
      setRejectReason("");
      setNewArtifactId("");
      // Invalidate the stale action list and re-derive from a fresh GET.
      await loadData();
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
          {ownerDecision?.learnedPrinciple.status === 'known'
            ? ownerDecision.learnedPrinciple.value.text
            : principle.text}
        </h1>
        {ownerDecision !== null && ownerDecision.learnedPrinciple.status !== 'known' && (
          <p className="text-amber text-[13px] leading-relaxed mb-3" data-testid="owner-decision-technical-note">
            {t("principles.detail.ownerDecision.technicalOriginalNote", {
              defaultValue: "以上为原始技术建议文本；可读的行为准则暂缺（保留原文以保证可追溯）。",
            })}
          </p>
        )}
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

      {/* ── Owner Decision View — the canonical first layer (SPEC §11.3) ── */}
      {ownerDecision !== null && (
        <section className="mb-8" aria-labelledby="owner-decision-title" data-testid="owner-decision-view">
          <SectionTitle>{t("principles.detail.ownerDecision.title", { defaultValue: "这条原则的决策视图" })}</SectionTitle>
          <div className="rounded-[var(--radius-md)] border border-gov/25 bg-gov/5 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="owner-decision-title" className="text-[18px] font-semibold text-ink">
                  {t(DECISION_STATE_LABEL_KEY[ownerDecision.decisionState])}
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  {localizeNextAction(ownerDecision.nextAction.code, ownerDecision.nextAction.ownerText, t)}
                </p>
              </div>
              <span data-testid="owner-decision-state" className="w-fit rounded-full border border-line px-2 py-1 font-mono text-[11px] text-ink-3">
                {ownerDecision.sourceReadStatus === 'complete'
                  ? t("principles.detail.ownerDecision.readsComplete", { defaultValue: "本次所需数据已读取" })
                  : t("principles.detail.ownerDecision.readsPartial", { defaultValue: "部分数据源读取失败" })}
              </span>
            </div>

            {/* 1. 发生了什么 */}
            <OwnerNarrativeBlock
              testId="owner-decision-incident"
              label={t("principles.detail.ownerDecision.incident", { defaultValue: "发生了什么" })}
              field={ownerDecision.incidentSummary}
            />
            {/* 2. 学到了什么 */}
            <div className="mt-4" data-testid="owner-decision-learned">
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                {t("principles.detail.ownerDecision.learned", { defaultValue: "Agent 学到的行为准则" })}
              </p>
              {ownerDecision.learnedPrinciple.status === 'known' ? (
                <>
                  <p className="mt-1 text-ink-2 text-[14px] leading-relaxed">
                    {ownerDecision.learnedPrinciple.value.text}
                  </p>
                  <p className="mt-1 text-ink-4 text-[12px]">
                    {t("principles.detail.ownerDecision.sourceTierLabel", {
                      defaultValue: "来源：{{tier}}（未经改写）",
                      tier: t(`principles.detail.ownerDecision.tier.${ownerDecision.learnedPrinciple.value.sourceTier}`, { defaultValue: ownerDecision.learnedPrinciple.value.sourceTier }),
                    })}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-amber text-[13px] leading-relaxed">
                  {ownerDecision.learnedPrinciple.reason.ownerText}
                </p>
              )}
            </div>
            {/* 3. 为什么 */}
            <OwnerNarrativeBlock
              testId="owner-decision-rationale"
              label={t("principles.detail.ownerDecision.rationale", { defaultValue: "为什么这么判断" })}
              field={ownerDecision.rationale}
            />
            {/* 4. 什么时候适用 */}
            <OwnerNarrativeBlock
              testId="owner-decision-applicability"
              label={t("principles.detail.ownerDecision.applicability", { defaultValue: "什么时候适用" })}
              field={ownerDecision.applicability}
            />
            {/* 5. 会怎样改变行为 */}
            <OwnerNarrativeBlock
              testId="owner-decision-expected"
              label={t("principles.detail.ownerDecision.expected", { defaultValue: "批准后会怎样（拟议行为，未部署）" })}
              field={ownerDecision.expectedBehavior}
            />
            {/* 5b. 当前实际执行 */}
            {ownerDecision.currentEnforcement.status === 'known' && (
              <div className="mt-4" data-testid="owner-decision-enforcement">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                  {t("principles.detail.ownerDecision.enforcementLabel", { defaultValue: "当前实际执行" })}
                </p>
                <p className="mt-1 text-ink-2 text-[14px] leading-relaxed">
                  {ownerDecision.currentEnforcement.value?.state === 'active'
                    ? t("principles.detail.ownerDecision.enforcement.active", { defaultValue: "当前有正在执行的生效方式（见下方明细）。" })
                    : ownerDecision.currentEnforcement.value?.state === 'deactivated'
                      ? t("principles.detail.ownerDecision.enforcement.deactivated", { defaultValue: "此前的执行方式已停用；当前没有正在执行的生效方式。" })
                      : ownerDecision.currentEnforcement.value?.state === 'partially_active'
                        ? t("principles.detail.ownerDecision.enforcement.partial", { defaultValue: "部分执行方式仍在运行（见下方明细）。" })
                        : t("principles.detail.ownerDecision.enforcement.none", { defaultValue: "这条原则当前没有生效中的执行方式。" })}
                </p>
                {ownerDecision.currentEnforcement.value?.items.map((item) => (
                  <p key={item.activationRef.id} className="mt-1 text-ink-3 text-[12px]">
                    {item.mode.status === 'known' ? item.mode.value : item.channel}
                    {" · "}
                    {item.active
                      ? t("principles.detail.ownerDecision.enforcement.since", { defaultValue: "生效中（自 {{since}}）", since: item.since.status === 'known' ? item.since.value.slice(0, 10) : '?' })
                      : t("principles.detail.ownerDecision.enforcement.stopped", { defaultValue: "已停用" })}
                  </p>
                ))}
              </div>
            )}
            {ownerDecision.currentEnforcement.status === 'unknown' && (
              <p className="mt-4 text-amber text-[13px]" data-testid="owner-decision-enforcement-unknown">
                {ownerDecision.currentEnforcement.reason?.ownerText}
              </p>
            )}
            {/* 5c. 证据概览（§12 五维度独立） */}
            {ownerDecision.evidenceSummary.status === 'known' && (
              <div className="mt-4" data-testid="owner-decision-evidence">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                  {t("principles.detail.ownerDecision.evidence", { defaultValue: "行为证据" })}
                </p>
                <p className="mt-1 text-ink-2 text-[13px] leading-relaxed">
                  {ownerDecision.evidenceSummary.value?.ownerExplanation}
                </p>
              </div>
            )}
            {/* 6. 风险与不确定性 */}
            <div className="mt-4" data-testid="owner-decision-uncertainty">
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                {t("principles.detail.ownerDecision.uncertainty", { defaultValue: "风险与不确定性" })}
              </p>
              {ownerDecision.risk.status === 'known' && (ownerDecision.risk.value?.items.length ?? 0) > 0 && (
                <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
                  {ownerDecision.risk.value?.items.map((item, index) => (
                    <li key={`risk-${index}`}>{item.text}</li>
                  ))}
                </ul>
              )}
              {ownerDecision.risk.status === 'known' && (ownerDecision.risk.value?.items.length ?? 0) === 0 && (
                <p className="mt-1 text-ink-3 text-[13px]">
                  {t("principles.detail.ownerDecision.riskNotAssessed", { defaultValue: "尚未做过风险评估；这不代表没有风险。" })}
                </p>
              )}
              {ownerDecision.risk.status === 'unknown' && (
                <p className="mt-1 text-ink-3 text-[13px]">{ownerDecision.risk.reason?.ownerText}</p>
              )}
              {ownerDecision.uncertainty.status === 'known' && ownerDecision.uncertainty.value.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12px] text-ink-3">
                  {ownerDecision.uncertainty.value.map((item, index) => (
                    <li key={`unc-${index}`}>{item.text}</li>
                  ))}
                </ul>
              )}
            </div>
            {/* 7. 如何撤销 */}
            <div className="mt-4" data-testid="owner-decision-rollback">
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                {t("principles.detail.ownerDecision.rollback", { defaultValue: "如何停止影响" })}
              </p>
              {ownerDecision.rollback.status === 'known' && (
                <>
                  <p className="mt-1 text-ink-2 text-[13px] leading-relaxed">{ownerDecision.rollback.value?.ownerText}</p>
                  {ownerDecision.rollback.value?.stopFuture.status === 'known' && (
                    <ul className="mt-1 space-y-1 text-[12px] text-ink-3">
                      {ownerDecision.rollback.value.stopFuture.value.map((item, index) => (
                        <li key={`rb-${index}`}>{item.text}</li>
                      ))}
                    </ul>
                  )}
                  {ownerDecision.rollback.value?.stopFuture.status === 'not_applicable' && (
                    <p className="mt-1 text-ink-3 text-[12px]">{ownerDecision.rollback.value.stopFuture.reason.ownerText}</p>
                  )}
                </>
              )}
              {ownerDecision.rollback.status === 'unknown' && (
                <p className="mt-1 text-amber text-[13px]">{ownerDecision.rollback.reason?.ownerText}</p>
              )}
            </div>

            {/* 8. Owner Decision — backend-assessed actions only */}
            <div className="mt-5 border-t border-line pt-4" data-testid="owner-decision-actions">
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                {t("principles.detail.ownerDecision.decision", { defaultValue: "你的决定" })}
              </p>
              {ownerDecision.availableActions.length === 0 && (
                <p className="mt-1 text-ink-3 text-[13px]">
                  {t("principles.detail.ownerDecision.noActions", { defaultValue: "当前没有可以执行的操作。" })}
                </p>
              )}
              {/* Fix 1 (review P1): per-subject decision material. Each pending
                  decision shows ITS OWN revision's material — never another
                  revision's text. Principle-level learnedPrinciple above stays
                  the overview summary only. */}
              {ownerDecision.decisionSubjects.filter((subject) => subject.state === 'pending').length > 0 && (
                <div className="mt-3 space-y-3" data-testid="owner-decision-subject-materials">
                  {ownerDecision.decisionSubjects.filter((subject) => subject.state === 'pending').map((subject) => (
                    <div key={subject.key} className="rounded-[var(--radius-sm)] border border-line p-3" data-subject-key={subject.key}>
                      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
                        {t("principles.detail.ownerDecision.subjectMaterial", { defaultValue: "这项决定的材料" })}
                      </p>
                      {subject.decisionMaterial.learnedPrinciple.status === 'known' ? (
                        subject.decisionMaterial.learnedPrinciple.value.map((item, index) => (
                          <p key={`sm-${index}`} className="mt-1 text-ink-2 text-[13px] leading-relaxed">{item.text}</p>
                        ))
                      ) : (
                        <p className="mt-1 text-amber text-[13px]">{subject.decisionMaterial.learnedPrinciple.reason.ownerText}</p>
                      )}
                      {subject.decisionMaterial.consequence.status === 'known' && (
                        <p className="mt-1 text-ink-3 text-[12px] leading-relaxed">
                          {subject.decisionMaterial.consequence.value.map((item) => item.text).join(' ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-3">
                {ownerDecision.availableActions.map((action) => (
                  <Button
                    key={action.key}
                    variant={action.semantic === 'reject' ? 'destructive' : action.semantic === 'disable' ? 'outline' : 'default'}
                    size="sm"
                    disabled={actionLoading}
                    data-action-semantic={action.semantic}
                    onClick={() => {
                      setRejectReason("");
                      setPendingAction(action);
                    }}
                  >
                    {localizeActionLabel(action, t)}
                  </Button>
                ))}
              </div>
              {ownerDecision.blockers.length > 0 && (
                <ul className="mt-3 space-y-1 text-[12px] text-ink-3">
                  {ownerDecision.blockers.map((blocker, index) => (
                    <li key={`blk-${index}`} data-testid="owner-decision-blocker">
                      {localizeBlocker(blocker.reason.code, blocker.reason.ownerText, t)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}
      {ownerDecision === null && ownerDecisionUnavailable !== null && (
        <section className="mb-8" data-testid="owner-decision-unavailable">
          <SectionTitle>{t("principles.detail.ownerDecision.title", { defaultValue: "这条原则的决策视图" })}</SectionTitle>
          <div className="rounded-[var(--radius-md)] border border-amber/30 bg-amber/5 p-4" role="status">
            <p className="text-ink-2 text-[13px]">
              {t("principles.detail.ownerDecision.unavailable", { defaultValue: "决策视图暂时不可用，无法据此做决定。" })}
            </p>
            <p className="mt-1 text-ink-4 text-[12px] font-mono">{ownerDecisionUnavailable.reason}</p>
          </div>
        </section>
      )}

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

      {/* ── Layer 2: Why (technical proposal fields — original texts) ────── */}
      <section className="mb-8">
        <SectionTitle>{t("principles.detail.whyExists")}</SectionTitle>

        <div className="space-y-3 mb-6">
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {t("principles.detail.applicable", { defaultValue: "适用场景（原始触发配置）" })}
            </span>
            <p className="text-ink-2 text-[14px] leading-relaxed font-mono break-all">
              {principle.triggerPattern || t("principles.detail.notSpecified", { defaultValue: "未指定" })}
            </p>
          </div>
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {t("principles.detail.expectedBehavior", { defaultValue: "预期行为（原始建议）" })}
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
                <div className="grid grid-cols-[auto 1fr] gap-x-4 gap-y-2 text-[13px]">
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

      {/* ── Action confirmation (SPEC §8.4) ─────────────────────────────── */}
      {pendingAction !== null && (
        <div className="border-t border-line pt-6 mt-6" data-testid="owner-decision-confirm">
          <SectionTitle>{pendingAction.label}</SectionTitle>
          <div className="mt-2 p-3 bg-gov/5 border border-gov/20 rounded-[var(--radius-md)]">
            {pendingAction.expectedConsequence.status === 'known' && (
              <div className="mb-3">
                {pendingAction.expectedConsequence.value.map((item, index) => (
                  <p key={`exp-${index}`} className="text-ink-2 text-[13px] leading-relaxed mb-1">{item.text}</p>
                ))}
              </div>
            )}
            <p className="text-ink-2 text-[13px] mb-3">{pendingAction.confirmation.text}</p>
            {pendingAction.requirements.some((req) => req.name === 'newArtifactId') && (
              <>
                <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
                  {t("principles.detail.editNewArtifactLabel", { defaultValue: "新的已验证工件 ID" })}
                </label>
                <input
                  type="text"
                  value={newArtifactId}
                  onChange={(e) => setNewArtifactId(e.target.value)}
                  placeholder={t("principles.detail.editNewArtifactPlaceholder", { defaultValue: "输入新的已验证工件 ID" })}
                  className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] mb-2 font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
                  aria-label={t("principles.detail.editNewArtifactPlaceholder", { defaultValue: "输入新的已验证工件 ID" })}
                />
              </>
            )}
            {pendingAction.requirements.some((req) => req.name === 'reason') && (
              <>
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
              </>
            )}
            <div className="flex gap-2 mt-3">
              <Button
                variant={pendingAction.semantic === 'reject' ? 'destructive' : 'default'}
                size="sm"
                disabled={actionLoading
                  || (pendingAction.requirements.some((req) => req.name === 'reason') && !rejectReason.trim())
                  || (pendingAction.requirements.some((req) => req.name === 'newArtifactId') && !newArtifactId.trim())}
                onClick={() => {
                  const action = pendingAction;
                  void submitOwnerAction(action, rejectReason.trim() === '' ? undefined : rejectReason.trim());
                }}
              >
                {t("principles.detail.confirm", { defaultValue: "确认" })}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setPendingAction(null); setRejectReason(""); setNewArtifactId(""); }}>
                {t("principles.detail.cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </PageShell>
  );
}

/** Small presentational block: known narrative items or the honest unknown. */
function OwnerNarrativeBlock({ label, field, testId }: {
  label: string;
  field: OwnerDecisionViewCore['incidentSummary'];
  testId: string;
}) {
  const rendered = narrativeTexts(field);
  return (
    <div className="mt-4" data-testid={testId}>
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">{label}</p>
      {rendered.status === 'known' ? (
        rendered.texts.length > 0 ? (
          rendered.texts.map((text, index) => (
            <p key={`${testId}-${index}`} className="mt-1 text-ink-2 text-[14px] leading-relaxed">{text}</p>
          ))
        ) : (
          <p className="mt-1 text-ink-4 text-[13px]">—</p>
        )
      ) : (
        <p className="mt-1 text-ink-3 text-[13px] leading-relaxed">{rendered.reason}</p>
      )}
    </div>
  );
}
