/**
 * OwnerDecisionCard — PRI-629 统一 Owner Inbox 的决策卡（evaluator/rollout）。
 *
 * 第一层只回答 Owner 关心的问题 (SPEC §26): 发生了什么 / 为什么找我 /
 * 机器建议 / 可执行动作与后果。taskId / repairIteration / reasonCode 等
 * 实现细节收纳在折叠的高级诊断里。动作经 resolveOwnerDecision 服务端重读
 * durable facts — stale → 409,由本组件以可理解文案呈现并触发刷新。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { resolveOwnerDecision } from "../../api.js";
import type { OwnerDecisionItemData } from "../../utils/validators.js";

type VerdictAction = "accept_current" | "revise_once" | "reject_current";

export interface OwnerDecisionCardProps {
  item: OwnerDecisionItemData;
  onResolved: () => void;
  governanceReady?: boolean;
}

export function OwnerDecisionCard({ item, onResolved, governanceReady = true }: OwnerDecisionCardProps) {
  const { t } = useTranslation();
  const [actionLoading, setActionLoading] = useState<VerdictAction | null>(null);
  const [instruction, setInstruction] = useState("");
  const [showInstruction, setShowInstruction] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [partialEvidenceAcknowledged, setPartialEvidenceAcknowledged] = useState(false);

  const isTaskDecision = item.kind === "evaluator_review" || item.kind === "rollout_review";
  const canAccept = item.allowedActions.includes("accept_current");
  const canRevise = item.allowedActions.includes("revise_once");
  const canReject = item.allowedActions.includes("reject_current");
  const requiresPartialAcknowledgement = item.review?.capability.acceptRequirement.kind === "acknowledge_partial_evidence";
  const evidenceUnavailable = item.evidenceUnavailableReason !== undefined;

  async function handleAction(action: VerdictAction) {
    if (action === "revise_once" && showInstruction && instruction.trim().length === 0) {
      // 指导为空也可以提交 — instruction 是可选的;这里仅在展开输入后要求非空确认
      // (避免误提交空指导),Owner 可收起输入直接提交。
      toast.error(t("pages.focus.ownerDecision.instructionRequired"));
      return;
    }
    setActionLoading(action);
    try {
      const response = await resolveOwnerDecision(item.taskId, {
        action,
        reviewKey: item.reviewKey,
        expectedRevisionEpoch: item.expectedRevisionEpoch,
        expectedSourceRunId: item.expectedSourceRunId,
        expectedSourceArtifactId: item.expectedSourceArtifactId,
        expectedSourceArtifactHash: item.expectedSourceArtifactHash,
        expectedEvidenceDigest: item.expectedEvidenceDigest ?? "",
        ...(action === "accept_current" && requiresPartialAcknowledgement && partialEvidenceAcknowledged
          ? { acknowledgement: { kind: "partial_evidence" as const, acknowledged: true as const } }
          : {}),
        ...(action === "revise_once" && instruction.trim().length > 0
          ? { ownerInstruction: instruction.trim() }
          : { ownerInstruction: null }),
      });
      if (!response.success) {
        if (response.error === "stale_owner_decision") {
          toast.error(t("pages.focus.ownerDecision.staleError"));
        } else if (response.error === "already_resolved") {
          toast.info(t("pages.focus.ownerDecision.alreadyResolved"));
        } else {
          toast.error(response.error ?? t("pages.focus.ownerDecision.actionFailed"));
        }
        onResolved();
        return;
      }
      toast.success(t("pages.focus.ownerDecision.resolved"));
      onResolved();
    } catch {
      toast.error(t("pages.focus.ownerDecision.actionFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  const kindLabel = item.kind === "rollout_review"
    ? t("pages.focus.ownerDecision.kindRollout")
    : item.kind === "activation_approval"
      ? t("pages.focus.ownerDecision.kindApproval")
      : item.kind === "rulecode_decision"
        ? t("pages.focus.ownerDecision.kindRulecode")
        : t("pages.focus.ownerDecision.kindEvaluator");

  return (
    <article className="bg-panel border border-line rounded-[6px] p-4 mb-3" data-testid={`owner-decision-${item.taskId}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="text-ink text-[14px] font-medium leading-snug">{item.title}</h3>
          <div className="mt-1 text-ink-4 text-[11px] font-mono uppercase tracking-[0.08em]">{kindLabel}</div>
        </div>
        {item.legacy && (
          <span className="shrink-0 text-ink-4 border border-line rounded-[2px] px-[7px] py-[3px] text-[10.5px] font-mono">
            {t("pages.focus.ownerDecision.legacyBadge")}
          </span>
        )}
      </div>

      <p className="text-ink-2 text-[13px] leading-relaxed mb-2">{item.summary}</p>

      {item.review?.brief.kind === "evaluator" && (
        <div className="mb-3 grid gap-2 text-[12.5px] leading-relaxed">
          {item.review.brief.principle?.statement && (
            <p><span className="font-medium text-ink">{t("pages.focus.ownerDecision.principleLabel")}</span>{" "}{item.review.brief.principle.statement}</p>
          )}
          {item.review.brief.implementation?.summary && (
            <p><span className="font-medium text-ink">{t("pages.focus.ownerDecision.implementationLabel")}</span>{" "}{item.review.brief.implementation.summary}</p>
          )}
          {(item.review.brief.concerns?.length ?? 0) > 0 && (
            <p className="text-amber"><span className="font-medium">{t("pages.focus.ownerDecision.concernLabel")}</span>{" "}{item.review.brief.concerns?.[0]}</p>
          )}
        </div>
      )}
      {item.review?.brief.kind === "rollout" && item.review.brief.summary && (
        <p className="mb-3 text-[12.5px] text-ink-2">{item.review.brief.summary}</p>
      )}

      {item.review && (
        <div className="mb-2 flex flex-wrap gap-2 text-[10.5px] font-mono uppercase tracking-[0.06em]">
          <span className="rounded-[2px] border border-line px-2 py-1 text-ink-3">
            {t(`pages.focus.ownerDecision.evidence.${item.review.evidence.completeness}`)}
          </span>
          {item.review.evidence.deterministicChecks.map(check => (
            <span key={check.check} className="rounded-[2px] border border-line px-2 py-1 text-ink-3">
              {check.check}: {check.status}
            </span>
          ))}
        </div>
      )}

      {item.machineRecommendation && (
        <p className="text-ink-3 text-[12.5px] mb-1">
          <span className="font-medium">{t("pages.focus.ownerDecision.machineRecommendationLabel")}</span>{" "}
          {item.machineRecommendation}
          {item.score !== undefined && <span className="font-mono ml-1">{item.score.toFixed(2)}</span>}
        </p>
      )}
      {item.kind === "rollout_review" && (
        <p className="text-ink-4 text-[12px] mb-1">{t("pages.focus.ownerDecision.rolloutSafetyNote")}</p>
      )}

      {evidenceUnavailable ? (
        <div className="mt-3 rounded-[3px] border border-amber/40 bg-amber/5 p-3">
          <p className="text-ink-2 text-[12.5px] leading-relaxed">
            {t("pages.focus.ownerDecision.evidenceUnavailable")}
          </p>
          <Link
            to="/failed"
            data-testid={`owner-evidence-recover-${item.taskId}`}
            className="mt-2 inline-flex items-center border border-line text-ink bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors"
          >
            {t("pages.focus.ownerDecision.goRecoverCta")}
          </Link>
        </div>
      ) : isTaskDecision ? (
        <>
          {showInstruction && (
            <div className="mt-2 mb-2">
              <label className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
                {t("pages.focus.ownerDecision.instructionLabel")}
              </label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value.slice(0, 500))}
                data-testid={`owner-instruction-${item.taskId}`}
                placeholder={t("pages.focus.ownerDecision.instructionPlaceholder")}
                className="w-full border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] min-h-[64px] resize-y focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
              />
            </div>
          )}
          {requiresPartialAcknowledgement && (
            <label className="mt-2 mb-1 flex items-start gap-2 text-[12px] text-ink-3">
              <input
                type="checkbox"
                checked={partialEvidenceAcknowledged}
                onChange={(event) => setPartialEvidenceAcknowledged(event.target.checked)}
                data-testid={`owner-partial-evidence-ack-${item.taskId}`}
                className="mt-0.5"
              />
              <span>{t("pages.focus.ownerDecision.partialEvidenceAcknowledgement")}</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            {canAccept && (
              <button
                type="button"
                onClick={() => handleAction("accept_current")}
                disabled={!governanceReady || actionLoading !== null || (requiresPartialAcknowledgement && !partialEvidenceAcknowledged)}
                data-testid={`owner-accept-${item.taskId}`}
                className="inline-flex items-center border border-gov text-gov bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-gov/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionLoading === "accept_current" ? t("common.loading") : t("pages.focus.ownerDecision.acceptCurrent")}
              </button>
            )}
            {canRevise && (
              <button
                type="button"
                onClick={() => {
                  if (!showInstruction) {
                    setShowInstruction(true);
                    return;
                  }
                  void handleAction("revise_once");
                }}
                disabled={!governanceReady || actionLoading !== null}
                data-testid={`owner-revise-${item.taskId}`}
                className="inline-flex items-center border border-line text-ink bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionLoading === "revise_once" ? t("common.loading") : t("pages.focus.ownerDecision.reviseOnce")}
              </button>
            )}
            {canReject && (
              <button
                type="button"
                onClick={() => handleAction("reject_current")}
                disabled={!governanceReady || actionLoading !== null}
                data-testid={`owner-reject-${item.taskId}`}
                className="inline-flex items-center border border-danger text-danger bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-danger/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionLoading === "reject_current" ? t("common.loading") : t("pages.focus.ownerDecision.rejectCurrent")}
              </button>
            )}
          </div>
          <div className="mt-2 text-ink-4 text-[11.5px] leading-relaxed">
            {t("pages.focus.ownerDecision.actionConsequence")}
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="mt-2 text-ink-4 text-[11px] font-mono uppercase tracking-[0.08em] hover:text-ink-3"
            data-testid={`owner-advanced-toggle-${item.taskId}`}
          >
            {showAdvanced ? "▾" : "▸"} {t("pages.focus.ownerDecision.advanced")}
          </button>
          {showAdvanced && (
            <dl className="mt-2 grid gap-1 text-[11.5px] font-mono text-ink-4">
              <div>taskId: {item.taskId}</div>
              <div>reasonCode: {item.reasonCode}</div>
              <div>reviewKey: {item.reviewKey.slice(0, 24)}…</div>
              <div>epoch: {item.expectedRevisionEpoch}</div>
              {item.review?.brief.requiredChanges.map((change, index) => (
                <div key={`${change}-${index}`}>requiredChange: {change}</div>
              ))}
              {item.review?.evidence.items.map((evidence, index) => (
                <div key={`${evidence.label}-${index}`}>{evidence.evidenceClass}/{evidence.label}: {evidence.value}</div>
              ))}
            </dl>
          )}
        </>
      ) : (
        <div className="mt-2">
          <p className="text-ink-4 text-[12px] mb-2">
            {item.kind === "activation_approval"
              ? t("pages.focus.ownerDecision.approvalHint")
              : t("pages.focus.ownerDecision.rulecodeHint")}
          </p>
          {/* P1 评审修复: 真实 CTA — 不再只渲染提示 (否则出现"有决策但不能处理") */}
          {item.kind === "activation_approval" ? (
            <Link
              to="/principles"
              data-testid={`go-approvals-${item.taskId}`}
              className="inline-flex items-center border border-gov text-gov bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-gov/5 transition-colors"
            >
              {t("pages.focus.ownerDecision.goApprovalsCta")}
            </Link>
          ) : (
            <Link
              to="/activation"
              data-testid={`go-activation-${item.taskId}`}
              className="inline-flex items-center border border-gov text-gov bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-gov/5 transition-colors"
            >
              {t("pages.focus.ownerDecision.goActivationCta")}
            </Link>
          )}
        </div>
      )}
    </article>
  );
}
