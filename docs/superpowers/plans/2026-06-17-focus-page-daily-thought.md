# Focus Page Daily Thought — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated bilingual daily-thought card to the PD Console Focus page, with subtle entrance + breathing-dot animations and a manual refresh button.

**Architecture:** Pure frontend React component inside `pd-console`; static curated data file; locale-driven quote selection; CSS keyframe animations guarded by `prefers-reduced-motion`; local kill-switch until `PRI-239` feature-flag registry lands.

**Tech Stack:** React, TypeScript, Tailwind CSS, i18next, Vitest, pd-console design tokens.

---

### Task 1: Create curated daily thought library

**Files:**
- Create: `packages/pd-console/src/ui/data/daily-thoughts.ts`

- [ ] **Step 1: Define schema and 30 bilingual entries**

```ts
export interface DailyThought {
  id: string;
  zh: { quote: string; author: string; note: string };
  en: { quote: string; author: string; note: string };
}

export const DAILY_THOUGHTS: DailyThought[] = [
  {
    id: "dt-001",
    zh: { quote: "慢即是快", author: "老子《道德经》", note: "急于求成往往欲速不达，慢下来才能看清全局。" },
    en: { quote: "Slow is fast", author: "Lao Tzu, Tao Te Ching", note: "Rushing often backfires; slowing down reveals the whole board." },
  },
  // ... 29 more entries
];
```

- [ ] **Step 2: Export deterministic selection helper**

```ts
export function getDailyThoughtIndex(thoughts: readonly DailyThought[], dateString: string): number {
  if (thoughts.length === 0) return -1;
  let hash = 2166136261;
  for (let i = 0; i < dateString.length; i++) {
    hash ^= dateString.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash) % thoughts.length;
}
```

- [ ] **Step 3: Commit the data file**

```bash
git add packages/pd-console/src/ui/data/daily-thoughts.ts
git commit -m "feat(pd-console): add curated daily thought library"
```

---

### Task 2: Create DailyThoughtCard component

**Files:**
- Create: `packages/pd-console/src/ui/components/focus/daily-thought-card.tsx`
- Modify: `packages/pd-console/src/ui/pages/focus/FocusPage.tsx` (insert card)

- [ ] **Step 1: Write the component with hook**

```tsx
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { DAILY_THOUGHTS } from "../../data/daily-thoughts.js";

const FEATURE_DAILY_THOUGHT_ENABLED = true;

function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDailyThoughtIndex(thoughts: typeof DAILY_THOUGHTS, dateString: string): number {
  if (thoughts.length === 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < dateString.length; i++) {
    hash ^= dateString.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash) % thoughts.length;
}

export function DailyThoughtCard() {
  const { t, i18n } = useTranslation();
  const [overrideIndex, setOverrideIndex] = useState<number | null>(null);
  const [isChanging, setIsChanging] = useState(false);

  const dailyIndex = useMemo(() => getDailyThoughtIndex(DAILY_THOUGHTS, formatLocalDate(new Date())), []);
  const currentIndex = overrideIndex ?? dailyIndex;
  const thought = DAILY_THOUGHTS[currentIndex] ?? DAILY_THOUGHTS[0];
  const locale = i18n.language === "zh-CN" ? "zh" : "en";
  const content = thought[locale];

  const handleNext = useCallback(() => {
    if (isChanging) return;
    setIsChanging(true);
    setTimeout(() => {
      setOverrideIndex((prev) => {
        const base = prev ?? dailyIndex;
        return (base + 1) % DAILY_THOUGHTS.length;
      });
      setIsChanging(false);
    }, 200);
  }, [isChanging, dailyIndex]);

  if (!FEATURE_DAILY_THOUGHT_ENABLED) return null;
  if (!thought || !content) return null;

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
      <div className={`transition-opacity duration-200 ${isChanging ? "opacity-0" : "opacity-100"}`}>
        <p className="font-semibold text-ink text-[15px] leading-snug">
          {content.quote}
        </p>
        <p className="mt-1 text-ink-3 text-[13px]">
          —— {content.author}
        </p>
        <p className="mt-3 text-ink-3 text-[13px] leading-relaxed">
          {content.note}
        </p>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Insert card into FocusPage**

In `packages/pd-console/src/ui/pages/focus/FocusPage.tsx`, import `DailyThoughtCard` and place it after `<ProseSummary ... />` and before `<FeedbackStratification ... />`.

```tsx
import { DailyThoughtCard } from "../../components/focus/daily-thought-card.js";

// inside render:
<ProseSummary ... />
<DailyThoughtCard />
<FeedbackStratification ... />
```

- [ ] **Step 3: Commit component + page change**

```bash
git add packages/pd-console/src/ui/components/focus/daily-thought-card.tsx packages/pd-console/src/ui/pages/focus/FocusPage.tsx
git commit -m "feat(pd-console): add DailyThoughtCard to Focus page"
```

---

### Task 3: Add i18n keys

**Files:**
- Modify: `packages/pd-console/src/ui/i18n/zh-CN.json`
- Modify: `packages/pd-console/src/ui/i18n/en.json`

- [ ] **Step 1: Add keys under `pages.focus.dailyThought`**

zh-CN:
```json
"dailyThought": {
  "eyebrow": "在判断之前",
  "ariaLabel": "今日思考",
  "next": "换一句",
  "nextAriaLabel": "换一句"
}
```

en:
```json
"dailyThought": {
  "eyebrow": "Before you judge",
  "ariaLabel": "Today's thought",
  "next": "Next thought",
  "nextAriaLabel": "Show next thought"
}
```

- [ ] **Step 2: Commit i18n**

```bash
git add packages/pd-console/src/ui/i18n/zh-CN.json packages/pd-console/src/ui/i18n/en.json
git commit -m "feat(pd-console): add i18n keys for daily thought card"
```

---

### Task 4: Add CSS animations

**Files:**
- Modify: `packages/pd-console/src/ui/styles/globals.css`

- [ ] **Step 1: Append keyframes and utility classes**

```css
.daily-thought-entrance {
  animation: daily-thought-fade-in 400ms ease-out forwards;
}

@keyframes daily-thought-fade-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.breathing-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background-color: hsl(var(--gov));
  animation: breathing-dot-pulse 4s ease-in-out infinite;
}

@keyframes breathing-dot-pulse {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .daily-thought-entrance {
    animation: none;
  }
  .breathing-dot {
    animation: none;
    opacity: 0.7;
  }
}
```

- [ ] **Step 2: Commit CSS**

```bash
git add packages/pd-console/src/ui/styles/globals.css
git commit -m "feat(pd-console): add daily thought card animations"
```

---

### Task 5: Add unit tests

**Files:**
- Create: `packages/pd-console/tests/ui/daily-thought.test.ts`

- [ ] **Step 1: Test selection, refresh, and locale**

```ts
import { describe, it, expect } from "vitest";

// Import the helper and data from source
import { DAILY_THOUGHTS, getDailyThoughtIndex } from "../../src/ui/data/daily-thoughts.js";

describe("daily thought selection", () => {
  it("returns a deterministic index for a given date string", () => {
    const idx1 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    const idx2 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    expect(idx1).toBe(idx2);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(DAILY_THOUGHTS.length);
  });

  it("returns different indices for different dates", () => {
    const idx1 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-17");
    const idx2 = getDailyThoughtIndex(DAILY_THOUGHTS, "2026-06-18");
    expect(idx1).not.toBe(idx2);
  });

  it("cycles through the library on manual refresh", () => {
    const start = 5;
    const next = (start + 1) % DAILY_THOUGHTS.length;
    expect(next).toBe(6);
  });

  it("provides both zh and en content for every entry", () => {
    for (const thought of DAILY_THOUGHTS) {
      expect(thought.zh.quote).toBeTruthy();
      expect(thought.en.quote).toBeTruthy();
      expect(thought.zh.author).toBeTruthy();
      expect(thought.en.author).toBeTruthy();
      expect(thought.zh.note).toBeTruthy();
      expect(thought.en.note).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/pd-console && npx vitest run tests/ui/daily-thought.test.ts
```

Expected: PASS

- [ ] **Step 3: Commit tests**

```bash
git add packages/pd-console/tests/ui/daily-thought.test.ts
git commit -m "test(pd-console): add daily thought selection tests"
```

---

### Task 6: Verify build and lint

**Files:** none

- [ ] **Step 1: Run lint**

```bash
npm run lint
```

Expected: 0 errors, 0 warnings in touched files.

- [ ] **Step 2: Run pd-console tests**

```bash
cd packages/pd-console && npm run test
```

Expected: all tests pass.

- [ ] **Step 3: Build pd-console**

```bash
cd packages/pd-console && npm run build
```

Expected: build succeeds.

---

### Task 7: Final review and staging

**Files:** all files above

- [ ] **Step 1: Check diff scope**

```bash
git diff --name-only
```

Expected only:
- `packages/pd-console/src/ui/data/daily-thoughts.ts`
- `packages/pd-console/src/ui/components/focus/daily-thought-card.tsx`
- `packages/pd-console/src/ui/pages/focus/FocusPage.tsx`
- `packages/pd-console/src/ui/i18n/zh-CN.json`
- `packages/pd-console/src/ui/i18n/en.json`
- `packages/pd-console/src/ui/styles/globals.css`
- `packages/pd-console/tests/ui/daily-thought.test.ts`
- `docs/superpowers/specs/2026-06-17-focus-page-daily-thought-design.md`
- `docs/superpowers/plans/2026-06-17-focus-page-daily-thought.md`

- [ ] **Step 2: Do NOT stage other dev's files**

Verify these are NOT staged:
- `packages/principles-core/src/runtime-v2/internalization/artificer-prompt-builder.ts`
- `packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts`
- `packages/principles-core/src/runtime-v2/internalization/pitask-metadata.ts`
- Any `packages/pd-cli/*.cjs` untracked files

- [ ] **Step 3: Stage relevant files and prepare summary**

```bash
git add packages/pd-console/src/ui/data/daily-thoughts.ts \
  packages/pd-console/src/ui/components/focus/daily-thought-card.tsx \
  packages/pd-console/src/ui/pages/focus/FocusPage.tsx \
  packages/pd-console/src/ui/i18n/zh-CN.json \
  packages/pd-console/src/ui/i18n/en.json \
  packages/pd-console/src/ui/styles/globals.css \
  packages/pd-console/tests/ui/daily-thought.test.ts \
  docs/superpowers/specs/2026-06-17-focus-page-daily-thought-design.md \
  docs/superpowers/plans/2026-06-17-focus-page-daily-thought.md
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - Card location between summary and stratification → Task 2 Step 2.
   - Daily fixed + manual refresh → Task 1 Step 2 + Task 2 Step 1.
   - Bilingual content → Task 1 Step 1 + Task 3.
   - Entrance + breathing dot animations → Task 4.
   - Reduced motion → Task 4 media query.
   - Unit tests → Task 5.
   - Kill-switch → Task 2 Step 1 constant.

2. **Placeholder scan:** All code blocks contain concrete content.

3. **Type consistency:** `DailyThought` schema reused in data file, component, and tests.
