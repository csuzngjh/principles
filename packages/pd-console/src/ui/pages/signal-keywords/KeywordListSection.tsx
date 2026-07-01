import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, Trash2, Archive } from "lucide-react";
import { type SignalKeyword } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";

// ── Props ──────────────────────────────────────────────────────────────────

interface KeywordListSectionProps {
  keywords: SignalKeyword[];
  /** Phase 2: 删除关键词的回调 */
  onDelete?: (term: string) => void;
  /** Phase 2: 归档/恢复关键词的回调 */
  onToggleArchive?: (term: string) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type FilterTab = "all" | "active";

/** Phase 2 功能的 tooltip 文案 */
const PHASE2_TOOLTIP = "此操作将在后续版本中启用";

// ── Component ───────────────────────────────────────────────────────────────

export function KeywordListSection({
  keywords,
  onDelete,
  onToggleArchive,
}: KeywordListSectionProps) {
  const { t } = useTranslation();

  // 搜索文本
  const [search, setSearch] = useState("");
  // 筛选标签
  const [filterTab, setFilterTab] = useState<FilterTab>("all");

  // 过滤后的关键词列表
  const filtered = useMemo(() => {
    let list = keywords;

    // 按 filter tab 过滤
	    // Phase 1: 无 archived 状态，暂不过滤
	    // Phase 2: 添加对 archived 状态的过滤
	    void filterTab;

    // 按 search 文本过滤
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((kw) => kw.term.toLowerCase().includes(q));
    }

    return list;
  }, [keywords, search, filterTab]);

  // 分类中文映射
  const categoryLabel: Record<string, string> = {
    correction: t("pages.signalKeywords.filterActive"),
    empathy: "Empathy",
  };

  const hasWriteOps = !!onDelete || !!onToggleArchive;

  return (
    <section>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold text-ink">
          {t("pages.signalKeywords.title")}
        </h2>
        <span className="text-[12px] text-ink-4 tabular-nums">
          {filtered.length} / {keywords.length}
        </span>
      </div>

      {/* 搜索 + 筛选 */}
      <div className="flex items-center gap-3 mb-4">
        {/* 搜索框 */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-4" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("pages.signalKeywords.searchPlaceholder")}
            className="w-full h-9 pl-9 pr-3 text-[13px] bg-surface border border-line rounded-[4px] text-ink placeholder:text-ink-4 outline-none focus:border-gov transition-colors"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 p-0.5 bg-surface border border-line rounded-[4px]">
	          {(["all", "active"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilterTab(tab)}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-[3px] transition-colors ${
                filterTab === tab
                  ? "bg-gov/10 text-gov"
                  : "text-ink-4 hover:text-ink"
              }`}
            >
              {t(`pages.signalKeywords.filter${tab.charAt(0).toUpperCase() + tab.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>

      {/* 列表 */}
      {filtered.length === 0 ? (
        <div className="px-4 py-12 text-center text-[13px] text-ink-4 border border-dashed border-line-2 rounded-[4px]">
          {search.trim()
            ? t("pages.signalKeywords.searchPlaceholder")
            : t("pages.signalKeywords.empty")}
        </div>
      ) : (
        <div className="border border-line rounded-[4px] overflow-hidden">
          {/* 表头 */}
          <div className="grid grid-cols-[1fr_100px_90px_90px_80px] gap-3 px-4 py-2.5 bg-surface text-[11px] font-medium text-ink-4 uppercase tracking-[var(--tracking-wide)] border-b border-line">
            <span>{t("pages.signalKeywords.title")}</span>
            <span>{t("pages.signalKeywords.filterActive")}</span>
            <span>Precision</span>
            <span>Weight</span>
            {hasWriteOps && <span className="text-right">Actions</span>}
          </div>

          {/* 行 */}
          {filtered.map((kw) => (
            <div
              key={kw.term}
              className="grid grid-cols-[1fr_100px_90px_90px_80px] gap-3 px-4 py-3 items-center border-b border-line last:border-b-0 hover:bg-surface/50 transition-colors"
            >
              {/* Term */}
              <span className="text-[13px] text-ink font-medium truncate">
                {kw.term}
              </span>

              {/* Category */}
              <Badge variant={kw.category === "correction" ? "default" : "amber"}>
                {categoryLabel[kw.category] ?? kw.category}
              </Badge>

              {/* Precision */}
              <span className="text-[12px] text-ink-3">
                {kw.precision === "high" ? (
                  <span className="text-green">High</span>
                ) : (
                  <span className="text-amber">Ambiguous</span>
                )}
              </span>

              {/* Weight */}
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gov/60 transition-all"
                    style={{ width: `${kw.weight * 100}%` }}
                  />
                </div>
                <span className="text-[11px] text-ink-4 tabular-nums w-8 text-right">
                  {Math.round(kw.weight * 100)}%
                </span>
              </div>

              {/* Actions */}
              {hasWriteOps && (
                <div className="flex items-center justify-end gap-1">
                  {/* Archive / Unarchive */}
                  {onToggleArchive && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onToggleArchive(kw.term)}
                          disabled
                          className="p-1.5 text-ink-4 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          aria-label={t("pages.signalKeywords.archiveSuccess")}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{PHASE2_TOOLTIP}</TooltipContent>
                    </Tooltip>
                  )}

                  {/* Delete */}
                  {onDelete && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onDelete(kw.term)}
                          disabled
                          className="p-1.5 text-ink-4 hover:text-danger disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          aria-label={t("pages.signalKeywords.confirmDeleteTitle")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{PHASE2_TOOLTIP}</TooltipContent>
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
