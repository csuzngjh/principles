/**
 * IntentPage FlagToggleCard — source-code contract test
 *
 * Verifies that FlagDisabledBanner was replaced with interactive FlagToggleCard
 * (spec §13.5): the static "edit yaml" nextAction is gone, the new toggle
 * calls patchFeatureFlag, and i18n keys are wired correctly.
 *
 * Spec: docs/superpowers/specs/2026-06-27-empathy-observer-cost-hint.md §13
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..", "..", "src", "ui");

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), "utf-8");
}

describe("IntentPage: FlagToggleCard replaces FlagDisabledBanner (spec §13.5)", () => {
  const source = readSrc("pages/intent/IntentPage.tsx");

  it("defines FlagToggleCard component", () => {
    expect(source).toContain("FlagToggleCard");
  });

  it("removes the old FlagDisabledBanner function", () => {
    expect(source).not.toMatch(/function\s+FlagDisabledBanner\s*\(/);
  });

  it("does not reference the deleted flagDisabled.nextAction i18n key (spec §13.5)", () => {
    // The nextAction key was deleted from i18n and the rendering div must be gone
    expect(source).not.toContain("flagDisabled.nextAction");
  });

  it("imports patchFeatureFlag from api.js", () => {
    expect(source).toContain("patchFeatureFlag");
  });

  it("imports toast from sonner for error feedback", () => {
    expect(source).toMatch(/import\s*\{[^}]*toast[^}]*\}\s*from\s*["']sonner["']/);
  });

  it("FlagToggleCard calls patchFeatureFlag with intent_engineering on click", () => {
    expect(source).toContain('patchFeatureFlag("intent_engineering", true)');
  });

  it("FlagToggleCard uses the flagStatus.enable i18n key for the button label", () => {
    expect(source).toContain("flagStatus.enable");
  });

  it("FlagToggleCard uses the flagStatus.enabling i18n key for the busy state", () => {
    expect(source).toContain("flagStatus.enabling");
  });

  it("FlagToggleCard uses the flagStatus.enableFailed i18n key for error toast", () => {
    expect(source).toContain("flagStatus.enableFailed");
  });

  it("FlagToggleCard only renders when flagEnabled is false (spec §13.5)", () => {
    expect(source).toMatch(/if\s*\(\s*flagEnabled\s*\|\|\s*acknowledged\s*\)\s*return\s*null/);
  });

  it("FlagToggleCard passes onAfterEnable to trigger parent re-fetch (spec §13.5)", () => {
    expect(source).toContain("onAfterEnable");
    // The parent must pass loadData as onAfterEnable
    expect(source).toMatch(/onAfterEnable=\{loadData\}/);
  });

  it("uses the amber left-border visual style for the toggle card", () => {
    expect(source).toContain("border-l-amber");
    expect(source).toContain("border-amber/20");
  });
});

describe("IntentPage i18n: flagStatus keys updated (spec §13.5)", () => {
  const zhSource = readSrc("i18n/zh-CN.json");
  const enSource = readSrc("i18n/en.json");

  it("zh-CN has flagStatus.enable / enabling / enableFailed", () => {
    expect(zhSource).toContain('"enable"');
    expect(zhSource).toContain('"enabling"');
    expect(zhSource).toContain('"enableFailed"');
  });

  it("en has flagStatus.enable / enabling / enableFailed", () => {
    expect(enSource).toContain('"enable"');
    expect(enSource).toContain('"enabling"');
    expect(enSource).toContain('"enableFailed"');
  });

  it("zh-CN no longer has flagDisabled.nextAction (but keeps notFound/oversized nextAction)", () => {
    // Only flagDisabled.nextAction was deleted; notFound.nextAction and
    // oversized.nextAction must remain.
    expect(zhSource).not.toMatch(/flagDisabled[^}]*nextAction/);
    expect(zhSource).toContain("notFound");
    expect(zhSource).toContain('"nextAction"');
  });

  it("en no longer has flagDisabled.nextAction (but keeps notFound/oversized nextAction)", () => {
    expect(enSource).not.toMatch(/flagDisabled[^}]*nextAction/);
    expect(enSource).toContain("notFound");
    expect(enSource).toContain('"nextAction"');
  });
});
