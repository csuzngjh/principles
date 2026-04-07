# Principles Console Web UI Redesign

**Date**: 2026-03-25
**Status**: Approved
**Version**: 1.0

---

## Overview

Principles Console 是 AI Agent 进化流程监控平台，包含 4 个主要页面：
- 概览 (Overview) — 工作区健康状态、KPI 指标、趋势
- 进化追踪 (Evolution) — 从痛点到原则生成的完整时间线
- 样本审核 (Samples) — 批量审核 correction samples
- 思维模型 (Thinking Models) — 思维模型使用统计

本次优化目标：**现代化 UI** + **数据可视化** + **流畅交互** + **品牌升级**

---

## Design Direction

**Style**: Nature Distilled × Soft UI Evolution
- 大地色调 + 柔和阴影
- 温暖有机感 + 现代可访问性
- 灵感来源：Linear 的简洁结构 + Notion 的温暖排版 + Apple Bento Grid 的精致卡片

---

## Color System

```css
:root {
  /* Background Layers - 暖奶油色系 */
  --bg-base: #FAF7F2;
  --bg-elevated: #FFFFFF;
  --bg-sunken: #F0EBE3;
  
  /* Accent - 深橄榄绿 (柔和版本) */
  --accent: #4A7C6F;
  --accent-hover: #3D6A5E;
  --accent-soft: rgba(74, 124, 111, 0.1);
  --accent-muted: rgba(74, 124, 111, 0.06);
  
  /* Earth Tones - 大地色系 */
  --earth-brown: #8B7355;
  --earth-tan: #C4A882;
  --earth-cream: #E8DFD0;
  --earth-warm: #D4C4A8;
  
  /* Text Hierarchy */
  --text-primary: #2D2A26;
  --text-secondary: #6B6560;
  --text-tertiary: #9A948C;
  
  /* Borders & Dividers */
  --border: rgba(139, 115, 85, 0.15);
  --border-hover: rgba(139, 115, 85, 0.25);
  
  /* Status Colors */
  --success: #4A7C6F;
  --warning: #B8860B;
  --error: #C45C4A;
  --info: #5B8BA0;
  
  /* Cards & Surfaces */
  --card-bg: #FFFFFF;
  --card-radius: 16px;
  
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(139, 115, 85, 0.05);
  --shadow-md: 0 2px 8px rgba(139, 115, 85, 0.08), 0 4px 16px rgba(139, 115, 85, 0.04);
  --shadow-lg: 0 4px 12px rgba(139, 115, 85, 0.12), 0 8px 24px rgba(139, 115, 85, 0.06);
}
```

### Color Usage

| Token | Usage |
|-------|-------|
| `--bg-base` | Page background |
| `--bg-elevated` | Modal, dropdown backgrounds |
| `--bg-sunken` | Nested panels, code blocks |
| `--accent` | Primary buttons, active states, links |
| `--accent-soft` | Hover backgrounds, selected rows |
| `--earth-brown` | Secondary text, dividers |
| `--success/warning/error` | Status indicators |

---

## Typography

### Font Stack

```css
@import url('https://fonts.googleapis.com/css2?family=Calistoga&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --font-display: 'Calistoga', serif;      /* H1, H2 - 添加人文温暖 */
  --font-body: 'Inter', -apple-system, sans-serif;  /* Body, UI */
  --font-mono: 'JetBrains Mono', monospace;  /* Data, IDs, timestamps */
}
```

### Type Scale

| Element | Font | Size | Weight | Line Height |
|---------|------|------|--------|-------------|
| H1 (Page Title) | Calistoga | 32px | 400 | 1.2 |
| H2 (Section) | Inter | 24px | 600 | 1.3 |
| H3 (Card Title) | Inter | 18px | 600 | 1.4 |
| Body | Inter | 15px | 400 | 1.6 |
| Small/Caption | Inter | 13px | 400 | 1.5 |
| Label/Eyebrow | Inter | 11px | 600 | 1.4 |
| Data/Mono | JetBrains Mono | 14px | 500 | 1.4 |

---

## Spacing System

Based on 4px grid:

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
}
```

---

## Border Radius

| Element | Radius | Usage |
|---------|--------|-------|
| Small | 6px | Badges, tags, small inputs |
| Medium | 8px | Buttons, inputs |
| Large | 12px | Cards, panels |
| XLarge | 16px | Main containers |
| Full | 9999px | Pills, avatars |

---

## Motion & Animation

### Timing Tokens

```css
:root {
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  
  --ease-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Animation Patterns

**Hover Lift (Cards, Rows)**:
```css
.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
  transition: all var(--duration-normal) var(--ease-out);
}
```

**Button Press**:
```css
.button:active {
  transform: scale(0.97);
  transition: transform var(--duration-fast) var(--ease-out);
}
```

**Page Transitions**:
```css
.page-enter {
  opacity: 0;
  transform: translateY(8px);
}
.page-enter-active {
  opacity: 1;
  transform: translateY(0);
  transition: all var(--duration-slow) var(--ease-out);
}
```

**Staggered List Items**:
```css
.list-item:nth-child(1) { animation-delay: 0ms; }
.list-item:nth-child(2) { animation-delay: 50ms; }
.list-item:nth-child(3) { animation-delay: 100ms; }
/* ... */
```

---

## Layout System

### App Shell

```
+------------------+--------------------------------+
|                  |                                |
|     Sidebar      |           Content              |
|     (280px)      |           (flex-1)             |
|                  |                                |
|  - Brand         |  - Page Header                 |
|  - Nav           |  - KPI Grid (6 cols)           |
|  - Footer        |  - Content Grid (2 cols)        |
|                  |                                |
+------------------+--------------------------------+
```

### Grid Layouts

**KPI Grid (6 columns)**:
```css
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-4);
}
```

**Two Column Grid**:
```css
.two-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-5);
}
```

**Wide Right (Detail View)**:
```css
.wide-right {
  grid-template-columns: minmax(320px, 1.1fr) minmax(360px, 1.3fr);
}
```

---

## Components

### Navigation (Sidebar)

- **Brand**: Logo + Title + Subtitle
- **Nav Items**: Icon + Label, vertical stack
- **Active State**: Background `--accent-soft`, left border accent
- **Hover State**: Background `--accent-muted`

### Icon Strategy

Replace all emojis with Lucide React icons (stroke-width: 1.5):

| Page | Icon | Component |
|------|------|-----------|
| Overview | BarChart3 | `lucide-react/BarChart3` |
| Evolution | GitBranch | `lucide-react/GitBranch` |
| Samples | FileCheck | `lucide-react/FileCheck` |
| Thinking | Brain | `lucide-react/Brain` |
| Export | Download | `lucide-react/Download` |
| Logout | LogOut | `lucide-react/LogOut` |

### Cards (Panel)

```css
.panel {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: var(--card-radius);
  padding: var(--space-5);
  box-shadow: var(--shadow-md);
  transition: all var(--duration-normal) var(--ease-out);
}

.panel:hover {
  box-shadow: var(--shadow-lg);
}
```

### KPI Cards

```
+------------------+
|  Label (small)   |
|  Value (28px)    |
|  Trend indicator  |
+------------------+
```

- Large number display: 28px JetBrains Mono 500
- Label: 12px Inter 500, uppercase, tracking
- Trend: Mini sparkline or percentage badge

### Data Rows

```css
.row-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.row-card:hover {
  background: var(--accent-muted);
  border-color: var(--border-hover);
}

.row-card.active {
  background: var(--accent-soft);
  border-color: var(--accent);
}
```

### Buttons

**Primary**:
```css
.button-primary {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  padding: var(--space-3) var(--space-5);
  font-weight: 500;
  transition: all var(--duration-fast) var(--ease-out);
}

.button-primary:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.button-primary:active {
  transform: scale(0.97);
}
```

**Secondary/Ghost**:
```css
.button-secondary {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: var(--space-3) var(--space-5);
}

.button-secondary:hover {
  background: var(--bg-sunken);
  border-color: var(--border-hover);
}
```

### Badges/Pills

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: 9999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
}

.badge.success { background: rgba(74, 124, 111, 0.15); color: var(--success); }
.badge.warning { background: rgba(184, 134, 11, 0.15); color: var(--warning); }
.badge.error { background: rgba(196, 92, 74, 0.15); color: var(--error); }
```

### Mini Sparklines

CSS-based simple trend indicators:

```css
.sparkline {
  width: 48px;
  height: 20px;
  display: inline-block;
}
```

SVG-based sparkline with `--accent` color.

### Timeline (Evolution Page)

```css
.timeline {
  position: relative;
  padding-left: 28px;
}

.timeline::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 16px;
  bottom: 16px;
  width: 2px;
  background: var(--border);
}

.timeline-marker {
  position: absolute;
  left: 0;
  top: 18px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 3px solid white;
  box-shadow: var(--shadow-sm);
}
```

---

## Page-Specific Designs

### Login Page

- Centered card (max-width: 400px)
- Logo + Title + Subtitle
- Token input with copy hint
- Primary login button
- Footer with instruction steps

### Overview Page

1. **Header**: Eyebrow + Title + Workspace info
2. **KPI Grid**: 6 metric cards
3. **Two Column Grid**:
   - Left: Recent Trend (list with sparklines)
   - Right: Top Regressions (list with badges)
4. **Two Column Grid**:
   - Left: Sample Queue (preview list)
   - Right: Thinking Summary (stats grid)

### Evolution Page

1. **Header**: Eyebrow + Title + Status filter badges
2. **Wide Right Layout**:
   - Left: Task list (scrollable)
   - Right: Detail panel with timeline

### Samples Page

1. **Header**: Eyebrow + Title + Status filter dropdown
2. **Wide Right Layout**:
   - Left: Sample list with counters
   - Right: Detail panel (bad attempt, correction, review history)

### Thinking Models Page

1. **Header**: Eyebrow + Title + Summary badges
2. **Wide Right Layout**:
   - Left: Model list with stats
   - Right: Detail panel (scenarios, events)

---

## Accessibility

- Color contrast: 4.5:1 minimum (WCAG AA)
- Focus states: Visible outline on keyboard navigation
- Touch targets: Minimum 44x44px
- Reduced motion: Respect `prefers-reduced-motion`
- Screen reader: Proper ARIA labels

---

## Responsive Breakpoints

```css
/* Tablet */
@media (max-width: 1024px) {
  .kpi-grid { grid-template-columns: repeat(3, 1fr); }
  .two-columns, .wide-right { grid-template-columns: 1fr; }
}

/* Mobile */
@media (max-width: 640px) {
  .app-shell { grid-template-columns: 1fr; }
  .sidebar { 
    flex-direction: row;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
}
```

---

## Implementation Order

1. **Phase 1: Foundation**
   - Update CSS variables and base styles
   - Replace emoji icons with Lucide React
   - Update typography (fonts, scales)

2. **Phase 2: Core Components**
   - Card/panel redesign
   - Button styles
   - Badge/pill components
   - Navigation sidebar

3. **Phase 3: Page Updates**
   - Login page
   - Overview page (with KPI redesign)
   - Evolution page (with timeline)
   - Samples page
   - Thinking Models page

4. **Phase 4: Animation & Polish**
   - Hover/focus transitions
   - Page transitions
   - Loading states
   - Micro-interactions

---

## Central Database Architecture

### Overview

The Principles Console now supports aggregating data from **all 10 agent workspaces** into a single central database. This enables cross-workspace analytics and unified monitoring.

### Storage Location

```
~/.openclaw/.central/aggregated.db
```

**Important**: Binary database files are NOT stored in workspace `memory/` directories (which are for text embeddings). The central DB uses a dedicated `.central/` directory outside all workspaces.

### Discovery Mechanism

Workspaces are dynamically discovered by scanning for directories matching `workspace-*` pattern in `~/.openclaw/`:

```
~/.openclaw/
├── workspace-builder/
├── workspace-diagnostician/
├── workspace-explorer/
├── workspace-hr/
├── workspace-main/
├── workspace-pm/
├── workspace-repair/
├── workspace-research/
├── workspace-resource-scout/
└── workspace-verification/
```

### Schema

The central database aggregates the following tables:

| Table | Description |
|-------|-------------|
| `aggregated_sessions` | Session metadata from all workspaces |
| `aggregated_tool_calls` | Tool execution outcomes (success/failure) |
| `aggregated_pain_events` | Pain signals detected across workspaces |
| `aggregated_user_corrections` | User corrections (where `correction_detected = 1`) |
| `aggregated_principle_events` | Principle application events |
| `aggregated_thinking_events` | Thinking model trigger events |
| `aggregated_correction_samples` | Training samples for review |
| `aggregated_task_outcomes` | Task completion outcomes |
| `workspace_config` | Per-workspace settings (enabled/syncEnabled) |
| `sync_log` | Sync operation audit trail |

### Sync Behavior

1. **Workspace Discovery**: On startup, scans for `workspace-*` directories
2. **Config Check**: Only syncs workspaces where `sync_enabled = 1` in `workspace_config`
3. **Table Skipping**: Gracefully handles missing tables (e.g., `thinking_model_events` not present in older workspace schemas)
4. **Incremental**: Uses `INSERT OR REPLACE` for sessions/samples, `INSERT` for events

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/central/overview` | GET | Aggregated overview stats |
| `/api/central/sync` | POST | Trigger sync for all enabled workspaces |
| `/api/central/workspaces` | GET | List all workspaces with configs |
| `/api/central/workspaces/:name` | GET | Get single workspace config |
| `/api/central/workspaces/:name` | PATCH | Update workspace config |
| `/api/central/workspaces` | POST | Add custom workspace |

### UI Components

**WorkspaceConfig Component** (Overview Page):
- Lists all discovered workspaces with Include/Sync toggles
- Shows workspace name, path, and last sync time
- "Add Custom Workspace" button to add non-standard workspace paths
- Inline form for adding custom workspaces (name + path inputs)

### Custom Workspace Support

Users can add arbitrary workspace paths via the UI. This is useful for:
- Development/testing workspaces
- Custom-named workspaces outside the `workspace-*` pattern
- Workspaces on external drives or alternate locations

---

## Files to Modify

```
packages/openclaw-plugin/
├── src/
│   ├── service/
│   │   ├── central-database.ts    # Central DB aggregation service
│   │   └── control-ui-query-service.ts
│   └── http/
│       └── principles-console-route.ts  # API routes
├── ui/src/
│   ├── App.tsx             # WorkspaceConfig component + custom workspace form
│   └── api.ts              # Central API methods
└── docs/design/
    └── 2026-03-25-webconsole-redesign.md  # This architecture doc
```

---

## Success Criteria

- [ ] All emoji replaced with Lucide icons
- [ ] Color system uses new CSS variables
- [ ] Typography uses Inter + JetBrains Mono + Calistoga
- [ ] All cards have hover lift effect
- [ ] KPI numbers displayed in mono font
- [ ] Navigation has smooth active state transitions
- [ ] Timeline animations work smoothly
- [ ] Responsive layout works on tablet/mobile
- [ ] Accessibility: focus states visible
- [ ] Performance: animations at 60fps
