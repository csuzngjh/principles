/**
 * IntentPage FlagControlCard — source-code contract test
 *
 * PRI-1236 / SPEC-PD-INTENT-UNIFICATION-001 §10.4: the single
 * intent_engineering switch supports BOTH directions through the existing
 * PATCH API + patchFeatureFlag(). Disable requires an explicit confirmation
 * dialog listing what stops and what is preserved.
 *
 * Also covers PRI-1235 (§11.3 six-state hero / §11.4 section-state chips /
 * §11.7 usage card) and the flag-off enable card that replaced the retired
 * FlagDisabledBanner (spec 2026-06-27 §13.5).
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

describe("IntentPage: FlagControlCard (PRI-1236, bidirectional switch)", () => {
  const source = readSrc("pages/intent/IntentPage.tsx");

  it("defines the FlagControlCard component", () => {
    expect(source).toContain("FlagControlCard");
  });

  it("removes the old FlagDisabledBanner function", () => {
    expect(source).not.toMatch(/function\s+FlagDisabledBanner\s*\(/);
  });

  it("imports patchFeatureFlag from api.js (the ONLY switch API — no second endpoint)", () => {
    expect(source).toContain("patchFeatureFlag");
    expect(source).not.toMatch(/fetch\(['"]\/api\/config\/features/);
  });

  it("enable path calls the flag with intent_engineering true", () => {
    expect(source).toContain('patchFeatureFlag("intent_engineering", enabled)');
    expect(source).toContain('await applyFlag(true)');
  });

  it("disable path calls the flag with intent_engineering FALSE (§10.4 双向)", () => {
    expect(source).toContain('await applyFlag(false)');
  });

  it("disable requires a confirmation dialog before any PATCH (Radix AlertDialog — focus trap / Escape / focus restore)", () => {
    expect(source).toContain("showDisableConfirm");
    // PR #2684 P2: the dialog uses the project's Radix AlertDialog component
    // (focus trap, background inert, Escape and focus restoration are
    // provided by the primitive), NOT a hand-rolled overlay div.
    expect(source).toContain("AlertDialog");
    expect(source).toMatch(/<AlertDialog\s+open=\{showDisableConfirm\}/);
    expect(source).not.toMatch(/role="alertdialog"/); // no hand-rolled overlay
  });

  it("Cancel takes initial focus and the action keeps the dialog open until the PATCH succeeds", () => {
    expect(source).toContain("data-autofocus");
    expect(source).toMatch(/AlertDialogCancel\s+data-testid="intent-disable-cancel"/);
    expect(source).toMatch(/e\.preventDefault\(\);/);
  });

  it("the confirmation lists all eight effects (stops 1-4, preserves 5-8)", () => {
    expect(source).toContain("disableEffect${n}");
    expect(source).toContain("[1, 2, 3, 4, 5, 6, 7, 8].map");
  });

  it("cancel closes the dialog without touching the configuration (focus restored to trigger)", () => {
    expect(source).toMatch(/onClick=\{\(\) => closeDialog\(\)\}/);
    expect(source).toMatch(/triggerRef\.current\?\.focus\(\)/);
  });

  it("a failed switch surfaces an error toast — never a fake success", () => {
    expect(source).toContain("toast.error");
    expect(source).toContain("flagControl.disableFailed");
  });

  it("after any switch the parent re-fetches the persisted summary", () => {
    expect(source).toContain("onAfterChange");
    expect(source).toMatch(/onAfterChange=\{\(\) => void loadData\(\)\}/);
  });

  it("uses the amber left-border visual style for the flag-off card", () => {
    expect(source).toContain("border-l-amber");
    expect(source).toContain("border-amber/20");
  });
});

describe("IntentPage: six-state hero + section states (PRI-1235, SPEC §11.3/§11.4/§11.7)", () => {
  const source = readSrc("pages/intent/IntentPage.tsx");

  it("derives the UI state with the strict priority Disabled → Error → Missing → readiness", () => {
    expect(source).toContain("deriveIntentUiState");
    expect(source).toMatch(/if \(!summary\.flagEnabled\) return 'disabled'/);
    // Missing is keyed off reason not_found — NEVER off contentReadiness.
    expect(source).toMatch(/summary\.reason === 'not_found'\) return 'missing'/);
  });

  it("renders the state hero with a data-intent-state attribute for e2e assertions", () => {
    expect(source).toContain("data-intent-state={state}");
  });

  it("shows the usable section count (N / 5) from the SERVER projection", () => {
    expect(source).toContain("status.sectionCount");
    expect(source).toContain("usableSectionCount");
  });

  it("renders per-section state chips from the server sectionStates (no client template matching)", () => {
    expect(source).toContain("SectionStateChip");
    expect(source).toContain("summary.sectionStates?.[key]");
    expect(source).not.toMatch(/classifyIntentSectionContent/);
  });

  it("renders the usage explanation card with the not-a-RuleCode disclaimer (§11.7)", () => {
    expect(source).toContain("UsageCard");
    expect(source).toContain("usage.note");
  });

  it("wizard finish summary classifies with the SAME Core function as the server (PR #2684 review)", () => {
    const wizard = readSrc("pages/intent/IntentOnboarding.tsx");
    // The wizard imports the classifier from the browser-safe subpath.
    expect(wizard).toContain("classifyIntentSectionContent");
    expect(wizard).toContain('from "@principles/core/runtime/intent-browser"');
    // Three-state finish summary: template text / TODO noise is NOT labelled
    // 已填写 — it shows 模板占位, matching the post-save sectionStates exactly.
    expect(wizard).toContain("classifyIntentSectionContent(key, value, lang).state");
    expect(wizard).toContain("sectionStates.${state}"); // 3-state label key
    expect(wizard).toContain("state === 'placeholder'");
    // The old binary non-empty check is gone.
    expect(wizard).not.toMatch(/const filled = value\.trim\(\)\.length > 0/);
    // The modal receives the language it will save into.
    expect(wizard).toMatch(/OnboardingModal\(\{ onComplete, onSkip, onClose, lang \}/);
    expect(wizard).toMatch(/lang=\{lang\}/);
  });

  it("keeps Decision Summary, Version History, editor, warnings, meta, edit entry", () => {
    expect(source).toContain("DecisionSummarySection");
    expect(source).toContain("VersionEntry");
    expect(source).toContain("IntentEditor");
    expect(source).toContain("WarningItem");
    expect(source).toContain("MetaRow");
    expect(source).toContain("EditEntry");
  });
});

describe("IntentPage i18n: status / usage / flagControl keys exist in BOTH languages (PRI-1235/1236)", () => {
  const zh = JSON.parse(readSrc("i18n/zh-CN.json"));
  const en = JSON.parse(readSrc("i18n/en.json"));

  const requiredPaths = [
    ["pages", "intent", "status", "disabled"],
    ["pages", "intent", "status", "missing"],
    ["pages", "intent", "status", "templateOnly"],
    ["pages", "intent", "status", "incomplete"],
    ["pages", "intent", "status", "configured"],
    ["pages", "intent", "status", "error"],
    ["pages", "intent", "status", "sectionCount"],
    ["pages", "intent", "sectionStates", "authored"],
    ["pages", "intent", "sectionStates", "placeholder"],
    ["pages", "intent", "sectionStates", "missing"],
    ["pages", "intent", "usage", "title"],
    ["pages", "intent", "usage", "line1"],
    ["pages", "intent", "usage", "line5"],
    ["pages", "intent", "usage", "note"],
    ["pages", "intent", "flagControl", "enable"],
    ["pages", "intent", "flagControl", "disable"],
    ["pages", "intent", "flagControl", "disableConfirmTitle"],
    ["pages", "intent", "flagControl", "disableEffect1"],
    ["pages", "intent", "flagControl", "disableEffect8"],
    ["pages", "intent", "flagControl", "disableConfirmCancel"],
    ["pages", "intent", "flagControl", "disableConfirmConfirm"],
    ["pages", "intent", "flagControl", "disableFailed"],
  ] as const;

  it("zh-CN has every required key", () => {
    for (const pathSegments of requiredPaths) {
      let node: unknown = zh;
      for (const segment of pathSegments) {
        expect(node, pathSegments.join(".")).not.toBeNull();
        expect(typeof node).toBe("object");
        node = (node as Record<string, unknown>)[segment];
      }
      expect(typeof node, pathSegments.join(".")).toBe("string");
      expect((node as string).length, pathSegments.join(".")).toBeGreaterThan(0);
    }
  });

  it("en has every required key", () => {
    for (const pathSegments of requiredPaths) {
      let node: unknown = en;
      for (const segment of pathSegments) {
        expect(node, pathSegments.join(".")).not.toBeNull();
        expect(typeof node).toBe("object");
        node = (node as Record<string, unknown>)[segment];
      }
      expect(typeof node, pathSegments.join(".")).toBe("string");
      expect((node as string).length, pathSegments.join(".")).toBeGreaterThan(0);
    }
  });

  it("sectionCount interpolation uses {{count}} in both languages", () => {
    expect(zh.pages.intent.status.sectionCount).toContain("{{count}}");
    expect(en.pages.intent.status.sectionCount).toContain("{{count}}");
  });

  it("keeps flagStatus.enable / enabling / enableFailed for the enable path", () => {
    expect(zh.pages.intent.flagStatus.enable).toBeDefined();
    expect(zh.pages.intent.flagStatus.enabling).toBeDefined();
    expect(zh.pages.intent.flagStatus.enableFailed).toBeDefined();
    expect(en.pages.intent.flagStatus.enable).toBeDefined();
    expect(en.pages.intent.flagStatus.enabling).toBeDefined();
    expect(en.pages.intent.flagStatus.enableFailed).toBeDefined();
  });
});
