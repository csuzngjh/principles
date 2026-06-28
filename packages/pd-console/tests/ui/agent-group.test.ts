/**
 * AgentGroup — source-code contract test
 *
 * Verifies the dependency-group container:
 * - Renders group header (name + tag + hint)
 * - Applies distinct tag styles per GroupTag (must/recommend/optional/independent)
 * - Renders AgentCard for each agent
 * - rc-2/rc-5: uses isKnownAgentName type guard (internally Object.hasOwn) for agent metadata lookup
 * - rc-9: empty agents array shows fallback (not silent)
 * - Brand constraints (no translate-y/scale hover, no hex colors)
 *
 * Spec: .trae/documents/control-center-agent-redesign.md (步骤 6)
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

describe("AgentGroup: source-code contract", () => {
  const source = readSrc("pages/control-center/AgentGroup.tsx");

  it("exports AgentGroup function", () => {
    expect(source).toMatch(/export\s+function\s+AgentGroup/);
  });

  it("renders group header with groupName, groupTagLabel, groupHint", () => {
    expect(source).toContain("groupName");
    expect(source).toContain("groupTagLabel");
    expect(source).toContain("groupHint");
  });

  it("applies must tag style with bg-danger/10 + text-danger", () => {
    expect(source).toContain("bg-danger/10");
    expect(source).toContain("text-danger");
  });

  it("applies recommend tag style with bg-amber/10 + text-amber", () => {
    expect(source).toContain("bg-amber/10");
    expect(source).toContain("text-amber");
  });

  it("applies optional tag style with bg-paper-2", () => {
    expect(source).toContain("bg-paper-2");
  });

  it("applies independent tag style with bg-green/10 + text-green", () => {
    expect(source).toContain("bg-green/10");
    expect(source).toContain("text-green");
  });

  it("imports and renders AgentCard for each agent", () => {
    expect(source).toMatch(/import\s+.*AgentCard.*from/);
    expect(source).toContain("agents.map");
  });

  it("has empty state fallback (rc-9: no silent fallback)", () => {
    expect(source).toMatch(/agents\.length\s*===\s*0/);
  });

  it("uses isKnownAgentName type guard for agent metadata lookup (rc-2/rc-5)", () => {
    // isKnownAgentName 内部用 Object.hasOwn（rc-5），表层用类型守卫缩窄（rc-2，不用 as）
    expect(source).toMatch(/import\s+.*isKnownAgentName.*from/);
    expect(source).toContain("isKnownAgentName(agent.name)");
  });

  it("does not use forbidden translate-y-* or scale-* hover effects (PRI-CR1 B.4.4)", () => {
    expect(source).not.toMatch(/translate-y-/);
    expect(source).not.toMatch(/scale-/);
  });

  it("does not use hardcoded hex color values (must use design tokens)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
