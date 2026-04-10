---
scope: Full WebUI (7 pages)
reviewer: gsd-ui-review
date: 2026-04-10
mode: Code-only review across all page components
pages_reviewed:
  - OverviewPage.tsx (598 lines)
  - EvolutionPage.tsx (352 lines)
  - FeedbackPage.tsx (140 lines)
  - GateMonitorPage.tsx (136 lines)
  - SamplesPage.tsx (174 lines)
  - LoginPage.tsx (~80 lines)
  - ThinkingModelsPage.tsx (637 lines — already reviewed)
---

# Full WebUI Audit: Principles Console

**Overall Score: 17/24 — Needs Work**

| Pillar | Score | Verdict |
|--------|-------|---------|
| Copywriting | 2/4 | Multiple hardcoded strings, emoji, mixed languages |
| Visuals | 3/4 | Generally clean, inconsistent progress bars |
| Color | 3/4 | Good semantic usage, but hardcoded hex colors inline |
| Typography | 2/4 | 10+ distinct font sizes, no scale enforcement |
| Spacing | 3/4 | Mix of CSS vars and hardcoded pixels |
| Experience Design | 4/4 | Good loading states, auto-refresh, error handling |

---

## 1. Copywriting — 2/4 ❌ Issues Found

### Critical
- **EvolutionPage: COMPILE ERROR** — `Clock`, `Activity`, `Shield`, `Zap`, `BookOpen` used but not imported from lucide-react
- **EvolutionPage: Hardcoded Chinese strings** — `当前阶段`, `原则生命周期`, `夜间训练状态`, `训练队列`, `待:`, `中:`, `完:`, `Arbiter 通过率`, `ORPO 样本数`, `模型部署`, `个` — all bypass i18n system
- **EvolutionPage: STAGE_LABELS hardcoded** — `痛点检测`, `已入队` etc. should use i18n keys
- **OverviewPage: Hardcoded Chinese** — `今日趋势`, `今日峰值:`, `暂无思维模型定义`, `暂无思维模型使用`
- **OverviewPage: Emoji in code** — `🟢🟡🟠🔴` in HEALTH_LABELS, `📈` emoji before GFI trend text
- **GateMonitorPage: Emoji in h3** — `&#x1F510;` (🔒), `&#x1F331;` (🌱)
- **LoginPage: Hardcoded English label** — "Gateway Token" instead of i18n key
- **SamplesPage: Hardcoded English error** — `'Review operation failed'`

### Minor
- **FeedbackPage: Trailing comment** — `// ===== Phase 6: Gate Monitor Page =====` at file end (dead code remnant)
- **EvolutionPage: Unused imports** — Sparkline, CollapsiblePanel, 11 unused types, useCallback

---

## 2. Visuals — 3/4 ✅ Minor Issues

### Issues
- **Multiple pages: Inline progress bars** — FeedbackPage (48px big number + 8px bar), GateMonitorPage (24px + 12px bar), OverviewPage (BulletChart). All slightly different implementations. Should be a shared `<ProgressBar />` component.
- **OverviewPage: Massive WorkspaceHealthPanel** — 180 lines of deeply nested inline styles. Should be refactored into sub-components with CSS classes.
- **SamplesPage: `<pre>` overflow** — Raw text in `<pre>` tags can overflow panel width. Need `white-space: pre-wrap`, `word-break: break-word`.

---

## 3. Color — 3/4 ✅ Minor Issues

### Issues
- **EvolutionPage: Hardcoded hex colors** — `#ef4444`, `#f59e0b`, `#3b82f6`, `#8b5cf6`, `#22c55e` in STAGE_COLORS and donut segments. Should use CSS variables: `var(--error)`, `var(--warning)`, `var(--info)`, `var(--accent)`, `var(--success)`.
- **EvolutionPage: Donut chart hardcoded colors** — same hex values in statusSegments array.
- **OverviewPage: GaugeChart segment colors** — uses `var(--text-secondary)` etc. correctly, but some inline hex in other areas.

---

## 4. Typography — 2/4 ❌ Issues Found

### Issues
- **All pages: 10+ distinct font sizes** — `0.65rem`, `0.7rem`, `0.72rem`, `0.75rem`, `0.78rem`, `0.8rem`, `0.85rem`, `0.95rem`, `14px`, `15px`, `24px`, `48px`. No consistent scale.
- **EvolutionPage: Mix of rem and px** — `fontSize: '15px'`, `fontSize: '14px'` alongside rem values.
- **FeedbackPage: `48px` hardcoded** — GFI big number should use a CSS class or `--text-display` variable.
- **GateMonitorPage: `24px` hardcoded** — Trust/EP stage numbers.
- **OverviewPage: `2.5rem` hardcoded** — GFI current value display.

---

## 5. Spacing — 3/4 ✅ Mostly Good

### Issues
- **EvolutionPage: Hardcoded gap/padding** — `gap: 'var(--space-3)'` good, but also `marginRight: 6` inline for icons.
- **OverviewPage: Inline margins** — `marginTop: 4`, `marginBottom: 6`, `gap: 8`, `gap: 12` — should use `SPACE` constants.
- **SamplesPage: Inline spacing** — `<pre>` elements lack padding/radius styling.

---

## 6. Experience Design — 4/4 ✅ Good

### Strengths
- Auto-refresh hooks on FeedbackPage (15s) and GateMonitorPage (30s)
- Consistent Loading/ErrorState pattern across all pages
- EmptyState components used throughout
- Two-column master-detail pattern consistent
- Error boundaries via try/catch + setError

### Minor Issues
- **SamplesPage: No loading state for review()** — While approve/reject is in-flight, buttons aren't disabled beyond the initial state.
- **EvolutionPage: No loading state for trace fetch** — Clicking a task, trace loads without feedback.

---

## Summary of Actionable Items

| Priority | Page | Pillar | Issue |
|----------|------|--------|-------|
| CRITICAL | EvolutionPage | Copywriting | Missing lucide-react imports (compile error) |
| CRITICAL | EvolutionPage | Copywriting | ~12 hardcoded Chinese strings bypass i18n |
| P1 | EvolutionPage | Color | Hardcoded hex colors in STAGE_COLORS, donut segments |
| P1 | OverviewPage | Copywriting | Hardcoded Chinese in GFI trend, ThinkingModelDistribution |
| P1 | OverviewPage | Copywriting | Emoji in HEALTH_LABELS + GFI trend header |
| P1 | GateMonitorPage | Copywriting | Emoji HTML entities in h3 headers |
| P1 | LoginPage | Copywriting | Hardcoded "Gateway Token" label |
| P1 | SamplesPage | Visuals | `<pre>` overflow, hardcoded English error |
| P2 | All pages | Typography | 10+ font sizes, mix of px/rem |
| P2 | FeedbackPage | Visuals | Trailing dead-code comment |
| P2 | EvolutionPage | Code | 15+ unused imports |
| P3 | All pages | Spacing | Inline margin/pixel values |

---

*Reviewed: 2026-04-10*
*Pages: 7 of 7*
*Mode: Code-only review (no Playwright screenshots)*
