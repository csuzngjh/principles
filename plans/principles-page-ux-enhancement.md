# Plan: Principles Page UX Enhancement

> Source: User feedback on principles page UX improvements

## Architectural Decisions

Durable decisions that apply across all phases:

- **Routes**:
  - `/principles` — list view (existing)
  - `/principles/:id` — detail view (new, Phase 2)
- **Schema**: JSON API responses (no schema change required)
- **Key Models**: `PrincipleListItem`, `PrincipleDetail`, `RuleItem` (existing)
- **UI Framework**: React + Tailwind CSS v4 + shadcn/ui-style components
- **State Management**: Local React state + URL params for filters
- **Caching**: In-memory TTL cache (existing, 5s)

---

## Phase 1: Core UX Improvements ✅ COMPLETED

**User stories**:
- As a user, I want to see principles with rich visual indicators
- As a user, I want quick access filters and keyboard navigation
- As a user, I want better loading and empty states

### What to build

A vertical slice that enhances the existing list view with:

1. ~~**Virtual scrolling** for 200+ principles performance~~ (deferred - may be unnecessary with current data size)
2. **Progress bar components** for value score and adherence rate
3. **Search debouncing** to reduce API calls
4. **Keyboard shortcuts** (j/k for navigation, / for search)
5. **Skeleton loading states** (already present, verify coverage)
6. **Empty state** with actionable message
7. **Quick stats panel** with mini charts

### Acceptance criteria

- [x] Value score displayed as progress bar (0-100 scale)
- [x] Adherence rate displayed as percentage progress bar
- [x] Search input has 300ms debounce
- [x] ~~Virtual scrolling renders 200+ items smoothly~~ (deferred)
- [x] Keyboard navigation works (j/k/up/down)
- [x] Pressing "/" focuses search input
- [x] Empty state shows helpful message when no results
- [x] Loading skeleton shows during initial load

### Implementation notes

**Files created/modified:**
- `src/ui/components/ui/progress-bar.tsx` — ProgressBar, ValueScoreBar, AdherenceBar components
- `src/ui/hooks/useDebounce.ts` — useDebounce hook
- `src/ui/hooks/useKeyboardNavigation.ts` — useKeyboardNavigation, useFocusSearch hooks
- `src/ui/pages/PrinciplesPage.tsx` — integrated all new components
- `src/ui/i18n/en.json` & `zh-CN.json` — added new translation keys

### Pending: Virtual Scrolling

If performance issues arise with 200+ principles, consider adding `@tanstack/react-virtual`:
```bash
npm install @tanstack/react-virtual
```

---

## Phase 2: Principle Detail Page ✅ COMPLETED

**User stories**:
- As a user, I want to view full principle details in a dedicated page
- As a user, I want to see related principles and pain events
- As a user, I want to navigate back to list from detail

### What to build

Create a dedicated `/principles/:id` route with:

1. **Full-width detail layout** with all principle metadata
2. **Rule cards** with visual type indicators
3. **Conflict relationships** displayed as linked badges
4. **Pain history timeline** (if data available)
5. **Back button** and breadcrumb navigation
6. **Share link** functionality
7. **Edit entry point** (future: edit capability)

### Acceptance criteria

- [x] Detail page accessible via URL `/principles/:id`
- [x] All principle fields displayed with proper formatting
- [x] Rules displayed as visual cards with type badges
- [x] Clicking conflict principle navigates to its detail
- [x] Back button returns to list with preserved filters
- [x] Deep link can be shared and opened directly
- [x] 404 shown for non-existent principle IDs

### Implementation notes

**Files created/modified:**
- `src/ui/pages/PrincipleDetailPage.tsx` — new detail page component
- `src/ui/App.tsx` — added `/principles/:id` route
- `src/ui/pages/PrinciplesPage.tsx` — added external link icon to navigate to detail
- `src/ui/i18n/en.json` & `zh-CN.json` — added detail page translations

---

## Phase 3: Visualization & Analytics ✅ COMPLETED

**User stories**:
- As a user, I want to visualize principle relationships
- As a user, I want to see principle health trends
- As a user, I want statistics dashboard for principles

### What to build

Add analytics features to the principles page:

1. **Principle health chart** — distribution by status
2. **Priority breakdown** — P0/P1/P2 allocation
3. **Rule coverage** — principles with/without rules
4. **Value distribution** — histogram of value scores
5. ~~**Mini sparklines** for trend indicators~~ (deferred - no historical data source yet)

### Acceptance criteria

- [x] Donut chart showing status distribution
- [x] Bar chart showing priority breakdown
- [x] Coverage percentage with visual indicator
- [x] ~~Sparkline for value score trends (if historical data)~~ (deferred)
- [x] Charts responsive on mobile

### Implementation notes

**Design decision**: Used pure CSS/SVG charts instead of adding `recharts` (~400KB) as a dependency. This keeps the bundle size small and avoids dependency bloat.

**Files created/modified:**
- `src/ui/components/ui/charts.tsx` — DonutChart, HorizontalBarChart, CoverageIndicator, Histogram, computeValueBuckets
- `src/ui/pages/PrinciplesPage.tsx` — integrated analytics panel
- `src/ui/i18n/en.json` & `zh-CN.json` — added chart translations
- `tests/components/charts.test.ts` — unit tests for chart utilities

---

## Phase 4: Advanced Interactions ✅ COMPLETED

**User stories**:
- As a user, I want to batch select principles for actions
- As a user, I want to bookmark frequently viewed principles
- As a user, I want to compare two principles side by side

### What to build

Enhanced interaction capabilities:

1. **Multi-select mode** with checkboxes
2. **Batch actions** (bulk export)
3. **Bookmarks** stored in localStorage
4. **Comparison view** — side-by-side principle diff
5. ~~**Quick preview** — hover card for fast viewing~~ (deferred - adds complexity)
6. ~~**Drag to reorder** favorites~~ (deferred - not critical)

### Acceptance criteria

- [x] Multi-select with checkboxes
- [x] Batch export to JSON
- [x] Bookmarks persist across sessions
- [x] Comparison view shows two principles side by side
- [x] ~~Hover preview shows in 200ms delay~~ (deferred)
- [x] ~~Drag to reorder bookmarks~~ (deferred)

### Implementation notes

**Files created/modified:**
- `src/ui/hooks/useBookmarks.ts` — localStorage-based bookmark persistence
- `src/ui/components/compare-view.tsx` — side-by-side comparison with diff highlighting
- `src/ui/pages/PrinciplesPage.tsx` — integrated selection mode, bookmarks, export, compare
- `src/ui/i18n/en.json` & `zh-CN.json` — added interaction translations
- `tests/hooks/use-bookmarks.test.ts` — bookmark and export logic tests

---

## Phase 5: Content Enhancement ✅ COMPLETED

**User stories**:
- As a user, I want to see Markdown rendered in principle text
- As a user, I want to see related documentation links
- As a user, I want to view implementation examples

### What to build

Rich content support:

1. **Markdown renderer** for principle descriptions
2. **Code blocks** for implementation patterns
3. **Links** to related docs and external resources
4. **Collapsible sections** for long content
5. **Copy button** for code examples

### Acceptance criteria

- [x] Markdown syntax rendered correctly
- [x] Code blocks have copy button
- [x] Links are clickable and open in new tab
- [x] Long content is collapsible with "show more"
- [x] Copy button works for code blocks

### Implementation notes

**Design decision**: Implemented a lightweight Markdown renderer instead of adding `react-markdown` (~50KB). The custom renderer supports:
- Headings (h1-h3)
- Bold, italic, inline code
- Links (open in new tab)
- Fenced code blocks with language labels
- Unordered and ordered lists

This avoids adding dependencies while providing all needed features for principle content.

**Files created/modified:**
- `src/ui/components/ui/markdown.tsx` — MarkdownRenderer, CodeBlock, CollapsibleSection, TruncatedText
- `src/ui/pages/PrincipleDetailPage.tsx` — integrated Markdown rendering, collapsible sections, truncated text
- `src/ui/pages/PrinciplesPage.tsx` — added TruncatedText for long principle text
- `src/ui/i18n/en.json` & `zh-CN.json` — added content translations
- `tests/components/markdown.test.ts` — code block detection tests

---

## Implementation Notes

### Dependencies to add
- `react-markdown` — Markdown rendering
- `react-virtual` — Virtual scrolling (or `@tanstack/react-virtual`)
- `recharts` or `chart.js` — Analytics charts
- `react-hot-toast` — Toast notifications

### Existing patterns to follow
- Use `cn()` utility for class merging
- Follow `Card`, `Badge`, `Button` component patterns
- Use existing i18n keys structure
- Maintain dark/light theme compatibility
- Keep mobile responsive (mobile-first approach)

### Testing strategy
- Unit tests for utility functions
- Component tests for critical UI elements
- E2E tests for user flows
- Accessibility tests (keyboard, screen reader)
