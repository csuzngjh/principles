# Phase 3: Frontend Skeleton + Todo Page - Research

**Researched:** 2026-05-11
**Domain:** React 19 SPA with inline styles, no external state/routing/CSS libraries
**Confidence:** HIGH

## Summary

Phase 3 builds the interactive Todo page for the PD Console dashboard -- a React 19 SPA that uses inline CSSProperties exclusively, has no routing library (hash-based routing via useState), no state management library, and bundles with esbuild. The page must display tasks in 3 priority zones, support approval/rejection with optimistic UI + undo, lazy-load evidence on card expand, poll for refresh every 30s, and run all visible text through the i18n layer.

The core technical challenge is implementing these features using only React 19 built-in primitives (useState, useEffect, useRef, useCallback) without any external libraries. The research confirms this is entirely feasible. The main risk is a **type mismatch already present in api.ts** -- `fetchTasks` is typed as returning `ApiResponse<TaskItem[]>` but the server actually returns a 3-zone object `{ needsConfirmation, suggestedAttention, recentActivity }`. This must be fixed before the page can work.

**Primary recommendation:** Fix the api.ts type mismatch first, then build TasksPage as a container component with 3 zone sections, each rendering TaskCard components. Use the CSS Grid 0fr/1fr transition trick for expand/collapse animation -- it works with inline styles and requires no library.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** TasksPage as container component (owns data fetching and state). TaskCard as presentational component (receives data + callbacks). EvidencePanel as child of TaskCard. No state management library -- useState + useEffect sufficient.
- **D-02:** Continue using inline CSSProperties. Extract shared style objects as module-level constants. No external CSS framework.
- **D-03:** 3 sections stacked vertically: Needs Confirmation (red) -> Suggested Attention (yellow) -> Recent Activity (white). Each section has header with count badge. Empty state message when no items.
- **D-04:** Click card header -> expand to show evidence (3-layer: summary + why + whatHappensIf). Evidence loaded lazily via fetchTaskEvidence(id) on first expand. Approve/Reject buttons visible in expanded state for approval tasks. Cleanup button for cleanup tasks.
- **D-05:** Optimistic UI: card shows "Approved" status immediately after click. Undo button appears for 5 seconds, then card fades out. On undo, revert to pending state. On timeout, remove card from list.
- **D-06:** setInterval(30000) to re-fetch tasks. Show "last updated" timestamp in page header. Manual refresh button alongside auto-refresh. Preserve expanded state across refreshes.
- **D-07:** All visible text through userFacingText() or translate(). No "candidate", "principle", "GFI", "pruning" visible.
- **D-08:** Settings page: input field for Bearer token. Token stored in sessionStorage via setToken(). If no token, show login prompt on TasksPage.

### Out of Scope
- Status page implementation (Phase 4)
- Activity page implementation (Phase 4)
- Server-side changes (Phase 2 complete)
- WebSocket real-time updates (future)
- CSS framework migration (keep inline styles for now)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01 | Container/presentational component architecture | Pattern 1: Container-Presentational Split |
| D-02 | Inline CSSProperties styling with shared constants | Pattern 2: Shared Style Constants |
| D-03 | 3-zone vertical layout with color-coded headers | Pattern 3: Zone Layout |
| D-04 | Card expand/collapse with lazy evidence loading | Pattern 4: Expand/Collapse + Lazy Loading |
| D-05 | Optimistic UI with 5-second undo window | Pattern 5: Optimistic UI + Undo |
| D-06 | 30s auto-refresh polling with cleanup | Pattern 6: Polling with useEffect |
| D-07 | i18n integration via userFacingText/translate | Don't Hand-Roll: i18n layer |
| D-08 | Token management in Settings + auth gate | Pattern 7: Token Gate |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Task data fetching + polling | Browser / Client | -- | React useState+useEffect in TasksPage owns all data state |
| Card expand/collapse animation | Browser / Client | -- | CSS Grid transition via inline styles, no server involvement |
| Approve/Reject optimistic update | Browser / Client | API / Backend | Client optimistically updates UI, server confirms via POST |
| Evidence lazy loading | Browser / Client | API / Backend | fetchTaskEvidence called on first expand only |
| Token management | Browser / Client | -- | sessionStorage, no server session state |
| i18n text rendering | Browser / Client | -- | Client-side TERM_MAP translation |
| Batch cleanup operations | Browser / Client | API / Backend | Client sends sequential POST /cleanup calls |

## Critical Bug: api.ts Type Mismatch

**Severity: BLOCKER** -- must fix before any page implementation works.

The server's GET /api/tasks endpoint (server.ts line 417-420) returns:
```typescript
{ success: true, data: { needsConfirmation: TaskItem[], suggestedAttention: TaskItem[], recentActivity: TaskItem[] } }
```

But api.ts line 53 types `fetchTasks` as returning `ApiResponse<TaskItem[]>` (a flat array). The function signature must be changed to:
```typescript
interface TaskZones {
  needsConfirmation: TaskItem[];
  suggestedAttention: TaskItem[];
  recentActivity: TaskItem[];
}
async function fetchTasks(): Promise<ApiResponse<TaskZones>>
```

This is a code edit to api.ts, not a server change.

## Standard Stack

### Core (Already Installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react | ^19.0.0 | UI framework | Project constraint -- already in package.json [VERIFIED: package.json] |
| react-dom | ^19.0.0 | DOM rendering | Paired with React [VERIFIED: package.json] |
| esbuild | ^0.25.0 | Bundler | Project constraint -- bundles JSX/TSX [VERIFIED: package.json] |

### No New Dependencies Needed
This phase requires **zero new npm packages**. All functionality is achievable with React 19 built-in hooks:
- `useState` for all component state
- `useEffect` for polling and data fetching
- `useRef` for interval handles and previous-state snapshots
- `useCallback` for stable callback references passed to children

### Alternatives Considered (and rejected per constraints)
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| useState+useEffect | TanStack Query / SWR | Adds dependency; overkill for 3 endpoints with simple polling |
| Inline CSSProperties | Tailwind / CSS Modules | Project constraint: keep inline styles |
| Hash routing | React Router | Adds dependency; current hash-based approach works for 3 pages |
| No animation library | Framer Motion / react-spring | CSS Grid transition handles expand/collapse without library |

## Architecture Patterns

### System Architecture Diagram

```
                  App.tsx (hash router)
                       |
              +--------+--------+
              |                 |
         TasksPage          SettingsPage
         (container)      (token input)
              |
     +--------+--------+
     |        |        |
  Zone 1   Zone 2   Zone 3
  (red)    (yellow)  (white)
     |        |        |
  TaskCard  TaskCard  TaskCard
  (presentational)
     |
     +--> EvidencePanel (lazy loaded)
     +--> Approve/Reject buttons (approval kind)
     +--> Cleanup button (cleanup kind)
     |
  api.ts (fetchTasks, fetchTaskEvidence, approveTask, rejectTask, cleanupTask)
     |
  server.ts (GET /api/tasks, GET /api/tasks/:id/evidence,
             POST /api/tasks/:id/approve, reject, cleanup)
```

### Recommended Project Structure
```
src/ui/
  main.tsx               # Entry point (exists)
  App.tsx                # Hash router + nav (exists, modify)
  api.ts                 # API client (exists, fix types)
  i18n.ts                # Translation layer (exists, may extend)
  pages/
    TasksPage.tsx         # Container: data fetching, polling, zone layout
    SettingsPage.tsx      # Token input + save (exists as placeholder, implement)
  components/
    TaskCard.tsx          # Presentational: card header, expand/collapse trigger
    EvidencePanel.tsx     # Evidence detail: summary, why, whatHappensIf, evidence list
    ZoneSection.tsx       # Reusable zone wrapper: colored header, count badge, empty state
  styles/
    constants.ts          # Shared CSSProperties objects (colors, spacing, transitions)
```

### Pattern 1: Container-Presentational Split
**What:** TasksPage owns all state and data fetching. TaskCard receives data and callbacks as props.
**When to use:** For every data-driven page in this SPA.
**Why:** Keeps state management centralized. TaskCard stays pure and testable.

```typescript
// TasksPage.tsx (container)
interface TaskZones {
  needsConfirmation: TaskItem[];
  suggestedAttention: TaskItem[];
  recentActivity: TaskItem[];
}

function TasksPage() {
  const [zones, setZones] = useState<TaskZones>({
    needsConfirmation: [],
    suggestedAttention: [],
    recentActivity: [],
  });
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [evidenceCache, setEvidenceCache] = useState<Map<string, TaskEvidence>>(new Map());
  const [undoItems, setUndoItems] = useState<Map<string, UndoEntry>>(new Map());
  // ... polling, handlers
}

// TaskCard.tsx (presentational)
interface TaskCardProps {
  task: TaskItem;
  expanded: boolean;
  evidence: TaskEvidence | null;
  loading: boolean;
  onToggleExpand: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onCleanup?: () => void;
}
```

### Pattern 2: Shared Style Constants
**What:** Module-level CSSProperties objects imported by components.
**When to use:** For any style repeated across 2+ components.

```typescript
// styles/constants.ts
export const COLORS = {
  zoneRed: "#fff2f0",
  zoneRedBorder: "#ffccc7",
  zoneYellow: "#fffbe6",
  zoneYellowBorder: "#ffe58f",
  zoneWhite: "#ffffff",
  zoneWhiteBorder: "#f0f0f0",
  primary: "#1677ff",
  danger: "#ff4d4f",
  success: "#52c41a",
  textPrimary: "#333333",
  textSecondary: "#666666",
} as const;

export const SHADOW_CARD: React.CSSProperties = {
  border: "1px solid #f0f0f0",
  borderRadius: "8px",
  padding: "16px",
  marginBottom: "12px",
  backgroundColor: "#ffffff",
  transition: "box-shadow 0.2s ease",
};
```

### Pattern 3: Zone Layout
**What:** Three vertical sections with colored headers and count badges.
**When to use:** The main page layout.

```typescript
const ZONE_CONFIG = [
  { key: "needsConfirmation", title: "需要确认", color: COLORS.zoneRed, borderColor: COLORS.zoneRedBorder },
  { key: "suggestedAttention", title: "建议关注", color: COLORS.zoneYellow, borderColor: COLORS.zoneYellowBorder },
  { key: "recentActivity", title: "最近动态", color: COLORS.zoneWhite, borderColor: COLORS.zoneWhiteBorder },
] as const;
```

### Pattern 4: CSS Grid Expand/Collapse Animation
**What:** Use `grid-template-rows: 0fr` / `1fr` transition for smooth height animation without measuring content.
**When to use:** Card expand/collapse -- works perfectly with inline styles.
**Source:** [CITED: css-tricks.com/css-grid-can-do-auto-height-transitions] and [CITED: web.dev/articles/css-animated-grid-layouts]

```typescript
const COLLAPSED_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateRows: "0fr",
  transition: "grid-template-rows 0.3s ease",
};

const EXPANDED_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateRows: "1fr",
  transition: "grid-template-rows 0.3s ease",
};

const INNER_STYLE: React.CSSProperties = {
  overflow: "hidden",  // REQUIRED -- clips content at 0fr
};
```

Key points for this technique:
- `overflow: hidden` on the inner div is **mandatory** -- without it, content leaks when collapsed [CITED: css-tricks.com]
- Works in all modern browsers: Chrome 107+, Firefox 66+, Safari 16+ [CITED: web.dev]
- No `max-height` hack, no measuring -- truly animates to auto height

### Pattern 5: Optimistic UI + Undo
**What:** Immediately update UI on approve/reject, show undo button for 5 seconds.
**When to use:** D-05 approve/reject and cleanup operations.

```typescript
interface UndoEntry {
  task: TaskItem;
  zone: keyof TaskZones;
  timer: ReturnType<typeof setTimeout>;
}

function handleApprove(taskId: string) {
  // 1. Snapshot current task
  const task = findTask(taskId);
  if (!task) return;

  // 2. Optimistic update: remove from zone
  setZones(prev => ({
    ...prev,
    needsConfirmation: prev.needsConfirmation.filter(t => t.id !== taskId),
  }));

  // 3. Set 5s undo timer
  const timer = setTimeout(() => {
    // After 5s: fire-and-forget the API call
    setUndoItems(prev => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    // No re-add -- card is permanently gone
  }, 5000);

  // 4. Store for undo
  setUndoItems(prev => {
    const next = new Map(prev);
    next.set(taskId, { task, zone: "needsConfirmation", timer });
    return next;
  });
}

function handleUndo(taskId: string) {
  const entry = undoItems.get(taskId);
  if (!entry) return;

  // Cancel the timer
  clearTimeout(entry.timer);

  // Re-add task to its zone
  setZones(prev => ({
    ...prev,
    [entry.zone]: [entry.task, ...prev[entry.zone]],
  }));

  // Remove from undo map
  setUndoItems(prev => {
    const next = new Map(prev);
    next.delete(taskId);
    return next;
  });
}
```

Important: Do NOT await the approve/reject API call during the optimistic update. Fire it asynchronously. If it fails, show an error toast (but do not revert automatically -- the undo window handles user intent).

### Pattern 6: Polling with useEffect Cleanup
**What:** 30-second auto-refresh with proper cleanup to prevent memory leaks.
**When to use:** D-06 auto-refresh.

```typescript
const REFRESH_INTERVAL_MS = 30_000;

useEffect(() => {
  let cancelled = false;

  async function loadTasks() {
    if (cancelled) return;
    const result = await fetchTasks();
    if (result.success && result.data && !cancelled) {
      setZones(result.data);
      setLastUpdated(new Date());
    }
  }

  // Initial fetch
  loadTasks();

  // Polling
  const intervalId = setInterval(loadTasks, REFRESH_INTERVAL_MS);

  return () => {
    cancelled = true;
    clearInterval(intervalId);
  };
}, []); // Empty deps -- effect runs once
```

Key points [CITED: dev.to/edriso/useeffect-cleanup-function-1j8i] [CITED: medium.com/@a1guy/managing-side-effects-in-react]:
- `cancelled` flag prevents state updates after unmount
- `clearInterval` in cleanup prevents memory leaks
- `setZones` uses functional updater when merging to preserve expanded state

**Preserving expanded state across refreshes:** Since `expandedIds` and `evidenceCache` are separate state from `zones`, refreshing `zones` does not collapse cards. Match refreshed tasks to existing expanded IDs.

### Pattern 7: Token Gate
**What:** Check for token before rendering TasksPage content; show login prompt if missing.
**When to use:** D-08 auth gate.

```typescript
function TasksPage() {
  const [token, setToken] = useState(() => getToken());

  if (!token) {
    return (
      <div style={LOGIN_PROMPT_STYLE}>
        <h2>请先设置访问令牌</h2>
        <p>前往 <a href="#/settings">设置页面</a> 输入令牌</p>
      </div>
    );
  }

  // ... rest of TasksPage
}
```

### Anti-Patterns to Avoid
- **Stale closure in setInterval:** Do NOT capture zones/evidenceCache inside the interval callback without using functional state updaters (`setZones(prev => ...)`). [CITED: dev.to/a1guy/react-19-concurrency-deep-dive]
- **Mutating state directly:** Always create new objects/arrays when updating zones, expandedIds, evidenceCache, or undoItems. Use spread operator.
- **Using height: auto for animation:** Cannot transition to `height: auto` with CSS. Use the grid-template-rows trick instead.
- **Forgetting cleanup timers:** Every setTimeout for undo must be cleared on unmount via a useEffect cleanup that iterates undoItems and clears all timers.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Height animation for expand/collapse | maxHeight hack with guessed pixel values | CSS Grid 0fr/1fr transition | maxHeight requires knowing content height or overestimating (causes delay). Grid trick animates to true auto height [CITED: css-tricks.com] |
| Term translation | String replacement in component render | Existing i18n.ts (translate + userFacingText) | Already implemented, handles all technical terms |
| API client | Raw fetch calls in components | Existing api.ts functions | Already typed, handles auth headers and error wrapping |
| Token storage | localStorage or custom mechanism | Existing sessionStorage approach in api.ts | Already implemented with getToken/setToken |

**Key insight:** The project already has all infrastructure (api.ts, i18n.ts, types.ts, server.ts). The phase is purely about composing these into React components.

## Common Pitfalls

### Pitfall 1: fetchTasks Type Mismatch (BLOCKER)
**What goes wrong:** `fetchTasks` returns `ApiResponse<TaskItem[]>` but server sends a 3-zone object. Runtime will silently "work" but data will be the wrong shape.
**Why it happens:** api.ts was written during Phase 2 before the server's actual response shape was finalized.
**How to avoid:** Fix the type in api.ts FIRST, before any TasksPage implementation.
**Warning signs:** `result.data` will be `{ needsConfirmation: [], ... }` not `TaskItem[]`. Any `.map()` on it will crash or silently skip.

### Pitfall 2: Stale Closure in Polling Interval
**What goes wrong:** The setInterval callback captures stale state values, causing the refresh to overwrite user changes (like expanded cards or undo state).
**Why it happens:** JavaScript closures capture the value at creation time, not the current value.
**How to avoid:** Use functional state updaters (`setZones(prev => ...)`) and keep expanded/evidence state separate from zone data.
**Warning signs:** Cards collapse after 30s; undo state disappears on refresh.

### Pitfall 3: Undo Timer Leak on Unmount
**What goes wrong:** Component unmounts (user navigates to Settings) while undo timers are still pending. Timer fires and tries to update unmounted component state.
**Why it happens:** No cleanup for undo timeouts.
**How to avoid:** Add a useEffect cleanup that clears all pending undo timers when TasksPage unmounts.
**Warning signs:** React warning "Can't perform a React state update on an unmounted component" in console.

### Pitfall 4: Evidence Loading Race Condition
**What goes wrong:** User rapidly clicks multiple cards. Evidence requests return out of order, causing wrong evidence displayed for a card.
**Why it happens:** Multiple concurrent fetchTaskEvidence calls with no cancellation.
**How to avoid:** Use an AbortController per request, or simply guard with a `loading` state per card ID (more pragmatic for this scale).
**Warning signs:** Evidence panel shows content from a different task.

### Pitfall 5: Grid Transition Not Working
**What goes wrong:** Card expand/collapse has no animation, just snaps open/closed.
**Why it happens:** Missing `overflow: hidden` on the inner content div, or the inner div does not have `min-height: 0`.
**How to avoid:** Follow the pattern exactly: outer div gets `display: grid; grid-template-rows: 0fr/1fr; transition: grid-template-rows 0.3s ease`, inner div gets `overflow: hidden`.
**Warning signs:** Content visible when collapsed; no smooth animation.

## Code Examples

### Complete Polling Hook Pattern (React 19)
```typescript
// Source: React 19 useEffect cleanup pattern [CITED: react.dev/blog/2024/04/25/react-19-upgrade-guide]
function useTaskPolling(
  onRefresh: (zones: TaskZones) => void,
  intervalMs: number = 30_000,
) {
  const lastUpdatedRef = useRef<Date>(new Date());

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval>;

    async function refresh() {
      if (cancelled) return;
      const result = await fetchTasks();
      if (result.success && result.data && !cancelled) {
        onRefresh(result.data);
        lastUpdatedRef.current = new Date();
      }
    }

    refresh(); // Initial fetch
    intervalId = setInterval(refresh, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [onRefresh, intervalMs]);

  return lastUpdatedRef;
}
```

### Expand/Collapse Card with CSS Grid
```typescript
// Source: CSS Grid auto-height animation [CITED: css-tricks.com/css-grid-can-do-auto-height-transitions]
function TaskCard({ task, expanded, evidence, onToggle }: TaskCardProps) {
  const wrapperStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateRows: expanded ? "1fr" : "0fr",
    transition: "grid-template-rows 0.3s ease",
  };

  const innerStyle: React.CSSProperties = {
    overflow: "hidden",
  };

  return (
    <div style={CARD_STYLE}>
      <div onClick={onToggle} style={CARD_HEADER_STYLE}>
        <span>{userFacingText(task.title)}</span>
        <span>{expanded ? "v" : ">"}</span>
      </div>
      <div style={wrapperStyle}>
        <div style={innerStyle}>
          <EvidencePanel evidence={evidence} task={task} />
        </div>
      </div>
    </div>
  );
}
```

### Settings Page Token Input
```typescript
function SettingsPage() {
  const [token, setToken] = useState(() => getToken() ?? "");

  function handleSave() {
    if (token.trim()) {
      setToken(token.trim()); // api.ts setToken
      alert("令牌已保存");
    }
  }

  return (
    <div style={CONTENT_STYLE}>
      <h2>设置</h2>
      <label>
        访问令牌 (Bearer Token):
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={INPUT_STYLE}
        />
      </label>
      <button onClick={handleSave} style={BUTTON_STYLE}>保存</button>
    </div>
  );
}
```

### Batch Cleanup Operation
```typescript
async function handleBatchCleanup(taskIds: string[]) {
  // Sequential to avoid server contention
  const results = [];
  for (const id of taskIds) {
    const result = await cleanupTask(id);
    results.push({ id, success: result.success });
  }

  // Remove all successfully cleaned tasks from zones
  const cleanedIds = new Set(
    results.filter(r => r.success).map(r => r.id)
  );

  setZones(prev => ({
    needsConfirmation: prev.needsConfirmation.filter(t => !cleanedIds.has(t.id)),
    suggestedAttention: prev.suggestedAttention.filter(t => !cleanedIds.has(t.id)),
    recentActivity: prev.recentActivity.filter(t => !cleanedIds.has(t.id)),
  }));
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| height: auto transition hack (maxHeight) | CSS Grid 0fr/1fr transition | Chrome 107+ / 2022 | Clean height animation without pixel guessing |
| useEffect + useState for data | React 19 use(promise) + Suspense | React 19 / 2024 | Not applicable here -- use(promise) requires Suspense boundaries, adds complexity for a polling scenario |
| react-collapse / Framer Motion | Pure CSS Grid transitions | 2022+ | One less dependency for expand/collapse |

**Not adopted (and why):**
- `useEffectEvent` (React 19.2 experimental): Solves stale closures in effects but is still experimental. The `cancelled` flag pattern is stable and sufficient. [CITED: linkedin.com/pulse/react-192s-useeffectevent-hook]
- React Server Components: Not applicable -- this is a client-side SPA with no SSR framework.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | esbuild 0.25.x supports CSS Grid properties in inline styles without transformation | Pattern 4 | If esbuild transforms CSS properties, the animation might break. Risk: LOW -- esbuild does not process inline styles (they are JS objects, not CSS files) |
| A2 | sessionStorage token survives page navigation within the same tab | Pattern 7 | If sessionStorage is cleared on hash change, token gate will flash. Risk: LOW -- sessionStorage persists within tab lifetime by spec |
| A3 | Server returns properly shaped JSON for all 7 endpoints under normal operation | Architecture | If server shapes differ from types.ts, runtime crashes. Risk: LOW -- Phase 2 implemented server with explicit sendJson() calls |
| A4 | Browser supports CSS Grid 0fr/1fr transition (Chrome 107+, Firefox 66+, Safari 16+) | Pattern 4 | If target browser is older, animation will snap instead of animate. Risk: LOW -- Node.js dashboard likely accessed from modern browsers |

**If this table is empty:** All claims in this research were verified or cited -- no user confirmation needed.

## Open Questions

1. **Should batch cleanup run sequentially or in parallel?**
   - What we know: The cleanup endpoint is a POST that writes to the principle ledger. Server uses Node.js single-threaded I/O.
   - What's unclear: Whether concurrent writes to the same ledger file could cause corruption.
   - Recommendation: Run sequentially (safer). The batch is typically small (5-10 items), so the latency is acceptable.

2. **Should the API call in optimistic update be fire-and-forget or awaited?**
   - What we know: The undo window is 5 seconds. If the API call takes longer than 5s, the undo window will close before the response arrives.
   - What's unclear: Typical API response time for approve/reject.
   - Recommendation: Fire-and-forget with error logging. If the call fails after the undo window closes, log the error but do not revert the UI (the user already committed).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | esbuild, dev server | Available | 24.14.0 | -- |
| esbuild | Build pipeline | Available | 0.25.12 | -- |
| npm | Package management | Available | (worktree) | -- |
| react/react-dom | UI framework | Not installed in worktree | ^19.0.0 (declared) | Run `npm install` first |
| TypeScript | Type checking | Not installed in worktree | ^5.7.0 (declared) | Run `npm install` first |

**Missing dependencies with no fallback:**
- react/react-dom must be installed via `npm install` before development can proceed
- TypeScript must be installed for type checking

**Missing dependencies with fallback:**
- None

## Validation Architecture

> workflow.nyquist_validation is not explicitly set in config.json, so treat as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None detected -- needs setup |
| Config file | None |
| Quick run command | `npx vitest run --reporter=verbose` (after setup) |
| Full suite command | `npx vitest run` (after setup) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01 | TasksPage container fetches and stores zones | unit | `npx vitest run tests/TasksPage.test.tsx` | Wave 0 |
| D-02 | Shared style constants match expected CSSProperties | unit | `npx vitest run tests/styles.test.ts` | Wave 0 |
| D-03 | Zone sections render with correct colors and counts | unit | `npx vitest run tests/ZoneSection.test.tsx` | Wave 0 |
| D-04 | Evidence loads lazily on first expand | unit | `npx vitest run tests/TaskCard.test.tsx` | Wave 0 |
| D-05 | Optimistic update + undo round-trip | unit | `npx vitest run tests/optimistic-ui.test.tsx` | Wave 0 |
| D-06 | Polling interval set and cleaned up | unit | `npx vitest run tests/polling.test.tsx` | Wave 0 |
| D-07 | i18n translates all technical terms | unit | `npx vitest run tests/i18n.test.ts` | Wave 0 |
| D-08 | Token gate shows login when no token | unit | `npx vitest run tests/token-gate.test.tsx` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `vitest` + `@testing-library/react` + `jsdom` setup (devDependencies + config)
- [ ] `tests/TasksPage.test.tsx` -- D-01 container behavior
- [ ] `tests/TaskCard.test.tsx` -- D-04 expand/collapse + lazy evidence
- [ ] `tests/optimistic-ui.test.tsx` -- D-05 approve/reject + undo
- [ ] `tests/polling.test.tsx` -- D-06 interval lifecycle
- [ ] `tests/token-gate.test.tsx` -- D-08 auth gate
- [ ] `tests/i18n-coverage.test.ts` -- D-07 term coverage audit

**Note:** Since the project currently has zero test infrastructure for the UI layer, the planner may choose to defer test setup to a later phase or include it as Wave 0. The core implementation is small enough that manual browser testing via `npm run dev` is viable for initial validation.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token in sessionStorage, sent via Authorization header (api.ts) |
| V3 Session Management | yes | sessionStorage (tab-scoped, cleared on tab close) |
| V5 Input Validation | yes | Token input validated for non-empty before saving |
| V6 Cryptography | no | No crypto in frontend -- server uses timingSafeEqual |

### Known Threat Patterns for React SPA + Bearer Token

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS stealing sessionStorage token | Tampering | No dangerouslySetInnerHTML; sanitize any user-visible text |
| Token in URL or localStorage | Information Disclosure | sessionStorage used (tab-scoped, not persisted across tabs) |
| CSRF on approve/reject endpoints | Tampering | Token-based auth already validates requests; no cookies |
| Open redirect in hash router | Spoofing | Only 3 valid routes; default falls to "tasks" |

## Sources

### Primary (HIGH confidence)
- Codebase analysis: api.ts, App.tsx, i18n.ts, main.tsx, types.ts, server.ts, package.json, build-ui.mjs, tsconfig.json
- [css-tricks.com/css-grid-can-do-auto-height-transitions](https://css-tricks.com/css-grid-can-do-auto-height-transitions/) -- CSS Grid 0fr/1fr height animation technique
- [web.dev/articles/css-animated-grid-layouts](https://web.dev/articles/css-animated-grid-layouts) -- Official Google article confirming grid-template-rows is animatable

### Secondary (MEDIUM confidence)
- [react.dev/blog/2024/04/25/react-19-upgrade-guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide) -- React 19 upgrade guide and hooks behavior
- [dev.to/edriso/useeffect-cleanup-function-1j8i](https://dev.to/edriso/useeffect-cleanup-function-1j8i) -- useEffect cleanup for polling
- [medium.com/@a1guy/managing-side-effects-in-react](https://medium.com/@a1guy/managing-side-effects-in-react-lifecycle-phases-timing-and-cleanup-c90ab97da6e5) -- Side effect lifecycle timing

### Tertiary (LOW confidence)
- [linkedin.com/pulse/react-192s-useeffectevent-hook](https://www.linkedin.com/pulse/react-192s-useeffectevent-hook-finally-solving-stale-closure-raj-2fzoc) -- useEffectEvent in React 19.2 (experimental, not adopted)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing code analyzed directly
- Architecture: HIGH -- patterns are well-established React conventions, verified against actual codebase
- Pitfalls: HIGH -- type mismatch found by code analysis, animation technique verified via web search

**Research date:** 2026-05-11
**Valid until:** 2026-06-10 (30 days -- stable React patterns, no fast-moving dependencies)
