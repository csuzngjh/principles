# Phase 3: Frontend Skeleton + Todo Page — Context

**Gathered:** 2026-05-11
**Status:** Ready for planning
**Source:** Handoff file + codebase analysis

## Phase Boundary

Implement the full interactive Todo page (待办事项) for the PD Console dashboard. The page must display tasks from 3 priority zones, support approval/rejection workflows, and provide auto-refresh.

**In scope:**
- TasksPage component with 3 priority zones (needsConfirmation, suggestedAttention, recentActivity)
- Task card component with expand/collapse for evidence detail
- Approve/Reject buttons with optimistic UI + undo
- Cleanup task batch operations
- 30s auto-refresh via polling
- i18n integration (no technical terms visible to user)
- Token management in Settings page

**Out of scope:**
- Status page implementation (Phase 4)
- Activity page implementation (Phase 4)
- Server-side changes (Phase 2 complete)
- WebSocket real-time updates (future)
- CSS framework migration (keep inline styles for now)

## Implementation Decisions

### D-01: Component Architecture
- TasksPage as container component, owns data fetching and state
- TaskCard as presentational component, receives data + callbacks
- EvidencePanel as child of TaskCard, shown on expand
- No state management library — useState + useEffect sufficient for polling

### D-02: Styling Approach
- Continue using inline CSSProperties (consistent with App.tsx)
- Extract shared style objects as constants at module level
- Use CSS custom properties via inline `style` for colors/spacing
- No external CSS framework

### D-03: Priority Zone Layout
- 3 sections stacked vertically: Needs Confirmation (red) → Suggested Attention (yellow) → Recent Activity (white)
- Each section has header with count badge
- Empty state message when section has no items

### D-04: Card Interaction
- Click card header → expand to show evidence (3-layer: summary + why + whatHappensIf)
- Evidence loaded lazily via fetchTaskEvidence(id) on first expand
- Approve/Reject buttons visible in expanded state for approval tasks
- Cleanup button for cleanup tasks

### D-05: Approve/Reject UX
- Optimistic UI: card shows "Approved" status immediately after click
- Undo button appears for 5 seconds, then card fades out
- On undo, revert to pending state
- On timeout, remove card from list

### D-06: Auto-Refresh
- setInterval(30000) to re-fetch tasks
- Show "last updated" timestamp in page header
- Manual refresh button alongside auto-refresh
- Preserve expanded state across refreshes

### D-07: i18n
- All visible text through userFacingText() or translate()
- No "candidate", "principle", "GFI", "pruning" visible
- Use TERM_MAP from i18n.ts

### D-08: Token Management
- Settings page: input field for Bearer token
- Token stored in sessionStorage via setToken()
- If no token, show login prompt on TasksPage

## API Contracts (from Phase 2)

| Endpoint | Response Shape | Notes |
|----------|---------------|-------|
| GET /api/tasks | `{ data: { needsConfirmation: TaskItem[], suggestedAttention: TaskItem[], recentActivity: TaskItem[] } }` | 3-zone aggregation |
| GET /api/tasks/:id/evidence | `{ data: TaskEvidence }` | { taskId, summary, why, whatHappensIf, evidence[] } |
| POST /api/tasks/:id/approve | `{ data: { principleId: string } }` | Candidate consumed |
| POST /api/tasks/:id/reject | `{ data: { success: true } }` | Candidate expired |
| POST /api/tasks/:id/cleanup | `{ data: { success: true } }` | Principle archived |

## Files to Modify

### New Files
- `src/ui/components/TaskCard.tsx` — Task card component
- `src/ui/components/EvidencePanel.tsx` — Evidence detail panel
- `src/ui/pages/TasksPage.tsx` — Full Todo page implementation

### Modified Files
- `src/ui/App.tsx` — Wire TasksPage, add token check
- `src/ui/i18n.ts` — Add new terms as needed

### Existing Files (reference only)
- `src/ui/api.ts` — 7 API functions already defined
- `src/types.ts` — All TypeScript types already defined

---

*Phase: 03-frontend-todo-page*
*Context gathered: 2026-05-11*
