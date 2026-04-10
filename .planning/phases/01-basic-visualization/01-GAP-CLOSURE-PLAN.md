---
phase: "01-basic-visualization"
plan: "01-GAP-CLOSURE"
type: execute
wave: 1
depends_on: []
files_modified:
  - "packages/openclaw-plugin/ui/src/charts.tsx"
  - "packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx"
autonomous: true
requirements:
  - VIZ-04
gap_closure: true
closes_gaps_from: "01-VERIFICATION.md"

must_haves:
  truths:
    - "LineChart interface has emptyText prop for i18n"
    - "LineChart renders emptyText prop instead of hardcoded '暂无数据'"
    - "Coverage trend section shows EmptyState when no data"
    - "All LineChart usages pass emptyText prop"
  artifacts:
    - path: "packages/openclaw-plugin/ui/src/charts.tsx"
      provides: "LineChartProps interface with emptyText prop"
      contains: "interface LineChartProps" with "emptyText?: string"
      min_lines: 860-865
    - path: "packages/openclaw-plugin/ui/src/charts.tsx"
      provides: "Conditional render using emptyText prop"
      contains: "emptyText ?" and NOT "暂无数据"
      min_lines: 876-882
    - path: "packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx"
      provides: "Coverage trend with EmptyState fallback"
      contains: ternary operator with EmptyState component
      min_lines: 139-154
    - path: "packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx"
      provides: "LineChart usages with emptyText prop"
      contains: 'emptyText={t("common.noData")}'
      lines: [145, 258]
  key_links:
    - from: "LineChart component"
      to: "i18n system"
      via: "emptyText prop passed from parent"
      pattern: "emptyText\\?:\\s*string"
    - from: "Coverage trend section"
      to: "EmptyState component"
      via: "ternary operator checking data.coverageTrend.length"
      pattern: "data\\.coverageTrend\\.length.*\\?.*:.*EmptyState"
    - from: "ThinkingModelsPage"
      to: "i18n keys"
      via: "t() function calls"
      pattern: 't\\(["\'"]common\\.noData["\'"]\\)'

---

<objective>
Close verification gaps from Phase 01 by implementing missing i18n fixes for LineChart component and coverage trend empty state.

**Purpose:** The previous SUMMARY.md claimed PASSED but verification showed 0/3 truths verified. This plan implements the actual fixes needed based on current codebase state.

**Output:**
- LineChart interface accepts `emptyText` prop
- Hardcoded Chinese text removed from LineChart
- Coverage trend shows EmptyState fallback when no data
- All LineChart usages pass i18n text
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/01-basic-visualization/PLAN.md
@.planning/phases/01-basic-visualization/01-VERIFICATION.md
@.planning/phases/01-basic-visualization/01-01-SUMMARY.md
@packages/openclaw-plugin/ui/src/charts.tsx
@packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx
@packages/openclaw-plugin/ui/src/i18n/ui.ts

## Current Codebase State (as of 2026-04-10)

**charts.tsx (lines 855-882):**
- `LineChartProps` interface has: data, width, height, color, showGrid, showDots, showArea, unit
- **Missing:** `emptyText?: string` prop
- Hardcoded text at line 879: "暂无数据"

**ThinkingModelsPage.tsx (line 139):**
- Uses `&&` operator: `{data.coverageTrend.length >= 1 && (...)}`
- **Missing:** Ternary operator with EmptyState fallback for when `length === 0`

**ThinkingModelsPage.tsx (lines 145, 258):**
- LineChart usages do NOT pass `emptyText` prop
- This is expected since the prop doesn't exist yet

**i18n/ui.ts:**
- `common.noData` already exists (line 45): `{ zh: '暂无数据', en: 'No data' }`
- `thinkingModels.emptyCoverageTrend` already exists (line 230)
- `thinkingModels.emptyCoverageTrendDesc` already exists (line 231)
- EmptyState component already exported from charts.tsx (line 45)

## Gap Summary

| Gap | Truth | Status | Root Cause |
|-----|-------|--------|------------|
| 1 | LineChart has emptyText prop for i18n | FAILED | Interface missing prop, hardcoded text at line 879 |
| 2 | Coverage trend shows EmptyState when no data | FAILED | Uses && instead of ternary, no fallback |
| 3 | All LineChart usages pass emptyText prop | FAILED | Prop doesn't exist, so usages can't pass it |

## Implementation Order

1. Add `emptyText` prop to LineChartProps interface
2. Replace hardcoded "暂无数据" with conditional render using `emptyText`
3. Update coverage trend to use ternary with EmptyState fallback
4. Add `emptyText={t('common.noData')}` to all LineChart usages
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add emptyText prop to LineChart interface and replace hardcoded text</name>
  <files>packages/openclaw-plugin/ui/src/charts.tsx</files>
  <read_first>
    - packages/openclaw-plugin/ui/src/charts.tsx (lines 855-882 for LineChartProps interface and empty state render)
  </read_first>
  <action>
    1. In `LineChartProps` interface (around line 855), add: `emptyText?: string;`
       - Place it after `unit?: string;` as the last optional prop
    2. In the `LineChart` function parameters (around line 866), destructure: `emptyText`
    3. Replace the hardcoded "暂无数据" div (lines 876-882) with conditional render:
       ```tsx
       if (!data || data.length === 0) {
         return emptyText ? (
           <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
             {emptyText}
           </div>
         ) : null;
       }
       ```
    4. Verify the hardcoded string "暂无数据" is completely removed from the file
  </action>
  <verify>
    <automated>
      grep -n "emptyText?: string" packages/openclaw-plugin/ui/src/charts.tsx
      grep -n "暂无数据" packages/openclaw-plugin/ui/src/charts.tsx | wc -l
    </automated>
  </verify>
  <acceptance_criteria>
    - Line 864 contains "emptyText?: string;" in LineChartProps interface
    - Line 868-869 destructures emptyText in function parameters
    - Lines 876-883 contain conditional render: "emptyText ? (<div>) : null"
    - File does NOT contain the string "暂无数据" (zero matches)
    - File contains exactly one instance of "emptyText" in the interface definition
  </acceptance_criteria>
  <done>
    LineChart interface accepts `emptyText` prop and renders it conditionally instead of hardcoded Chinese text. When `emptyText` is empty/unset, returns `null` (no empty box). When provided, renders the message.
  </done>
</task>

<task type="auto">
  <name>Task 2: Change coverage trend from && to ternary with EmptyState fallback</name>
  <files>packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx</files>
  <read_first>
    - packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx (lines 135-155 for coverage trend section)
    - packages/openclaw-plugin/ui/src/charts.tsx (line 45 for EmptyState component export)
  </read_first>
  <action>
    1. Find the coverage trend section (around line 139): `{data.coverageTrend.length >= 1 && (`
    2. Replace the entire section (lines 139-154) with ternary operator:
       ```tsx
       {data.coverageTrend.length >= 1 ? (
         <section className="panel" style={{ marginBottom: 'var(--space-4)' }}>
           <h3 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>
             {t('thinkingModels.coverageTrend')}
           </h3>
           <LineChart
             data={data.coverageTrend.map(d => ({ label: d.day.slice(5), value: Math.round(d.coverageRate * 100) }))}
             width={560}
             height={140}
             color="var(--accent)"
             showGrid
             showDots
             showArea
             emptyText={t('common.noData')}
           />
         </section>
       ) : (
         <EmptyState
           title={t('thinkingModels.emptyCoverageTrend')}
           description={t('thinkingModels.emptyCoverageTrendDesc')}
         />
       )}
       ```
    3. Ensure EmptyState is imported (check imports at top of file, add if missing)
  </action>
  <verify>
    <automated>
      grep -A2 "coverageTrend.length" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx | head -5
      grep -n "import.*EmptyState" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx
    </automated>
  </verify>
  <acceptance_criteria>
    - Line 139 contains "data.coverageTrend.length >= 1 ?" (ternary, not &&)
    - Lines 140-154 contain the truthy branch (LineChart in section)
    - Lines after the closing colon contain EmptyState component with title and description props
    - EmptyState is imported from charts.tsx (verify import statement exists)
    - The section uses `t('thinkingModels.emptyCoverageTrend')` for EmptyState title
    - The section uses `t('thinkingModels.emptyCoverageTrendDesc')` for EmptyState description
  </acceptance_criteria>
  <done>
    Coverage trend section now shows EmptyState with i18n message when `data.coverageTrend.length === 0`. When data exists, shows the LineChart with `emptyText` prop.
  </done>
</task>

<task type="auto">
  <name>Task 3: Add emptyText prop to all LineChart usages</name>
  <files>packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx</files>
  <read_first>
    - packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx (lines 145, 258 for LineChart usages)
  </read_first>
  <action>
    1. Find all `<LineChart` usages in the file (two occurrences: lines ~145 and ~258)
    2. Add `emptyText={t('common.noData')}` prop to each LineChart:
       - Line ~145 (coverage trend - already added in Task 2, verify present)
       - Line ~258 (usage trend in detail panel):
         ```tsx
         <LineChart
           data={detail.usageTrend.map(d => ({ label: d.day.slice(5), value: d.hits }))}
           width={500}
           height={100}
           color="var(--accent)"
           showGrid
           showDots
           showArea
           emptyText={t('common.noData')}
         />
         ```
    3. Ensure no LineChart usage is missing the `emptyText` prop
  </action>
  <verify>
    <automated>
      grep -B5 -A10 "LineChart" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx | grep -c "emptyText"
    </automated>
  </verify>
  <acceptance_criteria>
    - File contains exactly 2 LineChart components
    - Both LineChart components have `emptyText={t('common.noData')}` prop
    - grep shows count of 2 for "emptyText" in LineChart contexts
    - No LineChart component is missing the emptyText prop
  </acceptance_criteria>
  <done>
    All LineChart usages now pass `emptyText={t('common.noData')}` for consistent i18n empty state handling.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User → UI | Untrusted user input crosses here (N/A - read-only display) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-01 | I | EmptyState i18n keys | accept | No user input, display-only component. i18n keys are static strings from ui.ts. |
| T-01-02 | X | LineChart emptyText prop | accept | Props are controlled by parent component using t() function, not user input. |
| T-01-03 | T | Data flow from API → chart | accept | Out of scope for this bugfix. API data sanitization happens upstream. |

**Notes:** This is a UI bugfix with no security implications. All changes are display-only with controlled i18n strings.
</threat_model>

<verification>
## Automated Verification Commands

Run after task completion:

```bash
# Verify LineChart interface has emptyText prop
grep -n "emptyText?: string" packages/openclaw-plugin/ui/src/charts.tsx

# Verify hardcoded Chinese text is removed
! grep -n "暂无数据" packages/openclaw-plugin/ui/src/charts.tsx

# Verify coverage trend uses ternary (not &&)
grep -n "coverageTrend.length.*?" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx

# Verify all LineChart usages have emptyText prop
grep -B5 -A10 "LineChart" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx | grep -c "emptyText"

# Verify EmptyState is used for coverage trend empty state
grep -A5 "thinkingModels.emptyCoverageTrend" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx
```

Expected results:
- Line 864 in charts.tsx contains "emptyText?: string"
- Zero matches for "暂无数据" in charts.tsx
- Ternary operator present in ThinkingModelsPage.tsx line 139
- Count of 2 for emptyText prop in LineChart usages
- EmptyState component imported and used with i18n keys

## Manual Verification

1. Open ThinkingModelsPage in UI with no data:
   - Should see "今日暂无覆盖率记录" / "No coverage data yet" (EmptyState)
   - Should NOT see hardcoded "暂无数据"
2. Open ThinkingModelsPage with data:
   - Coverage trend chart displays normally
   - Usage trend chart in detail panel displays normally
3. Check browser console for errors (should be none)
</verification>

<success_criteria>
- [ ] LineChartProps interface contains `emptyText?: string` prop
- [ ] Hardcoded "暂无数据" string removed from charts.tsx
- [ ] Coverage trend section uses ternary operator with EmptyState fallback
- [ ] EmptyState uses i18n keys `thinkingModels.emptyCoverageTrend` and `thinkingModels.emptyCoverageTrendDesc`
- [ ] All 2 LineChart usages pass `emptyText={t('common.noData')}`
- [ ] No TypeScript compilation errors
- [ ] No hardcoded Chinese text in modified files
- [ ] EmptyState component imported in ThinkingModelsPage.tsx
</success_criteria>

<output>
After completion, create `.planning/phases/01-basic-visualization/01-GAP-CLOSURE-SUMMARY.md`
</output>
