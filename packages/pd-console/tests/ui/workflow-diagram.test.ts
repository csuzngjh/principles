/**
 * WorkflowDiagram — source-code contract test
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components. Instead we verify the source-code contract: the component
 * renders the 4-phase behavior loop diagram with Phase 03 (Owner review)
 * highlighted, uses i18n keys, and follows brand constraints.
 *
 * Spec: .trae/documents/control-center-agent-redesign.md (步骤 4)
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

describe("WorkflowDiagram: source-code contract", () => {
  const source = readSrc("pages/control-center/WorkflowDiagram.tsx");

  it("exports WorkflowDiagram function", () => {
    expect(source).toMatch(/export\s+function\s+WorkflowDiagram/);
  });

  it("references all 4 phase i18n keys (phase01-04)", () => {
    expect(source).toContain("workflow.phase01");
    expect(source).toContain("workflow.phase02");
    expect(source).toContain("workflow.phase03");
    expect(source).toContain("workflow.phase04");
  });

  it("references all 4 phase description i18n keys", () => {
    expect(source).toContain("workflow.phase01Desc");
    expect(source).toContain("workflow.phase02Desc");
    expect(source).toContain("workflow.phase03Desc");
    expect(source).toContain("workflow.phase04Desc");
  });

  it("references workflow.title, workflow.subtitle, workflow.loopHint", () => {
    expect(source).toContain("workflow.title");
    expect(source).toContain("workflow.subtitle");
    expect(source).toContain("workflow.loopHint");
  });

  it("highlights Phase 03 (Owner review) with border-dashed + border-gov + bg-gov/10", () => {
    expect(source).toContain("border-dashed");
    expect(source).toContain("border-gov");
    expect(source).toContain("bg-gov/10");
  });

  it("uses lucide-react ChevronRight and RefreshCw icons", () => {
    expect(source).toMatch(/import\s+.*ChevronRight.*from\s+["']lucide-react["']/);
    expect(source).toMatch(/import\s+.*RefreshCw.*from\s+["']lucide-react["']/);
  });

  it("does not use forbidden translate-y-* or scale-* hover effects (PRI-CR1 B.4.4)", () => {
    expect(source).not.toMatch(/translate-y-/);
    expect(source).not.toMatch(/scale-/);
  });

  it("does not use hardcoded hex color values (must use design tokens)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
