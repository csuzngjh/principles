import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { DAILY_THOUGHTS, getDailyThoughtIndex } from "../../data/daily-thoughts.js";
import { localDateKey } from "../../pages/review/review-session.js";

const ARTWORK = [
  "today-sediment.webp",
  "today-notebook.webp",
  "principle-river-print.webp",
  "principle-stone-steps.webp",
  "principle-grove.webp",
] as const;

export function DailyThoughtCard() {
  const { t, i18n } = useTranslation();
  const [index, setIndex] = useState(() => getDailyThoughtIndex(DAILY_THOUGHTS, localDateKey()));
  const thought = DAILY_THOUGHTS[index];
  if (!thought) return null;

  const content = thought[i18n.resolvedLanguage === "zh-CN" ? "zh" : "en"];

  return (
    <article className="today-artwork" aria-label={t("pages.focus.dailyThought.ariaLabel")}>
      <img
        className="today-artwork-image"
        src={`/assets/${ARTWORK[index % ARTWORK.length]}`}
        alt=""
        decoding="async"
      />
      <div className="today-artwork-caption">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <span className="font-mono text-caption text-ink-3">
            {t("pages.focus.dailyThought.eyebrow")}
          </span>
          <button
            type="button"
            onClick={() => setIndex((current) => (current + 1) % DAILY_THOUGHTS.length)}
            aria-label={t("pages.focus.dailyThought.nextAriaLabel")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-caption text-gov hover:text-gov-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gov"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {t("pages.focus.dailyThought.next")}
          </button>
        </div>
        <div aria-live="polite" aria-atomic="true">
          <blockquote className="today-artwork-quote">{content.quote}</blockquote>
          <p className="mt-2 text-caption text-ink-3">
            {thought.sourceUrl ? (
              <a className="underline underline-offset-4 hover:text-gov focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gov" href={thought.sourceUrl} target="_blank" rel="noreferrer">
                {content.author}
              </a>
            ) : content.author}
          </p>
          <p className="mt-3 max-w-prose text-body leading-relaxed text-ink-2">{content.note}</p>
        </div>
      </div>
    </article>
  );
}
