/**
 * EmpathyObserverCostHint — source-code contract test
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components. Instead we verify the source-code contract: the component
 * implements the spec §4 requirements (localStorage gate, provider/model
 * fallback, i18n keys, dismiss behavior).
 *
 * Spec: docs/superpowers/specs/2026-06-27-empathy-observer-cost-hint.md
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

describe("EmpathyObserverCostHint: source-code contract (spec §4)", () => {
  const source = readSrc("pages/control-center/EmpathyObserverCostHint.tsx");

  it("uses the correct localStorage ack key (spec §4.4)", () => {
    expect(source).toContain("pd.empathyObserver.costAck");
  });

  it("resolves provider/model from the agent's runtime profile (spec §4.5)", () => {
    expect(source).toContain("profiles.find");
    expect(source).toContain("agent.runtimeProfileId");
  });

  it("falls back to '—' when provider/model are unavailable (spec §4.5)", () => {
    expect(source).toContain('"—"');
    expect(source).toMatch(/provider\s*\?\?\s*["']—["']/);
    expect(source).toMatch(/model\s*\?\?\s*["']—["']/);
  });

  it("uses i18n keys for all user-facing text (spec §4.3, EP-11)", () => {
    expect(source).toContain("empathyCostHint.body");
    expect(source).toContain("empathyCostHint.muted");
    expect(source).toContain("empathyCostHint.ack");
  });

  it("passes provider/model as interpolation params to body (spec §4.3)", () => {
    expect(source).toMatch(/\{\s*provider\s*,\s*model\s*,?\s*\}/);
  });

  it("implements the dismiss button with localStorage write (spec §4.4)", () => {
    expect(source).toContain("setItem");
    expect(source).toContain("setVisible(false)");
  });

  it("wraps localStorage access in try/catch (fail-open, spec §4.4/§5)", () => {
    // Both read (init) and write (ack) must be wrapped
    expect(source).toMatch(/try\s*\{[^}]*localStorage\.getItem/);
    expect(source).toMatch(/try\s*\{[^}]*localStorage\.setItem/);
  });

  it("returns null when not visible (spec §4.5)", () => {
    expect(source).toMatch(/if\s*\(\s*!visible\s*\)\s*return\s*null/);
  });

  it("uses the amber left-border warning visual (spec §4.2)", () => {
    expect(source).toContain("border-l-amber");
    expect(source).toContain("border-amber/20");
  });

  it("uses the AgentRow toggle button style for the ack button (spec §4.2)", () => {
    expect(source).toContain("border-gov");
    expect(source).toContain("bg-gov");
    expect(source).toContain("text-paper");
  });

  it("uses enumLabel with featureId 'empathy_observer' for display (spec §4.1)", () => {
    expect(source).toContain("enumLabel");
    // Accept either single or double quotes (formatter may normalize)
    expect(source).toMatch(/["']empathy_observer["']/);
  });
});

describe("ControlCenterPage: EmpathyObserverCostHint wiring (spec §4.1)", () => {
  const source = readSrc("pages/control-center/ControlCenterPage.tsx");

  it("imports EmpathyObserverCostHint", () => {
    expect(source).toContain("EmpathyObserverCostHint");
  });

  it("finds the agent by correct name 'empathyObserver' (camelCase, per INTERNAL_AGENT_NAMES)", () => {
    // The spec §4.1 wrote 'empathy_observer' but the actual agent name in
    // INTERNAL_AGENT_NAMES is 'empathyObserver'. The implementation must
    // use the real agent name.
    expect(source).toContain("'empathyObserver'");
  });

  it("checks enabled flag on the empathy agent (spec §4.1 Gate 1)", () => {
    expect(source).toMatch(/a\.name\s*===\s*['"]empathyObserver['"]\s*&&\s*a\.enabled/);
  });

  it("checks localStorage ack in the parent gate (spec §4.1 Gate 1)", () => {
    expect(source).toContain("pd.empathyObserver.costAck");
  });

  it("renders EmpathyObserverCostHint between Section 1 and Section 2", () => {
    // The hint should appear after OverallStatusCard and before Internal Agents
    const hintIdx = source.indexOf("EmpathyObserverCostHint");
    const section2Idx = source.indexOf("Section 2: Internal Agents");
    expect(hintIdx).toBeGreaterThan(-1);
    expect(section2Idx).toBeGreaterThan(hintIdx);
  });

  it("page-level validator extracts provider/model (EP-01)", () => {
    // The validateRedactedRuntimeProfileSummary in ControlCenterPage must
    // pass through provider and model so the hint can read them
    expect(source).toMatch(/Object\.hasOwn\(raw,\s*["']provider["']\)/);
    expect(source).toMatch(/Object\.hasOwn\(raw,\s*["']model["']\)/);
  });
});
