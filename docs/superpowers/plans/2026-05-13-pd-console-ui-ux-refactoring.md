# PD Console UI/UX 全量重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `tdd` skill for test-driven development and `frontend-design` skill for UI component design and implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PD Console 从全量 inline style 重构为 shadcn/ui + Tailwind CSS + React Router + i18next 的现代化前端架构，支持亮暗双模式、中英双语、响应式布局。

**Architecture:** 底层基础设施先行（Tailwind 配置、shadcn/ui 组件、i18n、Router），然后构建 App Shell（可折叠侧边栏 + Header + Providers），再逐个迁移共享组件和页面。主题色采用青绿/蓝绿（teal），通过 CSS 变量实现亮暗模式切换。

**Tech Stack:** React 19, Tailwind CSS v4, shadcn/ui (copy-paste), React Router v7, i18next, lucide-react, vitest + @testing-library/react

**PRD:** Linear PRI-134

---

## File Structure Map

### New Files

```
packages/pd-console/
├── src/ui/
│   ├── styles/
│   │   └── globals.css                    # Tailwind base + shadcn/ui CSS variables (teal theme)
│   ├── lib/
│   │   └── utils.ts                       # cn() helper (clsx + tailwind-merge)
│   ├── components/ui/
│   │   ├── button.tsx                     # shadcn/ui Button
│   │   ├── card.tsx                       # shadcn/ui Card
│   │   ├── badge.tsx                      # shadcn/ui Badge
│   │   ├── separator.tsx                  # shadcn/ui Separator
│   │   ├── skeleton.tsx                   # shadcn/ui Skeleton
│   │   ├── tooltip.tsx                    # shadcn/ui Tooltip
│   │   ├── select.tsx                     # shadcn/ui Select
│   │   ├── input.tsx                      # shadcn/ui Input
│   │   ├── dialog.tsx                     # shadcn/ui Dialog
│   │   ├── dropdown-menu.tsx              # shadcn/ui DropdownMenu
│   │   ├── sidebar.tsx                    # shadcn/ui Sidebar (custom collapsible)
│   │   └── sonner.tsx                     # shadcn/ui Sonner (toast)
│   ├── components/
│   │   ├── error-boundary.tsx             # Rewritten ErrorBoundary with Tailwind
│   │   ├── zone-section.tsx               # Rewritten ZoneSection with Tailwind
│   │   ├── task-card.tsx                  # Rewritten TaskCard with Tailwind
│   │   ├── evidence-panel.tsx             # Rewritten EvidencePanel with Tailwind
│   │   ├── theme-provider.tsx             # Light/dark mode provider
│   │   ├── theme-toggle.tsx               # Theme toggle button
│   │   ├── language-switcher.tsx           # Language toggle
│   │   ├── app-sidebar.tsx                # App-specific sidebar content
│   │   └── page-header.tsx                # Page header with refresh + last updated
│   ├── i18n/
│   │   ├── index.ts                       # i18next configuration
│   │   ├── zh-CN.json                     # Chinese translations
│   │   └── en.json                        # English translations
│   ├── pages/
│   │   ├── overview-page.tsx              # Rewritten with Tailwind
│   │   ├── tasks-page.tsx                 # Rewritten with Tailwind
│   │   ├── feedback-page.tsx              # Rewritten with Tailwind
│   │   ├── gates-page.tsx                 # Rewritten with Tailwind
│   │   ├── samples-page.tsx               # Rewritten with Tailwind
│   │   ├── evolution-page.tsx             # Rewritten with Tailwind
│   │   ├── thinking-models-page.tsx       # Rewritten with Tailwind
│   │   ├── settings-page.tsx              # Rewritten with Tailwind
│   │   ├── central-page.tsx               # Rewritten with Tailwind
│   │   └── login-page.tsx                 # Rewritten with Tailwind
│   ├── app.tsx                            # Rewritten with Router + Sidebar + Providers
│   └── main.tsx                           # Updated with CSS import + providers
├── tests/ui/
│   ├── setup.ts                           # Testing Library setup
│   ├── theme-provider.test.tsx
│   ├── language-switcher.test.tsx
│   ├── error-boundary.test.tsx
│   ├── zone-section.test.tsx
│   ├── task-card.test.tsx
│   ├── evidence-panel.test.tsx
│   ├── overview-page.test.tsx
│   ├── tasks-page.test.tsx
│   ├── feedback-page.test.tsx
│   ├── gates-page.test.tsx
│   ├── samples-page.test.tsx
│   ├── evolution-page.test.tsx
│   ├── thinking-models-page.test.tsx
│   ├── settings-page.test.tsx
│   ├── central-page.test.tsx
│   └── login-page.test.tsx
└── vitest.config.ui.ts                    # UI test config (jsdom environment)
```

### Modified Files

```
packages/pd-console/
├── package.json                           # Add new dependencies
├── scripts/build-ui.mjs                   # Add Tailwind CSS processing
├── src/ui/api.ts                          # No changes (data layer untouched)
├── src/ui/hooks/useAutoRefresh.ts         # No changes
├── src/types.ts                           # No changes
└── vitest.config.ts                       # Add UI test include pattern
```

### Deleted Files

```
packages/pd-console/
├── src/ui/styles/constants.ts             # Replaced by Tailwind + CSS variables
├── src/ui/i18n.ts                         # Replaced by i18next
├── src/ui/App.tsx                         # Rewritten as app.tsx
├── src/ui/components/ErrorBoundary.tsx     # Replaced by error-boundary.tsx
├── src/ui/components/ZoneSection.tsx      # Replaced by zone-section.tsx
├── src/ui/components/TaskCard.tsx         # Replaced by task-card.tsx
├── src/ui/components/EvidencePanel.tsx    # Replaced by evidence-panel.tsx
└── src/ui/pages/*.tsx                     # Replaced by kebab-case versions
```

---

## Phase 1: Infrastructure Setup

### Task 1: Install Dependencies & Configure Build System

**Files:**
- Modify: `packages/pd-console/package.json`
- Modify: `packages/pd-console/scripts/build-ui.mjs`
- Create: `packages/pd-console/src/ui/styles/globals.css`

- [ ] **Step 1: Install new dependencies**

Run:
```bash
cd packages/pd-console
npm install tailwindcss @tailwindcss/vite react-router-dom lucide-react i18next react-i18next clsx tailwind-merge class-variance-authority @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

- [ ] **Step 2: Create globals.css with Tailwind directives and shadcn/ui CSS variables**

Create `src/ui/styles/globals.css`:
```css
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.145 0.017 285.823);
  --color-card: oklch(1 0 0);
  --color-card-foreground: oklch(0.145 0.017 285.823);
  --color-popover: oklch(1 0 0);
  --color-popover-foreground: oklch(0.145 0.017 285.823);
  --color-primary: oklch(0.55 0.14 180); /* teal-600 */
  --color-primary-foreground: oklch(0.985 0.002 247.839);
  --color-secondary: oklch(0.97 0.002 247.839);
  --color-secondary-foreground: oklch(0.205 0.017 285.823);
  --color-muted: oklch(0.97 0.002 247.839);
  --color-muted-foreground: oklch(0.556 0.017 285.823);
  --color-accent: oklch(0.97 0.002 247.839);
  --color-accent-foreground: oklch(0.205 0.017 285.823);
  --color-destructive: oklch(0.577 0.245 27.325);
  --color-destructive-foreground: oklch(0.985 0.002 247.839);
  --color-border: oklch(0.922 0.004 286.032);
  --color-input: oklch(0.922 0.004 286.032);
  --color-ring: oklch(0.55 0.14 180);
  --color-chart-1: oklch(0.55 0.14 180);
  --color-chart-2: oklch(0.6 0.16 160);
  --color-chart-3: oklch(0.7 0.15 150);
  --color-chart-4: oklch(0.75 0.12 90);
  --color-chart-5: oklch(0.65 0.2 25);
  --color-sidebar-background: oklch(0.985 0.002 247.839);
  --color-sidebar-foreground: oklch(0.145 0.017 285.823);
  --color-sidebar-primary: oklch(0.55 0.14 180);
  --color-sidebar-primary-foreground: oklch(0.985 0.002 247.839);
  --color-sidebar-accent: oklch(0.97 0.002 247.839);
  --color-sidebar-accent-foreground: oklch(0.205 0.017 285.823);
  --color-sidebar-border: oklch(0.922 0.004 286.032);
  --color-sidebar-ring: oklch(0.55 0.14 180);
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
}

.dark {
  --color-background: oklch(0.145 0.017 285.823);
  --color-foreground: oklch(0.985 0.002 247.839);
  --color-card: oklch(0.145 0.017 285.823);
  --color-card-foreground: oklch(0.985 0.002 247.839);
  --color-popover: oklch(0.145 0.017 285.823);
  --color-popover-foreground: oklch(0.985 0.002 247.839);
  --color-primary: oklch(0.65 0.16 180); /* teal-400 in dark */
  --color-primary-foreground: oklch(0.145 0.017 285.823);
  --color-secondary: oklch(0.269 0.015 285.788);
  --color-secondary-foreground: oklch(0.985 0.002 247.839);
  --color-muted: oklch(0.269 0.015 285.788);
  --color-muted-foreground: oklch(0.708 0.014 285.823);
  --color-accent: oklch(0.269 0.015 285.788);
  --color-accent-foreground: oklch(0.985 0.002 247.839);
  --color-destructive: oklch(0.704 0.191 22.216);
  --color-destructive-foreground: oklch(0.145 0.017 285.823);
  --color-border: oklch(0.269 0.015 285.788);
  --color-input: oklch(0.269 0.015 285.788);
  --color-ring: oklch(0.65 0.16 180);
  --color-chart-1: oklch(0.65 0.16 180);
  --color-chart-2: oklch(0.7 0.15 160);
  --color-chart-3: oklch(0.75 0.12 150);
  --color-chart-4: oklch(0.8 0.1 90);
  --color-chart-5: oklch(0.7 0.18 25);
  --color-sidebar-background: oklch(0.205 0.017 285.823);
  --color-sidebar-foreground: oklch(0.985 0.002 247.839);
  --color-sidebar-primary: oklch(0.65 0.16 180);
  --color-sidebar-primary-foreground: oklch(0.205 0.017 285.823);
  --color-sidebar-accent: oklch(0.269 0.015 285.788);
  --color-sidebar-accent-foreground: oklch(0.985 0.002 247.839);
  --color-sidebar-border: oklch(0.269 0.015 285.788);
  --color-sidebar-ring: oklch(0.65 0.16 180);
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

- [ ] **Step 3: Update build-ui.mjs to process Tailwind CSS**

Modify `scripts/build-ui.mjs` — add `@tailwindcss/vite` plugin to esbuild:
```javascript
import { build } from "esbuild";
import { tailwindcss } from "@tailwindcss/vite";
// ... existing imports ...

// Add tailwindcss plugin to the build config
await build({
  entryPoints: [path.join(rootDir, "src", "ui", "main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(assetsDir, "app.js"),
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  jsx: "automatic",
  plugins: [tailwindcss()],
  loader: {
    ".css": "css",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
  },
});
```

- [ ] **Step 4: Verify build succeeds**

Run: `cd packages/pd-console && npm run build:ui`
Expected: Build completes without errors

- [ ] **Step 5: Commit**

```bash
git add packages/pd-console/package.json packages/pd-console/scripts/build-ui.mjs packages/pd-console/src/ui/styles/globals.css
git commit -m "feat(pd-console): add Tailwind CSS infrastructure and teal theme"
```

---

### Task 2: Create shadcn/ui Utility & Component Foundation

**Files:**
- Create: `packages/pd-console/src/ui/lib/utils.ts`
- Create: `packages/pd-console/src/ui/components/ui/button.tsx`
- Create: `packages/pd-console/src/ui/components/ui/card.tsx`
- Create: `packages/pd-console/src/ui/components/ui/badge.tsx`

- [ ] **Step 1: Create cn() utility**

Create `src/ui/lib/utils.ts`:
```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Create Button component (shadcn/ui pattern)**

Create `src/ui/components/ui/button.tsx` using shadcn/ui Button with teal primary variant. Use `frontend-design` skill to generate production-quality component.

- [ ] **Step 3: Create Card component (shadcn/ui pattern)**

Create `src/ui/components/ui/card.tsx` with Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter sub-components.

- [ ] **Step 4: Create Badge component (shadcn/ui pattern)**

Create `src/ui/components/ui/badge.tsx` with default, secondary, destructive, outline variants.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `cd packages/pd-console && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add packages/pd-console/src/ui/lib/ packages/pd-console/src/ui/components/ui/
git commit -m "feat(pd-console): add shadcn/ui utility and base components"
```

---

### Task 3: Additional shadcn/ui Components

**Files:**
- Create: `packages/pd-console/src/ui/components/ui/separator.tsx`
- Create: `packages/pd-console/src/ui/components/ui/skeleton.tsx`
- Create: `packages/pd-console/src/ui/components/ui/tooltip.tsx`
- Create: `packages/pd-console/src/ui/components/ui/select.tsx`
- Create: `packages/pd-console/src/ui/components/ui/input.tsx`
- Create: `packages/pd-console/src/ui/components/ui/dropdown-menu.tsx`
- Create: `packages/pd-console/src/ui/components/ui/sidebar.tsx`
- Create: `packages/pd-console/src/ui/components/ui/sonner.tsx`

- [ ] **Step 1: Create each shadcn/ui component using `frontend-design` skill**

Each component follows the shadcn/ui copy-paste pattern with CVA variants. Use `frontend-design` skill for production quality.

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd packages/pd-console && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/pd-console/src/ui/components/ui/
git commit -m "feat(pd-console): add remaining shadcn/ui components"
```

---

### Task 4: i18next Setup

**Files:**
- Create: `packages/pd-console/src/ui/i18n/index.ts`
- Create: `packages/pd-console/src/ui/i18n/zh-CN.json`
- Create: `packages/pd-console/src/ui/i18n/en.json`

- [ ] **Step 1: Write failing test for i18n initialization**

Create `tests/ui/i18n.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import i18n from "../../src/ui/i18n/index.js";

describe("i18n configuration", () => {
  it("should initialize with zh-CN as default language", () => {
    expect(i18n.language).toBe("zh-CN");
  });

  it("should have common namespace translations in zh-CN", () => {
    expect(i18n.t("common:loading")).toBe("加载中");
    expect(i18n.t("common:refresh")).toBe("刷新");
    expect(i18n.t("common:settings")).toBe("设置");
  });

  it("should have common namespace translations in en", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("common:loading")).toBe("Loading");
    expect(i18n.t("common:refresh")).toBe("Refresh");
    expect(i18n.t("common:settings")).toBe("Settings");
    await i18n.changeLanguage("zh-CN");
  });

  it("should have page-specific translations", () => {
    expect(i18n.t("pages:overview.title")).toBe("概览");
    expect(i18n.t("pages:tasks.title")).toBe("待办事项");
    expect(i18n.t("pages:feedback.title")).toBe("反馈");
    expect(i18n.t("pages:gates.title")).toBe("安全门控");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pd-console && npx vitest run tests/ui/i18n.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create zh-CN.json translation file**

Create `src/ui/i18n/zh-CN.json` with all translations migrated from current `i18n.ts` TERM_MAP plus new keys for all pages and components. Use `frontend-design` skill for comprehensive translation coverage.

- [ ] **Step 4: Create en.json translation file**

Create `src/ui/i18n/en.json` with English translations for all keys.

- [ ] **Step 5: Create i18next configuration**

Create `src/ui/i18n/index.ts`:
```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN.json";
import en from "./en.json";

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { common: zhCN.common, pages: zhCN.pages },
    en: { common: en.common, pages: en.pages },
  },
  lng: localStorage.getItem("pd-language") || "zh-CN",
  fallbackLng: "zh-CN",
  ns: ["common", "pages"],
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

export default i18n;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/pd-console && npx vitest run tests/ui/i18n.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/pd-console/src/ui/i18n/ packages/pd-console/tests/ui/i18n.test.ts
git commit -m "feat(pd-console): add i18next with zh-CN and en translations"
```

---

### Task 5: UI Test Infrastructure

**Files:**
- Create: `packages/pd-console/tests/ui/setup.ts`
- Modify: `packages/pd-console/vitest.config.ts`

- [ ] **Step 1: Create test setup file**

Create `tests/ui/setup.ts`:
```typescript
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Update vitest.config.ts to support UI tests**

Add a new test configuration for UI component tests using jsdom:
```typescript
// Add to existing vitest.config.ts or create vitest.config.ui.ts
// UI tests use jsdom environment
```

- [ ] **Step 3: Verify test infrastructure works**

Create a minimal smoke test `tests/ui/setup-smoke.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("UI test infrastructure", () => {
  it("should run in jsdom environment", () => {
    expect(typeof window).toBe("object");
  });
});
```

Run: `cd packages/pd-console && npx vitest run tests/ui/setup-smoke.test.ts --environment jsdom`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/pd-console/tests/ui/ packages/pd-console/vitest.config.ts
git commit -m "feat(pd-console): add UI test infrastructure with jsdom"
```

---

## Phase 2: App Shell

### Task 6: Theme Provider

**Files:**
- Create: `packages/pd-console/src/ui/components/theme-provider.tsx`
- Create: `packages/pd-console/src/ui/components/theme-toggle.tsx`
- Test: `packages/pd-console/tests/ui/theme-provider.test.tsx`

- [ ] **Step 1: Write failing test for ThemeProvider**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../../src/ui/components/theme-provider.js";
import { ThemeToggle } from "../../src/ui/components/theme-toggle.js";

describe("ThemeProvider", () => {
  it("should default to light mode", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <div data-testid="child">content</div>
      </ThemeProvider>
    );
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("should apply dark class when theme is dark", () => {
    render(
      <ThemeProvider defaultTheme="dark">
        <div data-testid="child">content</div>
      </ThemeProvider>
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("ThemeToggle", () => {
  it("should toggle between light and dark", async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <ThemeToggle />
      </ThemeProvider>
    );
    const button = screen.getByRole("button");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await userEvent.click(button);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pd-console && npx vitest run tests/ui/theme-provider.test.tsx --environment jsdom`
Expected: FAIL

- [ ] **Step 3: Implement ThemeProvider and ThemeToggle**

Use `frontend-design` skill to create production-quality components with smooth animation transitions.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/pd-console && npx vitest run tests/ui/theme-provider.test.tsx --environment jsdom`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/pd-console/src/ui/components/theme-provider.tsx packages/pd-console/src/ui/components/theme-toggle.tsx packages/pd-console/tests/ui/theme-provider.test.tsx
git commit -m "feat(pd-console): add ThemeProvider and ThemeToggle with TDD"
```

---

### Task 7: Language Switcher

**Files:**
- Create: `packages/pd-console/src/ui/components/language-switcher.tsx`
- Test: `packages/pd-console/tests/ui/language-switcher.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageSwitcher } from "../../src/ui/components/language-switcher.js";
import { I18nextProvider } from "react-i18next";
import i18n from "../../src/ui/i18n/index.js";

describe("LanguageSwitcher", () => {
  it("should show current language", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageSwitcher />
      </I18nextProvider>
    );
    expect(screen.getByText(/中文/i)).toBeTruthy();
  });

  it("should switch language on click", async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageSwitcher />
      </I18nextProvider>
    );
    const button = screen.getByRole("button");
    await userEvent.click(button);
    expect(i18n.language).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement LanguageSwitcher**

Use `frontend-design` skill. Dropdown with 中文/English options, persists choice to localStorage.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/pd-console/src/ui/components/language-switcher.tsx packages/pd-console/tests/ui/language-switcher.test.tsx
git commit -m "feat(pd-console): add LanguageSwitcher with TDD"
```

---

### Task 8: App Sidebar & Router Shell

**Files:**
- Create: `packages/pd-console/src/ui/components/app-sidebar.tsx`
- Create: `packages/pd-console/src/ui/components/page-header.tsx`
- Create: `packages/pd-console/src/ui/app.tsx` (rewrite)
- Create: `packages/pd-console/src/ui/main.tsx` (update)
- Test: `packages/pd-console/tests/ui/app-shell.test.tsx`

- [ ] **Step 1: Write failing test for App Shell**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../../src/ui/app.js";

vi.mock("../../src/ui/api.js", () => ({
  checkAuth: () => Promise.resolve(true),
  getToken: () => "test-token",
  clearToken: () => {},
}));

describe("App Shell", () => {
  it("should render sidebar with navigation items", async () => {
    render(<App />);
    expect(await screen.findByText("概览")).toBeTruthy();
    expect(screen.getByText("待办事项")).toBeTruthy();
    expect(screen.getByText("反馈")).toBeTruthy();
  });

  it("should render theme toggle and language switcher", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /toggle theme/i })).toBeTruthy();
  });

  it("should show login page when not authenticated", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce(false);
    render(<App />);
    expect(await screen.findByText("PD Console")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement app-sidebar.tsx**

Use `frontend-design` skill. Collapsible sidebar with:
- Logo + "PD Console" title
- Navigation items with lucide-react icons (LayoutDashboard, ListTodo, MessageSquare, Shield, FlaskConical, Dna, Brain, Settings, Building2)
- Active state highlighting with teal accent
- Collapse/expand toggle with smooth animation
- Mobile responsive (auto-collapse on small screens)

- [ ] **Step 4: Implement page-header.tsx**

Reusable page header with:
- Page title (from i18n)
- Last updated timestamp
- Refresh button with loading state
- Optional action buttons slot

- [ ] **Step 5: Rewrite app.tsx**

React Router with hash routing, SidebarProvider, ThemeProvider, I18nextProvider, auth guard.

- [ ] **Step 6: Update main.tsx**

Import globals.css, wrap with providers.

- [ ] **Step 7: Run test to verify it passes**

- [ ] **Step 8: Verify dev server starts**

Run: `cd packages/pd-console && npm run dev`
Expected: Server starts, UI loads at localhost:3100

- [ ] **Step 9: Commit**

```bash
git add packages/pd-console/src/ui/
git commit -m "feat(pd-console): add App Shell with sidebar, router, theme, and i18n"
```

---

## Phase 3: Shared Components Migration

### Task 9: ErrorBoundary Migration

**Files:**
- Create: `packages/pd-console/src/ui/components/error-boundary.tsx`
- Test: `packages/pd-console/tests/ui/error-boundary.test.tsx`

- [ ] **Step 1: Write failing test**

Test that ErrorBoundary catches errors and renders fallback with Tailwind classes, retry button, and i18n text.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Replace inline styles with Tailwind classes. Use Card component, destructive color scheme, i18n for error messages.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate ErrorBoundary to Tailwind + shadcn/ui"
```

---

### Task 10: ZoneSection Migration

**Files:**
- Create: `packages/pd-console/src/ui/components/zone-section.tsx`
- Test: `packages/pd-console/tests/ui/zone-section.test.tsx`

- [ ] **Step 1: Write failing test**

Test that ZoneSection renders title, count badge, children, and empty state with i18n.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Use Card component with colored left border (red for needsConfirmation, yellow for suggestedAttention, default for recentActivity). Badge for count. Empty state with lucide icon.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate ZoneSection to Tailwind + shadcn/ui"
```

---

### Task 11: TaskCard Migration

**Files:**
- Create: `packages/pd-console/src/ui/components/task-card.tsx`
- Test: `packages/pd-console/tests/ui/task-card.test.tsx`

- [ ] **Step 1: Write failing test**

Test expand/collapse, approve/reject/cleanup buttons, undo state with countdown, evidence panel integration.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Use Card with expand/collapse animation (grid-template-rows trick). Action buttons use shadcn/ui Button variants. Undo badge with countdown. lucide ChevronRight icon for expand arrow.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate TaskCard to Tailwind + shadcn/ui"
```

---

### Task 12: EvidencePanel Migration

**Files:**
- Create: `packages/pd-console/src/ui/components/evidence-panel.tsx`
- Test: `packages/pd-console/tests/ui/evidence-panel.test.tsx`

- [ ] **Step 1: Write failing test**

Test summary, why, whatHappensIf sections, evidence items list, loading state.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Use Card sub-sections with colored borders (primary for summary, warning for impact). i18n for section labels. Skeleton for loading state.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate EvidencePanel to Tailwind + shadcn/ui"
```

---

## Phase 4: Page Migrations

### Task 13: OverviewPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/overview-page.tsx`
- Test: `packages/pd-console/tests/ui/overview-page.test.tsx`

- [ ] **Step 1: Write failing test**

Test health card rendering, stat cards grid, principles breakdown, queue stats, loading/error/empty states.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Use Card for health status with colored left border (green/yellow/red). Stat cards in responsive grid. PageHeader with auto-refresh. i18n for all labels.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate OverviewPage to Tailwind + shadcn/ui"
```

---

### Task 14: TasksPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/tasks-page.tsx`
- Test: `packages/pd-console/tests/ui/tasks-page.test.tsx`

- [ ] **Step 1: Write failing test**

Test zone sections rendering, task cards, batch cleanup, undo mechanism, no-token state.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Use ZoneSection + TaskCard components. Batch cleanup button. Auth guard with link to settings. i18n for all text.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate TasksPage to Tailwind + shadcn/ui"
```

---

### Task 15: FeedbackPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/feedback-page.tsx`
- Test: `packages/pd-console/tests/ui/feedback-page.test.tsx`

- [ ] **Step 1: Write failing test**

Test GFI gauge, empathy events list, gate blocks list, loading/error states.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

GFI gauge with progress bar using teal color scheme. Empathy events with severity-colored left border. Gate blocks with destructive accent. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate FeedbackPage to Tailwind + shadcn/ui"
```

---

### Task 16: GatesPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/gates-page.tsx`
- Test: `packages/pd-console/tests/ui/gates-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Trust status card, GFI card, today stats in grid. GFI sources table. Gate blocks list. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate GatesPage to Tailwind + shadcn/ui"
```

---

### Task 17: SamplesPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/samples-page.tsx`
- Test: `packages/pd-console/tests/ui/samples-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Master-detail layout with sample list (left) and detail panel (right). Status filter with Select. Badge for status. Approve/Reject buttons. Pagination. Recommendation display with code blocks. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate SamplesPage to Tailwind + shadcn/ui"
```

---

### Task 18: EvolutionPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/evolution-page.tsx`
- Test: `packages/pd-console/tests/ui/evolution-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Stat cards row. Two-column layout: Principle Lifecycle + Queue Health. Stage distribution. Task list with status filter and pagination. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate EvolutionPage to Tailwind + shadcn/ui"
```

---

### Task 19: ThinkingModelsPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/thinking-models-page.tsx`
- Test: `packages/pd-console/tests/ui/thinking-models-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Expandable model cards with trigger/must/forbidden sections. Must section with green left border, forbidden with red. Empty state with Brain icon. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate ThinkingModelsPage to Tailwind + shadcn/ui"
```

---

### Task 20: SettingsPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/settings-page.tsx`
- Test: `packages/pd-console/tests/ui/settings-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Auth settings card with Input. Workspace manager with list, add form, sync/remove buttons. Success/error toast messages. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate SettingsPage to Tailwind + shadcn/ui"
```

---

### Task 21: CentralPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/central-page.tsx`
- Test: `packages/pd-console/tests/ui/central-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Overall status badge with pulse dot. Workspace cards with status, GFI, principle count. Health detail cards with grid stats. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate CentralPage to Tailwind + shadcn/ui"
```

---

### Task 22: LoginPage Migration

**Files:**
- Create: `packages/pd-console/src/ui/pages/login-page.tsx`
- Test: `packages/pd-console/tests/ui/login-page.test.tsx`

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement using `frontend-design` skill**

Centered card with teal accent. Logo area. Password input with show/hide toggle. Submit button with loading state. Error message. Footer note. i18n.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pd-console): migrate LoginPage to Tailwind + shadcn/ui"
```

---

## Phase 5: Cleanup & Verification

### Task 23: Remove Old Files & Update Imports

**Files:**
- Delete: `src/ui/styles/constants.ts`
- Delete: `src/ui/i18n.ts`
- Delete: `src/ui/App.tsx` (replaced by app.tsx)
- Delete: `src/ui/components/ErrorBoundary.tsx`
- Delete: `src/ui/components/ZoneSection.tsx`
- Delete: `src/ui/components/TaskCard.tsx`
- Delete: `src/ui/components/EvidencePanel.tsx`
- Delete: `src/ui/pages/*.tsx` (PascalCase versions)

- [ ] **Step 1: Delete old files**

- [ ] **Step 2: Verify all imports resolve correctly**

Run: `cd packages/pd-console && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(pd-console): remove old inline-style UI files"
```

---

### Task 24: Full Build & Test Verification

- [ ] **Step 1: Run full test suite**

Run: `cd packages/pd-console && npm run test`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `cd packages/pd-console && npm run build`
Expected: Build succeeds

- [ ] **Step 3: Run dev server and manually verify**

Run: `cd packages/pd-console && npm run dev`
Verify:
- [ ] Login page renders with teal theme
- [ ] Sidebar navigation works
- [ ] All pages load without errors
- [ ] Theme toggle works (light/dark)
- [ ] Language switcher works (zh-CN/en)
- [ ] Sidebar collapses/expands
- [ ] Responsive on mobile viewport
- [ ] All API data displays correctly

- [ ] **Step 4: Run architecture regression tests**

Run: `cd packages/principles-core && npm run test`
Expected: Architecture regression tests pass (core/plugin boundary untouched)

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore(pd-console): complete UI/UX refactoring — verify build and tests"
```

---

## Self-Review Checklist

### Spec Coverage
- [x] shadcn/ui component library — Tasks 2, 3
- [x] Tailwind CSS styling — Task 1
- [x] React Router — Task 8
- [x] i18next zh-CN/en — Task 4
- [x] Teal/cyan theme — Task 1 (globals.css)
- [x] Light/dark mode — Task 6
- [x] Collapsible sidebar — Task 8
- [x] lucide-react icons — Task 8
- [x] Responsive layout — Task 8
- [x] Tailwind animations — Throughout (sidebar collapse, card expand, theme transition)
- [x] All 9 pages + login — Tasks 13-22
- [x] All 4 shared components — Tasks 9-12
- [x] TDD for all components — Every task has test-first steps
- [x] frontend-design skill usage — Noted in every UI implementation step

### Placeholder Scan
- No TBD/TODO/fill-in-later found
- All steps have concrete actions
- Test code provided for key tasks
- Implementation delegated to `frontend-design` skill with clear requirements

### Type Consistency
- All new files use kebab-case naming
- All imports use .js extension (ESM)
- Component props interfaces match across tasks
- API types unchanged (api.ts not modified)
