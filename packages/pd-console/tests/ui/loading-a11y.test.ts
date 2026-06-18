/**
 * Accessibility regression test for loading states (PR #965 review feedback).
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components. Instead we verify the source-code contract: every page
 * loading branch must expose a live region (role="status" aria-live="polite")
 * with a localized aria-label, so screen readers announce the loading state.
 *
 * This guards against accidentally removing these attributes in future edits.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, "..", "..", "src", "ui");

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), "utf-8");
}

describe("PageLoading component: live-region contract", () => {
  const source = readSrc("components/layout/page-loading.tsx");

  it("declares role=\"status\" on the root container", () => {
    expect(source).toContain('role="status"');
  });

  it("declares aria-live=\"polite\" on the root container", () => {
    expect(source).toContain('aria-live="polite"');
  });

  it("requires a localized label prop (not a hardcoded string)", () => {
    // The label must be a prop, not a hardcoded literal, so callers pass
    // i18n-translated text.
    expect(source).toMatch(/label:\s*string/);
    expect(source).toContain("aria-label={label}");
  });
});

describe("Pages using PageLoading: pass a localized label", () => {
  // Pages that import PageLoading must pass label={...} — not call it bare.
  const PAGES_USING_PAGE_LOADING = [
    "pages/activation/ActivationPage.tsx",
    "pages/control-center/ControlCenterPage.tsx",
    "pages/focus/FocusPage.tsx",
    "pages/pain/PainPage.tsx",
    "pages/principles/PrincipleDetailPage.tsx",
    "pages/report-problem/ReportProblemPage.tsx",
    "pages/settings/SettingsPage.tsx",
    "pages/settings/UpdatePage.tsx",
  ];

  for (const relPath of PAGES_USING_PAGE_LOADING) {
    it(`${relPath} passes label={...} to every PageLoading usage`, () => {
      const source = readSrc(relPath);
      // Every occurrence of <PageLoading must be followed (within the same tag)
      // by label={...}. A bare <PageLoading ... /> without label is a regression.
      const usages = source.match(/<PageLoading\b[^>]*\/>/g) ?? [];
      expect(usages.length, "expected at least one PageLoading usage").toBeGreaterThan(0);
      for (const usage of usages) {
        expect(usage, `missing label prop in: ${usage}`).toMatch(/label=\{/);
      }
    });
  }
});

describe("PrinciplesPage inline skeleton: live-region contract", () => {
  // PrinciplesPage uses an inline skeleton (different card shape) instead of
  // PageLoading, so we verify the live-region attributes directly.
  const source = readSrc("pages/principles/PrinciplesPage.tsx");

  it("the inline loading block declares role=\"status\"", () => {
    expect(source).toContain('role="status"');
  });

  it("the inline loading block declares aria-live=\"polite\"", () => {
    expect(source).toContain('aria-live="polite"');
  });

  it("the inline loading block has a localized aria-label", () => {
    // Must use t(...) for the label, not a hardcoded English string.
    expect(source).toMatch(/aria-label=\{t\(/);
  });
});
