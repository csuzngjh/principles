import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, CheckCheck, XCircle } from "lucide-react";
import { type PendingSignalTerm } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";

// ── Props ──────────────────────────────────────────────────────────────────

interface PendingTermsSectionProps {
  terms: PendingSignalTerm[];
  /** Phase 2: 确认一个 pending term */
  onConfirm?: (term: PendingSignalTerm) => void;
  /** Phase 2: 忽略一个 pending term */
  onIgnore?: (term: string) => void;
  /** Phase 2: 批量确认 */
  onConfirmAll?: () => void;
  /** Phase 2: 批量忽略 */
  onIgnoreAll?: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// ── Component ───────────────────────────────────────────────────────────────

export function PendingTermsSection({
  terms,
  onConfirm,
  onIgnore,
  onConfirmAll,
  onIgnoreAll,
}: PendingTermsSectionProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const hasBatchOps = !!onConfirmAll || !!onIgnoreAll;
  const hasRowOps = !!onConfirm || !!onIgnore;

  // 分类中文映射
  const categoryLabel: Record<string, string> = {
    correction: t("pages.signalKeywords.categoryCorrection"),
    empathy: t("pages.signalKeywords.categoryEmpathy"),
  };

  // 切换选中
  const toggleSelected = (term: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(term)) {
        next.delete(term);
      } else {
        next.add(term);
      }
      return next;
    });
  };

  return (
    <section>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">
            {t("pages.signalKeywords.pendingTerms.title")}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-4 leading-[1.5]">
            {t("pages.signalKeywords.pendingTerms.subtitle")}
          </p>
        </div>
        {/* 计数 */}
        <span className="text-[12px] text-ink-4 tabular-nums">
          {t("pages.signalKeywords.nTerms", { count: terms.length })}
        </span>
      </div>

      {/* 批量操作栏（仅当有数据时显示）*/}
      {terms.length > 0 && hasBatchOps && (
        <div className="flex items-center justify-between mb-3 px-3 py-2 bg-surface border border-line rounded-[4px]">
          <span className="text-[12px] text-ink-4">
            {selected.size > 0
              ? t("pages.signalKeywords.selectedNOfTotal", { selected: selected.size, total: terms.length })
              : t("pages.signalKeywords.nTermsPendingReview", { count: terms.length })}
          </span>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onConfirmAll?.()}
                  disabled
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-green bg-green/10 rounded-[3px] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-green/20 transition-colors"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  {t("pages.signalKeywords.pendingTerms.confirmBatch")}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("pages.signalKeywords.phase2Tooltip")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onIgnoreAll?.()}
                  disabled
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-ink-4 bg-surface border border-line rounded-[3px] disabled:opacity-30 disabled:cursor-not-allowed hover:text-danger hover:border-danger/30 transition-colors"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {t("pages.signalKeywords.pendingTerms.ignoreBatch")}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("pages.signalKeywords.phase2Tooltip")}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* 列表 */}
      {terms.length === 0 ? (
        <div className="px-4 py-12 text-center text-[13px] text-ink-4 border border-dashed border-line-2 rounded-[4px]">
          <p>{t("pages.signalKeywords.pendingTerms.empty")}</p>
          <p className="mt-2 text-[12px]">
            {t("pages.signalKeywords.pendingTerms.emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="border border-line rounded-[4px] overflow-hidden">
          {/* 表头 */}
          <div className="grid grid-cols-[24px_1fr_100px_90px_1fr_100px] gap-3 px-4 py-2.5 bg-surface text-[11px] font-medium text-ink-4 uppercase tracking-[var(--tracking-wide)] border-b border-line items-center">
            {/* checkbox 占位 */}
            <span />

            <span>{t("pages.signalKeywords.colTerm")}</span>
            <span>{t("pages.signalKeywords.colCategory")}</span>
            <span>{t("pages.signalKeywords.colPrecision")}</span>
            <span>{t("pages.signalKeywords.colReason")}</span>
            {hasRowOps && <span className="text-right">{t("pages.signalKeywords.colActions")}</span>}
          </div>

          {/* 行 */}
          {terms.map((term) => (
            <div
              key={term.term}
              className="grid grid-cols-[24px_1fr_100px_90px_1fr_100px] gap-3 px-4 py-3 items-start border-b border-line last:border-b-0 hover:bg-surface/50 transition-colors"
            >
              {/* 多选框（Phase 2 启用） */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <input
                    type="checkbox"
                    checked={selected.has(term.term)}
                    onChange={() => toggleSelected(term.term)}
                    disabled
                    className="mt-0.5 h-3.5 w-3.5 rounded border-line text-gov disabled:opacity-30 disabled:cursor-not-allowed"
                  />
                </TooltipTrigger>
                <TooltipContent>{t("pages.signalKeywords.phase2Tooltip")}</TooltipContent>
              </Tooltip>

              {/* Term + 发现时间 */}
              <div className="min-w-0">
                <span className="text-[13px] text-ink font-medium block truncate">
                  {term.term}
                </span>
                <span className="text-[11px] text-ink-4 mt-0.5 block">
                  {new Date(term.discoveredAt).toLocaleDateString()}
                </span>
              </div>

              {/* Category */}
              <Badge variant={term.suggestedCategory === "correction" ? "default" : "amber"}>
                {categoryLabel[term.suggestedCategory] ?? term.suggestedCategory}
              </Badge>

              {/* Precision */}
              <span className="text-[12px] text-ink-3">
                {term.suggestedPrecision === "high" ? (
                  <span className="text-green">{t("pages.signalKeywords.precisionHigh")}</span>
                ) : (
                  <span className="text-amber">{t("pages.signalKeywords.precisionAmbiguous")}</span>
                )}
              </span>

              {/* Reason */}
              <span className="text-[12px] text-ink-3 leading-[1.5] line-clamp-2">
                {term.reason}
              </span>

              {/* Actions */}
              {hasRowOps && (
                <div className="flex items-center justify-end gap-1">
                  {/* Confirm */}
                  {onConfirm && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onConfirm(term)}
                          disabled
                          className="p-1.5 text-ink-4 hover:text-green disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          aria-label={t("pages.signalKeywords.pendingTerms.confirm")}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t("pages.signalKeywords.phase2Tooltip")}</TooltipContent>
                    </Tooltip>
                  )}

                  {/* Ignore */}
                  {onIgnore && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onIgnore(term.term)}
                          disabled
                          className="p-1.5 text-ink-4 hover:text-danger disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          aria-label={t("pages.signalKeywords.pendingTerms.ignore")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t("pages.signalKeywords.phase2Tooltip")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
