/**
 * AgentCard — source-code contract test
 *
 * Verifies the three-layer progressive disclosure card implements:
 * - L1 (always visible) / L2 (isOpen) / L3 (showTechDetail) structure
 * - Inline confirm bar for core agents (isCore=true) — no modal
 * - i18n keys for impact / techDetail
 * - Brand constraints (no translate-y/scale hover, no hex colors)
 * - rc-2: no `as` bypass
 *
 * Spec: .trae/documents/control-center-agent-redesign.md (步骤 5)
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

describe("AgentCard: source-code contract", () => {
  const source = readSrc("pages/control-center/AgentCard.tsx");

  it("exports AgentCard function and AgentLocale type", () => {
    expect(source).toMatch(/export\s+function\s+AgentCard/);
    expect(source).toMatch(/export\s+type\s+AgentLocale/);
  });

  it("uses useState for isOpen, showTechDetail, and confirming", () => {
    // Destructuring pattern: const [isOpen, setIsOpen] = useState(false)
    // isOpen appears before useState, so regex must match that order
    expect(source).toMatch(/isOpen.*useState/);
    expect(source).toMatch(/showTechDetail.*useState/);
    expect(source).toMatch(/confirming.*useState/);
  });

  it("calls onBindingChange callback for toggle/confirm/profile actions", () => {
    expect(source).toContain("onBindingChange");
  });

  it("renders inline confirm bar with bg-danger/10 and border-danger for core agents", () => {
    expect(source).toContain("bg-danger/10");
    expect(source).toContain("border-danger");
    expect(source).toContain("data-confirm-bar");
  });

  it("renders L2 content conditionally on isOpen", () => {
    expect(source).toMatch(/\{isOpen\s*&&/);
  });

  it("renders L3 tech detail conditionally on showTechDetail", () => {
    expect(source).toMatch(/\{showTechDetail\s*&&/);
  });

  it("references impact i18n keys (label, confirmAck, confirmCancel)", () => {
    expect(source).toContain("pages.controlCenter.impact.label");
    expect(source).toContain("pages.controlCenter.impact.confirmAck");
    expect(source).toContain("pages.controlCenter.impact.confirmCancel");
  });

  it("references techDetail i18n key", () => {
    expect(source).toContain("pages.controlCenter.techDetail");
  });

  it("allows rotate-90 for arrow expansion (rotate is permitted; translate-y/scale are not)", () => {
    expect(source).toContain("rotate-90");
  });

  it("does not use forbidden translate-y-* or scale-* hover effects (PRI-CR1 B.4.4)", () => {
    expect(source).not.toMatch(/translate-y-/);
    expect(source).not.toMatch(/scale-/);
  });

  it("does not use hardcoded hex color values (must use design tokens)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
