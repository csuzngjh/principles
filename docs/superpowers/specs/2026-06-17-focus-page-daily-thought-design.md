# Focus Page Daily Thought — Design Spec

## 1. Summary

Add a small, curated "daily thought" card to the **Focus page** of the PD Console WebUI. The card displays a timeless thinking principle (Chinese and Western, with bilingual support) to nudge the owner toward long-term, deliberate judgment before acting on governance decisions.

This is a **pure UI enhancement** — it does not affect PD's core governance flow, does not introduce new backend/CLI subsystems, and does not expand the product boundary defined in `PRODUCT_IDENTITY.md`.

## 2. Problem & Goal

- **Problem**: The PD Console is intentionally minimal and static. While this supports clarity, it offers no visual resting point or moment of reflection before the owner makes governance decisions.
- **Goal**: Add one to two restrained, purposeful touches (a thought card + subtle animation) that:
  1. Create a brief pause before judgment.
  2. Reinforce long-term thinking without competing with primary actions.
  3. Remain visually calm, precise, and aligned with the existing design system.

## 3. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Content source | Curated static library (~30 entries) | Decoupled from PD's actual active principles; acts as inspiration, not system state. |
| Location | Focus page only, between `ProseSummary` and `FeedbackStratification` | The Focus page is the decision entry point; the card serves as a "pause before judgment." |
| Rotation | Daily fixed quote + manual "next" button | Daily fixed gives ritual; manual refresh gives control. |
| Animation | (1) Card entrance fade + slight upward translate; (2) left-edge breathing dot | Two restrained motion touches; no looping motion on text itself. |
| Language | Bilingual: Chinese and English per entry, keyed by `i18n.language` | Aligns with existing `language-switcher` and user profile preference. |
| Card structure | Standard: quote + author/source + one-sentence note | Enough context to land; not verbose. |
| Implementation path | Pure frontend static data in `pd-console/src/ui/` | Avoids backend/CLI scope creep for a decorative feature. |
| MVP triage | MVP-Quiet | Decorative UI feature; should ship behind a feature flag once `PRI-239` is merged. Until then, code is implemented with a local kill-switch constant so it can be disabled without migration. |

## 4. Visual Design

### 4.1 Layout

```
治理焦点
现在，值得你判断的事
这一页只回答一个问题：现在该做什么判断。

当前：3 条待审 / 2 条行为偏差 / 1 条停滞信号

┌──────────────────────────────────────────────────────────────┐
│ • 在判断之前                                                 │  ← eyebrow + breathing dot
│                                                              │
│ 慢即是快                                                     │  ← quote (locale-dependent)
│ —— 老子《道德经》                                            │  ← author/source
│                                                              │
│ 急于求成往往欲速不达，慢下来才能看清全局。                    │  ← annotation
│                                         [↻ 换一句]          │  ← refresh action
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ 今日反馈分层                                                 │
│ [秒级拦截] [系统处理中] [需你判断]                            │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Styling (reuse existing tokens)

- Card container: `bg-panel border border-line rounded-[6px] px-[18px] py-[14px]` (same as `ProseSummary`).
- Eyebrow: `font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4` (same as `FeedbackStratification` label).
- Quote: `font-semibold text-ink text-[15px] leading-snug`.
- Author/source: `text-ink-3 text-[13px]`.
- Annotation: `text-ink-3 text-[13px] leading-relaxed`.
- Refresh action: small ghost button with `RefreshCw` icon + label, `text-gov hover:text-gov-2`.
- Breathing dot: 6px circle on the left edge, color `text-gov`, opacity pulse 4s infinite.

### 4.3 Animation Details

1. **Entrance** (on mount, when feature enabled):
   - `opacity: 0 → 1`, `translateY: 6px → 0`
   - Duration: 400ms, easing: `ease-out`
   - Only runs once per page load; no infinite motion on text.

2. **Breathing dot** (left of eyebrow):
   - `opacity: 0.4 → 1 → 0.4`
   - Duration: 4s, easing: `ease-in-out`, iteration: infinite
   - Serves as the single visual resting point; slow enough to be calm.

3. **Quote refresh** (on manual next):
   - Card cross-fades: old quote `opacity → 0`, new quote `opacity → 1`
   - Duration: 200ms
   - No layout shift; height stays stable.

All animations use CSS transitions/keyframes, not JS-driven motion, to respect `prefers-reduced-motion`.

## 5. Data Model

### 5.1 Quote Entry Schema

```ts
// packages/pd-console/src/ui/data/daily-thoughts.ts
export interface DailyThought {
  id: string;
  zh: {
    quote: string;
    author: string;
    note: string;
  };
  en: {
    quote: string;
    author: string;
    note: string;
  };
}
```

### 5.2 Selection Algorithm

- **Daily default**: `index = hash(dateString) % thoughts.length`
  - `dateString` = `YYYY-MM-DD` in local time.
  - Hash = simple string hash (FNV-1a or similar) so the same date always yields the same quote.
- **Manual refresh**: `nextIndex = (currentIndex + 1) % thoughts.length`
  - Stored in component state only; does not persist across sessions.
  - After manual refresh, the daily hash is ignored until the component unmounts/remounts.

## 6. Component Design

### 6.1 Files

| File | Purpose |
|------|---------|
| `packages/pd-console/src/ui/data/daily-thoughts.ts` | Static quote library (~30 entries). |
| `packages/pd-console/src/ui/components/focus/daily-thought-card.tsx` | Card UI + animation + refresh logic. |
| `packages/pd-console/src/ui/pages/focus/FocusPage.tsx` | Insert card between `ProseSummary` and `FeedbackStratification`. |
| `packages/pd-console/src/ui/i18n/zh-CN.json` | Add `pages.focus.dailyThought.*` keys. |
| `packages/pd-console/src/ui/i18n/en.json` | Add `pages.focus.dailyThought.*` keys. |
| `packages/pd-console/src/ui/styles/globals.css` | Add `.daily-thought-entrance` and `.breathing-dot` keyframes. |

### 6.2 Component API

```tsx
// DailyThoughtCard is self-contained; FocusPage renders it unconditionally
// but the feature is gated internally via a local flag.
export function DailyThoughtCard() {
  const { t, i18n } = useTranslation();
  const thought = useDailyThought();
  const [isChanging, setIsChanging] = useState(false);

  if (!FEATURE_DAILY_THOUGHT_ENABLED) {
    return null;
  }

  return (
    <article className="daily-thought-entrance ...">
      <div className="flex items-center gap-2 mb-3">
        <span className="breathing-dot" aria-hidden="true" />
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-4">
          {t("pages.focus.dailyThought.eyebrow")}
        </span>
      </div>
      {/* quote, author, note, refresh button */}
    </article>
  );
}
```

### 6.3 Feature Kill-Switch

```ts
// packages/pd-console/src/ui/components/focus/daily-thought-card.tsx
const FEATURE_DAILY_THOUGHT_ENABLED = true;
```

Once `PRI-239` (feature-flag registry) is merged, this constant is replaced by a real flag lookup. Until then, setting it to `false` disables the card with zero migration.

## 7. Accessibility

- Card is an `<article>` with `aria-label={t("pages.focus.dailyThought.ariaLabel")}`.
- Refresh button has an explicit `aria-label`.
- Animations respect `prefers-reduced-motion: reduce`:
  - Entrance animation disabled.
  - Breathing dot opacity animation disabled.
  - Refresh cross-fade disabled.

## 8. Testing

- **Unit test**: `packages/pd-console/tests/ui/daily-thought.test.ts`
  - Daily selection is deterministic for a given date string.
  - Manual refresh cycles through the library.
  - Locale switching picks the correct language variant.
  - Empty/broken library degrades gracefully (fallback to first entry, logged warning).
- **Visual regression**: Existing FocusPage test snapshots may need updating; no new E2E.
- **Reduced motion**: Verify CSS media query disables motion.

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Quotes feel out of place or distracting | Keep card visually subdued (panel/line, no icon colors except gov dot); place below summary, above actions. |
| Animation violates "calm" aesthetic | Use only opacity/translate transforms; 4s breathing cycle; respect `prefers-reduced-motion`. |
| Content becomes stale | ~30-entry library + manual refresh gives variety; future PR can extend library without structural change. |
| Feature flag not yet ready | Local boolean kill-switch; migration to flag registry is a single-line change once `PRI-239` lands. |
| Translations drift | Each entry is a self-contained bilingual object; `i18n.language` selects variant at runtime. |

## 10. Out of Scope

- Backend API for quotes.
- User-customizable quotes.
- Per-workspace or per-owner quote preferences.
- Analytics on quote views/refreshes.
- Any connection to PD's actual active principles or pain signals.

## 11. Acceptance Criteria

- [ ] A daily thought card appears on `/focus` between the summary and feedback stratification.
- [ ] The same date always shows the same quote.
- [ ] Clicking "换一句 / Next thought" advances to the next quote with a cross-fade.
- [ ] Switching language via the language switcher updates the quote text to the matching locale.
- [ ] Animations are subtle and respect `prefers-reduced-motion`.
- [ ] Focus page tests pass and lint is clean.
- [ ] Feature can be disabled by flipping the local kill-switch.
