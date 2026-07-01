/**
 * Source-contract test for DemoResultView component (Task 13).
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components with @testing-library/react. Instead we verify the
 * source-code contract — mirroring the pattern in CircuitDiagram.test.ts.
 *
 * This guards against accidental regressions in:
 *  - i18n string routing (EP-11: every user-facing string via t())
 *  - accessibility roles (loading=status/alert, simulated=note)
 *  - demo result rendering shape (stages as <ol>, narrative, labels)
 *  - prop contract (result/loading/error)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getNestedRecord, getNestedString, parseJsonRecord } from "../i18n-test-helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/components
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, "..", "..", "..", "src", "ui");

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), "utf-8");
}

const COMPONENT_SOURCE = readSrc("components/onboarding/DemoResultView.tsx");

describe("DemoResultView: i18n string routing (EP-11)", () => {
  it("routes all user-visible text through t() with the step2 i18n keys", () => {
    const expectedKeys = [
      "pages.welcome.step2.demoRunning",
      "pages.welcome.step2.demoFailed",
      "pages.welcome.step2.demoComplete",
      "pages.welcome.step2.demoSimulatedNote",
      "pages.welcome.step2.evidenceLabel",
      "pages.welcome.step2.candidateLabel",
      "pages.welcome.step2.ownerGateLabel",
      "pages.welcome.step2.activationLabel",
      "pages.welcome.step2.rollbackLabel",
    ];
    for (const key of expectedKeys) {
      expect(COMPONENT_SOURCE, `missing t('${key}')`).toContain(`t('${key}')`);
    }
  });
});

describe("DemoResultView: i18n keys exist in both locale files (EP-11)", () => {
  const en = getNestedRecord(parseJsonRecord(readSrc("i18n/en.json")), ["pages", "welcome", "step2"]);
  const zh = getNestedRecord(parseJsonRecord(readSrc("i18n/zh-CN.json")), ["pages", "welcome", "step2"]);

  const keysToCheck = [
    "demoRunning",
    "demoFailed",
    "demoComplete",
    "demoSimulatedNote",
    "evidenceLabel",
    "candidateLabel",
    "ownerGateLabel",
    "activationLabel",
    "rollbackLabel",
  ];

  for (const key of keysToCheck) {
    it(`en.json has pages.welcome.step2.${key}`, () => {
      expect(getNestedString(en, [key]).length).toBeGreaterThan(0);
    });

    it(`zh-CN.json has pages.welcome.step2.${key}`, () => {
      expect(getNestedString(zh, [key]).length).toBeGreaterThan(0);
    });
  }
});

describe("DemoResultView: accessibility roles", () => {
  it("uses role=status with aria-live=polite for the loading state", () => {
    expect(COMPONENT_SOURCE).toContain('role="status"');
    expect(COMPONENT_SOURCE).toContain('aria-live="polite"');
  });

  it("uses role=alert for the error state", () => {
    expect(COMPONENT_SOURCE).toContain('role="alert"');
  });

  it("uses role=note for the simulated-evidence banner", () => {
    expect(COMPONENT_SOURCE).toContain('role="note"');
  });

  it("gates the simulated banner on result.simulated", () => {
    expect(COMPONENT_SOURCE).toContain("result.simulated");
  });
});

describe("DemoResultView: demo result rendering shape", () => {
  it("renders stages as an ordered list (<ol>)", () => {
    expect(COMPONENT_SOURCE).toContain("<ol");
    expect(COMPONENT_SOURCE).toContain("demo-stages");
  });

  it("does not expose the raw technical narrative to first-time users", () => {
    expect(COMPONENT_SOURCE).not.toContain("result.narrative");
  });
});

describe("DemoResultView: prop contract", () => {
  it("accepts result/loading/error props", () => {
    expect(COMPONENT_SOURCE).toContain("result:");
    expect(COMPONENT_SOURCE).toContain("loading:");
    expect(COMPONENT_SOURCE).toContain("error:");
  });
});
