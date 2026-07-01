import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  listActiveSignalKeywords,
  listPendingSignalTerms,
  type SignalKeyword,
  type PendingSignalTerm,
} from "../../api.js";
import { KeywordListSection } from "./KeywordListSection.js";
import { PendingTermsSection } from "./PendingTermsSection.js";
import { KeywordEditDialog } from "./KeywordEditDialog.js";

export function SignalKeywordsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [keywords, setKeywords] = useState<SignalKeyword[]>([]);
  const [pendingTerms, setPendingTerms] = useState<PendingSignalTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [kwResult, ptResult] = await Promise.all([
        listActiveSignalKeywords(),
        listPendingSignalTerms(),
      ]);
      if (!kwResult.success) {
        setError(t("pages.signalKeywords.loadError"));
        return;
      }
      if (!ptResult.success) {
        setError(t("pages.signalKeywords.loadError"));
        return;
      }
      setKeywords(kwResult.data ?? []);
      setPendingTerms(ptResult.data ?? []);
    } catch {
      setError(t("pages.signalKeywords.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="max-w-[960px] mx-auto px-6 py-8">
      {/* 面包屑导航 */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={() => navigate("/control-center")}
          className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("pages.controlCenter.eyebrow")}
        </button>
        <span className="text-ink-4 text-[13px]">/</span>
        <span className="text-[13px] text-ink font-medium">
          {t("pages.signalKeywords.title")}
        </span>
      </div>

      {/* 错误状态 */}
      {error && (
        <div className="mb-6 px-4 py-3 border border-danger rounded-[4px] bg-danger/10 text-[13px] text-danger">
          {error}
        </div>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-gov border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* 内容区域 */}
      {!loading && !error && (
        <div className="space-y-8">
          {/* 页面标题 */}
          <div>
            <h1 className="text-[20px] font-semibold text-ink tracking-[-0.01em]">
              {t("pages.signalKeywords.title")}
            </h1>
            <p className="mt-1 text-[13px] text-ink-3 leading-[1.55]">
              {t("pages.signalKeywords.subtitle")}
            </p>
          </div>

          {/* 关键词列表 */}
          <KeywordListSection
            keywords={keywords}
            // Phase 2: onDelete / onToggleArchive
          />

          {/* 待确认信号词 */}
          <PendingTermsSection
            terms={pendingTerms}
            // Phase 2: onConfirm / onIgnore / onConfirmAll / onIgnoreAll
          />

          {/* 添加关键词入口 —— Phase 2 启用 */}
          <div className="pt-2 border-t border-line">
            <KeywordEditDialog
              // Phase 2: onSubmit
            />
          </div>
        </div>
      )}
    </div>
  );
}
