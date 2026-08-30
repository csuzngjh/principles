/**
 * OwnerDecisionCard — PRI-629 统一 Owner Inbox 的决策卡（evaluator/rollout）。
 *
 * 第一层只回答 Owner 关心的问题 (SPEC §26): 发生了什么 / 为什么找我 /
 * 机器建议 / 可执行动作与后果。taskId / repairIteration / reasonCode 等
 * 实现细节收纳在折叠的高级诊断里。动作经 resolveOwnerDecision 服务端重读
 * durable facts — stale → 409,由本组件以可理解文案呈现并触发刷新。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { resolveOwnerDecision } from "../../api.js";
import type { OwnerDecisionItemData } from "../../utils/validators.js";

type VerdictAction = "accept_current" | "revise_once" | "reject_current";

export interface OwnerDecisionCardProps {
  item: OwnerDecisionItemData;
  onResolved: () => void;
}

export function OwnerDecisionCard({ item, onResolved }: OwnerDecisionCardProps) {
  const { t } = useTranslation();
  const [actionLoading, setActionLoading] = useState<VerdictAction | null>(null);
  const [instruction, setInstruction] = useState("");
  const [showInstruction, setShowInstruction] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const isTaskDecision = item.kind === "evaluator_review" || item.kind === "rollout_review";
  const canAccept = item.allowedActions.includes("accept_current");
  const canRevise = item.allowedActions.includes("revise_once");
  const canReject = item.allowedActions.includes("reject_current");

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

      {isTaskDecision ? (
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
          <div className="flex flex-wrap gap-2 mt-3">
            {canAccept && (
              <button
                type="button"
                onClick={() => handleAction("accept_current")}
                disabled={actionLoading !== null}
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
                disabled={actionLoading !== null}
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
                disabled={actionLoading !== null}
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
            </dl>
          )}
        </>
      ) : (
        <p className="mt-2 text-ink-4 text-[12px]">
          {item.kind === "activation_approval"
            ? t("pages.focus.ownerDecision.approvalHint")
            : t("pages.focus.ownerDecision.rulecodeHint")}
        </p>
      )}
    </article>
  );
}
