import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { DAILY_THOUGHTS, getDailyThoughtIndex } from "../../data/daily-thoughts.js";

const FEATURE_DAILY_THOUGHT_ENABLED = true;

function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function DailyThoughtCard() {
  const { t, i18n } = useTranslation();
  const [overrideIndex, setOverrideIndex] = useState<number | null>(null);
  const [isChanging, setIsChanging] = useState(false);

  const dailyIndex = useMemo(
    () => getDailyThoughtIndex(DAILY_THOUGHTS, formatLocalDate(new Date())),
    [],
  );
  const currentIndex = overrideIndex ?? dailyIndex;
  const thought = DAILY_THOUGHTS[currentIndex] ?? DAILY_THOUGHTS[0];
  const locale = i18n.language === "zh-CN" ? "zh" : "en";
  const content = thought?.[locale];

  const handleNext = useCallback(() => {
    if (isChanging) return;
    setIsChanging(true);
    window.setTimeout(() => {
      setOverrideIndex((prev) => {
        const base = prev ?? dailyIndex;
        return (base + 1) % DAILY_THOUGHTS.length;
      });
      setIsChanging(false);
    }, 200);
  }, [isChanging, dailyIndex]);

  if (!FEATURE_DAILY_THOUGHT_ENABLED) {
    return null;
  }

  if (!thought || !content) {
    return null;
  }

  return (
    <article
      aria-label={t("pages.focus.dailyThought.ariaLabel")}
      className="daily-thought-entrance bg-panel border border-line rounded-[6px] px-[18px] py-[14px] mb-7"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="breathing-dot" aria-hidden="true" />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
            {t("pages.focus.dailyThought.eyebrow")}
          </span>
        </div>
        <button
          type="button"
          onClick={handleNext}
          disabled={isChanging}
          aria-label={t("pages.focus.dailyThought.nextAriaLabel")}
          className="inline-flex items-center gap-1.5 text-[12px] text-gov hover:text-gov-2 transition-colors disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          {t("pages.focus.dailyThought.next")}
        </button>
      </div>
      <div
        className={`transition-opacity duration-200 ${
          isChanging ? "opacity-0" : "opacity-100"
        }`}
      >
        <p className="font-semibold text-ink text-[15px] leading-snug">
          {content.quote}
        </p>
        <p className="mt-1 text-ink-3 text-[13px]">
          {t("pages.focus.dailyThought.authorPrefix", { defaultValue: "——" })}
          {content.author}
        </p>
        <p className="mt-3 text-ink-3 text-[13px] leading-relaxed">
          {content.note}
        </p>
      </div>
    </article>
  );
}
