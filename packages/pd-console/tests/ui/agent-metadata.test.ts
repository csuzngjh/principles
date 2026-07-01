/**
 * agent-metadata — runtime contract test
 *
 * Pure data module (no React, no I/O), so we can import it directly and
 * assert on the runtime values. Verifies:
 * - AGENT_METADATA covers all 9 internal agent names
 * - AGENT_GROUPS has 4 groups matching GROUP_ORDER
 * - Each agent has non-empty bilingual fields
 * - isCore / group / impactLevel assignments match the design spec
 */

import { describe, it, expect } from "vitest";
import {
  AGENT_METADATA,
  AGENT_GROUPS,
  GROUP_ORDER,
} from "../../src/ui/utils/agent-metadata.js";

const EXPECTED_AGENT_NAMES = [
  "diagnostician",
  "dreamer",
  "scribe",
  "artificer",
  "evaluator",
  "philosopher",
  "rolloutReviewer",
  "correctionObserver",
  "empathyObserver",
  "signalCollector",
] as const;

const EXPECTED_GROUP_IDS = [
  "core_trio",
  "code_chain",
  "quality_polish",
  "sidechain",
] as const;

describe("AGENT_METADATA: coverage", () => {
  it("covers all 10 internal agent names", () => {
    for (const name of EXPECTED_AGENT_NAMES) {
      expect(Object.hasOwn(AGENT_METADATA, name)).toBe(true);
    }
    expect(Object.keys(AGENT_METADATA)).toHaveLength(10);
  });

  it("each agent has non-empty bilingual display name, role, detail, impact", () => {
    for (const name of EXPECTED_AGENT_NAMES) {
      const meta = AGENT_METADATA[name];
      expect(meta.displayNameZh.length).toBeGreaterThan(0);
      expect(meta.displayNameEn.length).toBeGreaterThan(0);
      expect(meta.roleZh.length).toBeGreaterThan(0);
      expect(meta.roleEn.length).toBeGreaterThan(0);
      expect(meta.detailZh.length).toBeGreaterThan(0);
      expect(meta.detailEn.length).toBeGreaterThan(0);
      expect(meta.impactZh.length).toBeGreaterThan(0);
      expect(meta.impactEn.length).toBeGreaterThan(0);
    }
  });

  it("each agent has non-empty techDetail records (zh + en), or intentionally empty for sidechain agents", () => {
    // sidechain agents (correctionObserver, empathyObserver) have simpler logic
    // where the detail text already covers technical aspects; AgentCard handles
    // empty techDetail gracefully via `Object.keys(techDetail).length > 0` guard
    const sidechainAgentsWithEmptyTechDetail = new Set([
      "correctionObserver",
      "empathyObserver",
      "signalCollector",
    ]);
    for (const name of EXPECTED_AGENT_NAMES) {
      const meta = AGENT_METADATA[name];
      if (sidechainAgentsWithEmptyTechDetail.has(name)) {
        // sidechain agents: techDetail may be empty (design choice),
        // but must still be a non-null object (downstream does
        // Object.keys(techDetail) — null would crash the component)
        expect(meta.techDetailZh).not.toBeNull();
        expect(typeof meta.techDetailZh).toBe("object");
        expect(Array.isArray(meta.techDetailZh)).toBe(false);
        expect(meta.techDetailEn).not.toBeNull();
        expect(typeof meta.techDetailEn).toBe("object");
        expect(Array.isArray(meta.techDetailEn)).toBe(false);
      } else {
        // all other agents: techDetail must be non-empty bilingual
        expect(Object.keys(meta.techDetailZh).length).toBeGreaterThan(0);
        expect(Object.keys(meta.techDetailEn).length).toBeGreaterThan(0);
      }
    }
  });

  it("impactLevel is one of danger/amber/green", () => {
    for (const name of EXPECTED_AGENT_NAMES) {
      const meta = AGENT_METADATA[name];
      expect(["danger", "amber", "green"]).toContain(meta.impactLevel);
    }
  });
});

describe("AGENT_METADATA: isCore assignment", () => {
  it("isCore=true for core agents (require inline confirm on disable)", () => {
    const coreAgents = [
      "diagnostician",
      "dreamer",
      "scribe",
      "artificer",
      "evaluator",
      "correctionObserver",
      "empathyObserver",
    ];
    for (const name of coreAgents) {
      expect(AGENT_METADATA[name].isCore).toBe(true);
    }
  });

  it("isCore=false for optional agents (MVP-Quiet, direct toggle)", () => {
    const optionalAgents = ["philosopher", "rolloutReviewer"];
    for (const name of optionalAgents) {
      expect(AGENT_METADATA[name].isCore).toBe(false);
    }
  });
});

describe("AGENT_METADATA: action field", () => {
  it("correctionObserver and empathyObserver have action with bilingual linkText and to", () => {
    const agentsWithAction = ["correctionObserver", "empathyObserver"];
    for (const name of agentsWithAction) {
      const meta = AGENT_METADATA[name];
      expect(meta.action).toBeDefined();
      expect(typeof meta.action).toBe("object");
      expect(meta.action!.linkTextZh.length).toBeGreaterThan(0);
      expect(meta.action!.linkTextEn.length).toBeGreaterThan(0);
      expect(meta.action!.to.length).toBeGreaterThan(0);
      expect(meta.action!.to).toMatch(/^\/control-center\/signal-keywords\?category=/);
    }
    // correction → ?category=correction
    expect(AGENT_METADATA.correctionObserver.action!.to).toContain("category=correction");
    // empathy → ?category=empathy
    expect(AGENT_METADATA.empathyObserver.action!.to).toContain("category=empathy");
  });

  it("signalCollector does not have action (infrastructure, not an agent)", () => {
    expect(Object.hasOwn(AGENT_METADATA.signalCollector, "action")).toBe(false);
  });
});

describe("AGENT_METADATA: group assignment", () => {
  it("core_trio = diagnostician, dreamer, scribe", () => {
    expect(AGENT_METADATA.diagnostician.group).toBe("core_trio");
    expect(AGENT_METADATA.dreamer.group).toBe("core_trio");
    expect(AGENT_METADATA.scribe.group).toBe("core_trio");
  });

  it("code_chain = artificer, evaluator", () => {
    expect(AGENT_METADATA.artificer.group).toBe("code_chain");
    expect(AGENT_METADATA.evaluator.group).toBe("code_chain");
  });

  it("quality_polish = philosopher, rolloutReviewer", () => {
    expect(AGENT_METADATA.philosopher.group).toBe("quality_polish");
    expect(AGENT_METADATA.rolloutReviewer.group).toBe("quality_polish");
  });

  it("sidechain = correctionObserver, empathyObserver", () => {
    expect(AGENT_METADATA.correctionObserver.group).toBe("sidechain");
    expect(AGENT_METADATA.empathyObserver.group).toBe("sidechain");
  });
});

describe("AGENT_GROUPS + GROUP_ORDER", () => {
  it("has 4 groups matching GROUP_ORDER", () => {
    expect(AGENT_GROUPS).toHaveLength(4);
    expect(AGENT_GROUPS.map((g) => g.id)).toEqual([...EXPECTED_GROUP_IDS]);
    expect(GROUP_ORDER).toEqual([...EXPECTED_GROUP_IDS]);
  });

  it("each group has non-empty bilingual label, tagLabel, hint", () => {
    for (const g of AGENT_GROUPS) {
      expect(g.labelZh.length).toBeGreaterThan(0);
      expect(g.labelEn.length).toBeGreaterThan(0);
      expect(g.tagLabelZh.length).toBeGreaterThan(0);
      expect(g.tagLabelEn.length).toBeGreaterThan(0);
      expect(g.hintZh.length).toBeGreaterThan(0);
      expect(g.hintEn.length).toBeGreaterThan(0);
    }
  });

  it("each group tag is one of must/recommend/optional/independent", () => {
    const validTags = ["must", "recommend", "optional", "independent"];
    for (const g of AGENT_GROUPS) {
      expect(validTags).toContain(g.tag);
    }
  });
});
