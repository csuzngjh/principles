import { describe, expect, it } from "vitest";
import { normRef, selectDeliverablePRs } from "../dev/cnb-auto-deliver.mjs";

/**
 * PRI-785: CNB's PR API returns full refs ("refs/heads/ai/cnb-dev/x").
 * The delivery filter used bare-name matching, never hit, and the pipeline
 * exited green with zero deliveries. These tests pin the normalized
 * contract in both formats, so neither shape can silently regress.
 */

const FULL = (branch) => `refs/heads/${branch}`;

function pr(number, headRef, baseRef, title = `dev pr ${number}`) {
  return { number, title, head: { ref: headRef }, base: { ref: baseRef } };
}

describe("normRef", () => {
  it("strips the refs/heads/ prefix", () => {
    expect(normRef("refs/heads/ai/cnb-dev/x")).toBe("ai/cnb-dev/x");
  });

  it("passes bare branch names through unchanged", () => {
    expect(normRef("ai/cnb-dev/x")).toBe("ai/cnb-dev/x");
    expect(normRef("main")).toBe("main");
  });

  it("treats missing refs as empty string (rc-1: unknown API data)", () => {
    expect(normRef(undefined)).toBe("");
    expect(normRef(null)).toBe("");
  });
});

describe("selectDeliverablePRs", () => {
  it("selects full-ref PRs (the shape the live CNB API returns)", () => {
    const pulls = [
      pr(1, FULL("ai/cnb-dev/feature-a"), FULL("main")),
      pr(2, FULL("docs/other"), FULL("main")),
      pr(3, FULL("ai/cnb-dev/feature-b"), FULL("dev")),
    ];
    const selected = selectDeliverablePRs(pulls);
    expect(selected.map((p) => p.number)).toEqual([1]);
  });

  it("still selects bare-ref PRs (documented example shape)", () => {
    const pulls = [pr(1, "ai/cnb-dev/feature-a", "main")];
    expect(selectDeliverablePRs(pulls).map((p) => p.number)).toEqual([1]);
  });

  it("rejects same-prefix branches outside the deliverable namespace", () => {
    // refs/heads/feature/ai/cnb-dev-x must NOT match prefix "ai/cnb-dev/"
    const pulls = [pr(1, FULL("feature/ai/cnb-dev-x"), FULL("main"))];
    expect(selectDeliverablePRs(pulls)).toEqual([]);
  });

  it("requires base main exactly", () => {
    const pulls = [pr(1, FULL("ai/cnb-dev/x"), FULL("main2")), pr(2, FULL("ai/cnb-dev/y"), FULL("main"))];
    expect(selectDeliverablePRs(pulls).map((p) => p.number)).toEqual([2]);
  });

  it("tolerates null/non-array input and PRs missing head/base", () => {
    expect(selectDeliverablePRs(null)).toEqual([]);
    expect(selectDeliverablePRs([pr(1, undefined, undefined)])).toEqual([]);
  });
});
