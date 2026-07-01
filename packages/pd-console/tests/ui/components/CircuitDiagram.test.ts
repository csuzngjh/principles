/**
 * Source-contract test for CircuitDiagram component (Task 12).
 *
 * The vitest config uses 'node' environment (no jsdom), so we cannot mount
 * React components with @testing-library/react. Instead we verify the
 * source-code contract — mirroring the pattern in loading-a11y.test.ts.
 *
 * This guards against accidental regressions in:
 *  - i18n string routing (EP-11: every user-facing string via t())
 *  - brand charter (thin lines strokeWidth 1.5, Owner Gate emphasis 2.5,
 *    no neon/gradient, ≤6 nodes)
 *  - 4-node governance loop shape (Evidence → Principle → Owner Gate → Behavior)
 *  - highlightNode / compact prop contracts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui/components
// SRC_ROOT  = packages/pd-console/src/ui
const SRC_ROOT = join(__dirname, "..", "..", "..", "src", "ui");

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), "utf-8");
}

const COMPONENT_SOURCE = readSrc("components/onboarding/CircuitDiagram.tsx");

describe("CircuitDiagram: i18n string routing (EP-11)", () => {
  it("routes the aria-label through t() with the circuitLabel key", () => {
    expect(COMPONENT_SOURCE).toContain(
      "aria-label={t('pages.welcome.step1.circuitLabel')}",
    );
  });

  it("defines all 4 node labels as i18n keys (no hardcoded strings)", () => {
    const expectedKeys = [
      "pages.welcome.step1.circuitNodes.evidence",
      "pages.welcome.step1.circuitNodes.principle",
      "pages.welcome.step1.circuitNodes.ownerGate",
      "pages.welcome.step1.circuitNodes.behavior",
    ];
    for (const key of expectedKeys) {
      expect(COMPONENT_SOURCE, `missing i18n key ${key}`).toContain(key);
    }
  });

  it("renders node text via t(node.labelKey), not a hardcoded literal", () => {
    expect(COMPONENT_SOURCE).toContain("{t(node.labelKey)}");
  });
});

describe("CircuitDiagram: i18n keys exist in both locale files (EP-11)", () => {
  const en = JSON.parse(readSrc("i18n/en.json")) as Record<string, unknown>;
  const zh = JSON.parse(readSrc("i18n/zh-CN.json")) as Record<string, unknown>;

  // pages.welcome.step1.circuitLabel + circuitNodes.{evidence,principle,ownerGate,behavior}
  const requiredKeys = [
    "circuitLabel",
    "circuitNodes.evidence",
    "circuitNodes.principle",
    "circuitNodes.ownerGate",
    "circuitNodes.behavior",
  ];

  for (const key of requiredKeys) {
    it(`en.json has pages.welcome.step1.${key}`, () => {
      const step1 = (en as { pages: { welcome: { step1: Record<string, unknown> } } }).pages.welcome.step1;
      const parts = key.split(".");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let node: any = step1;
      for (const p of parts) node = node[p];
      expect(typeof node, `en.json missing pages.welcome.step1.${key}`).toBe("string");
      expect((node as string).length).toBeGreaterThan(0);
    });

    it(`zh-CN.json has pages.welcome.step1.${key}`, () => {
      const step1 = (zh as { pages: { welcome: { step1: Record<string, unknown> } } }).pages.welcome.step1;
      const parts = key.split(".");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let node: any = step1;
      for (const p of parts) node = node[p];
      expect(typeof node, `zh-CN.json missing pages.welcome.step1.${key}`).toBe("string");
      expect((node as string).length).toBeGreaterThan(0);
    });
  }
});

describe("CircuitDiagram: 4-node governance loop shape", () => {
  it("defines exactly 4 nodes (Evidence, Principle, Owner Gate, Behavior)", () => {
    const nodeIds = ["evidence", "principle", "ownerGate", "behavior"];
    for (const id of nodeIds) {
      expect(COMPONENT_SOURCE, `missing node ${id}`).toContain(`id: '${id}'`);
    }
  });

  it("renders one <circle> per node inside the NODES.map() callback", () => {
    // The source has a single <circle> JSX tag inside NODES.map(); combined
    // with the 4-entry NODES array (verified above), this yields 4 circles at
    // runtime. A source-contract test cannot count runtime DOM nodes.
    const circleMatches = COMPONENT_SOURCE.match(/<circle\b/g) ?? [];
    expect(circleMatches.length).toBe(1);
    expect(COMPONENT_SOURCE).toContain("NODES.map");
  });

  it("renders exactly 4 connecting <line> elements (thin, brand-aligned)", () => {
    const lineMatches = COMPONENT_SOURCE.match(/<line\b/g) ?? [];
    expect(lineMatches.length).toBe(4);
  });

  it("renders exactly 4 arrow <polygon> markers (directional loop)", () => {
    const polygonMatches = COMPONENT_SOURCE.match(/<polygon\b/g) ?? [];
    expect(polygonMatches.length).toBe(4);
  });
});

describe("CircuitDiagram: brand charter compliance", () => {
  it("uses thin lines (strokeWidth 1.5) for connecting lines", () => {
    // All 4 connecting lines share strokeWidth="1.5"
    const lineStrokeMatches =
      COMPONENT_SOURCE.match(/stroke="var\(--accent\)" strokeWidth="1\.5"/g) ?? [];
    expect(lineStrokeMatches.length).toBe(4);
  });

  it("emphasizes Owner Gate with thicker border (strokeWidth 2.5)", () => {
    // Owner Gate is the only node with strokeWidth 2.5
    expect(COMPONENT_SOURCE).toContain("strokeWidth={isOwnerGate ? 2.5 : 1.5}");
  });

  it("does not use neon/gradient/glow effects", () => {
    expect(COMPONENT_SOURCE).not.toMatch(/gradient|neon|glow|filter=/i);
  });

  it("uses brand CSS variables for fill/stroke, not raw colors", () => {
    expect(COMPONENT_SOURCE).toContain("var(--accent)");
    expect(COMPONENT_SOURCE).toContain("var(--surface)");
    expect(COMPONENT_SOURCE).toContain("var(--border)");
    expect(COMPONENT_SOURCE).toContain("var(--text-main)");
  });
});

describe("CircuitDiagram: prop contracts", () => {
  it("accepts highlightNode prop with all 4 node ids in the union type", () => {
    expect(COMPONENT_SOURCE).toContain(
      "highlightNode?: 'evidence' | 'principle' | 'ownerGate' | 'behavior' | null",
    );
  });

  it("drives node fill from highlightNode (accent when highlighted)", () => {
    expect(COMPONENT_SOURCE).toContain(
      "fill={isHighlighted ? 'var(--accent)' : 'var(--surface)'}",
    );
  });

  it("accepts compact prop and adjusts nodeRadius + size", () => {
    expect(COMPONENT_SOURCE).toContain("compact?: boolean");
    expect(COMPONENT_SOURCE).toContain("const size = compact ? 240 : 320");
    expect(COMPONENT_SOURCE).toContain("const nodeRadius = compact ? 28 : 36");
  });
});
