/**
 * Accessibility regression test for ShinyText page-title wrapping (PR #1060 review).
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components. Instead we verify the source-code contract:
 *
 * 1. ShinyText must accept an `as` prop so callers can preserve heading
 *    semantics — the shimmer is a visual effect, not a structural change.
 *    Replacing <h1> with <span> removes the page's only heading and breaks
 *    screen-reader navigation.
 * 2. Every page that wraps its title in <ShinyText> must pass as="h1".
 *
 * This guards against accidentally regressing back to a bare <span> render.
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

describe("ShinyText component: `as` prop contract", () => {
  const source = readSrc("components/ui/shiny-text.tsx");

  it("declares an `as` prop on ShinyTextProps", () => {
    expect(source).toMatch(/as\??\s*:\s*ElementType/);
  });

  it("renders the underlying Component instead of a hardcoded <span>", () => {
    // Both the disabled and enabled branches must render <Component ...>,
    // not a hardcoded <span>.
    const componentRenders = source.match(/<Component\b/g) ?? [];
    expect(componentRenders.length, "expected at least two <Component> renders").toBeGreaterThanOrEqual(2);
    // No hardcoded <span> should remain as the rendered element.
    expect(source).not.toMatch(/return\s*\(\s*<span/);
    expect(source).not.toMatch(/return\s*<span/);
  });
});

describe("Pages wrapping titles in ShinyText: pass as=\"h1\"", () => {
  const PAGES_WITH_SHINY_TITLE = [
    "pages/activation/ActivationPage.tsx",
    "pages/focus/FocusPage.tsx",
    "pages/pain/PainPage.tsx",
    "pages/principles/PrinciplesPage.tsx",
  ];

  for (const relPath of PAGES_WITH_SHINY_TITLE) {
    it(`${relPath} passes as="h1" to every ShinyText usage`, () => {
      const source = readSrc(relPath);
      const usages = source.match(/<ShinyText\b[^>]*>/g) ?? [];
      expect(usages.length, "expected at least one ShinyText usage").toBeGreaterThanOrEqual(1);
      for (const usage of usages) {
        expect(usage, `missing as="h1" in: ${usage}`).toMatch(/as="h1"/);
      }
    });

    it(`${relPath} preserves text-ink on the ShinyText className`, () => {
      // The gradient uses currentColor; dropping text-ink changes the base
      // color and the visual identity of the title.
      const source = readSrc(relPath);
      const usages = source.match(/<ShinyText\b[^>]*>/g) ?? [];
      for (const usage of usages) {
        expect(usage, `missing text-ink in: ${usage}`).toMatch(/text-ink/);
      }
    });
  }
});
