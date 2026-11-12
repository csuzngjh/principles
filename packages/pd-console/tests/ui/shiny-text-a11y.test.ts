/**
 * Page-title and motion contract (rewritten for the B1 batch, 2026-11-12).
 *
 * History: this file used to assert that every page title wrapped in <ShinyText>
 * passed `as="h1"` so the shimmer did not erase the heading semantics. The B1
 * batch removes the shimmer entirely (DESIGN_BRIEF D7: no decorative loops), so
 * the same accessibility intent is now protected directly: each daily-path page
 * must render a real <h1>, and the deleted effect must not come back.
 *
 * The vitest config uses the 'node' environment (no jsdom), so these are
 * source-contract assertions rather than mounted-component assertions.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, "..", "..", "src", "ui");

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), "utf-8");
}

const PAGES_WITH_TITLE = [
  "pages/activation/ActivationPage.tsx",
  "pages/focus/FocusPage.tsx",
  "pages/pain/PainPage.tsx",
  "pages/principles/PrinciplesPage.tsx",
  "pages/debt/DebtPage.tsx",
  "pages/failed-tasks/FailedTasksPage.tsx",
];

describe("daily-path pages keep a real heading", () => {
  for (const relPath of PAGES_WITH_TITLE) {
    it(`${relPath} renders an <h1>`, () => {
      expect(readSrc(relPath)).toMatch(/<h1\b/);
    });
  }
});

describe("decorative loops are gone", () => {
  it("ShinyText component is removed", () => {
    expect(existsSync(join(SRC_ROOT, "components/ui/shiny-text.tsx"))).toBe(false);
  });

  it("no page imports or uses ShinyText", () => {
    for (const relPath of PAGES_WITH_TITLE) {
      const source = readSrc(relPath);
      expect(source, relPath).not.toMatch(/ShinyText/);
    }
  });

  it("globals.css declares no infinite animation", () => {
    const css = readSrc("styles/globals.css");
    // `animation-iteration-count: 1` inside the reduced-motion override is the
    // only mention of iteration count that is allowed.
    expect(css).not.toMatch(/animation:[^;]*infinite/);
    expect(css).not.toMatch(/@keyframes shimmer/);
    expect(css).not.toMatch(/\.breathing-dot/);
  });

  it("Skeleton does not pulse", () => {
    expect(readSrc("components/ui/skeleton.tsx")).not.toMatch(/animate-pulse/);
  });
});
