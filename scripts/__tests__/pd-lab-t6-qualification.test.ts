// PRI-1258 / PD-Lab v0.3 T7a — T6 qualification gate tests.
//
// Drives the pure engine (scripts/dev/pd-lab/t6-qualification.mjs) and the
// real CLI (scripts/dev/pd-lab/t6-qualify.mjs, the `npm run lab:qualify`
// entry) as a subprocess. Coverage required by the task card / HANDOFF T7a
// item 4 + DT-08 / DT-09:
//  - CONTRACT 6.5 two-sided threshold table at alpha = 0.05 for the full
//    tabulated n range and the task boundary list n = 0/1/5/6/8/9/11/12/14;
//  - n = 1..5 admits no k <= n (descriptive/exploratory only);
//  - n_min(alpha) is DERIVED from the formula for non-default alphas
//    (the default 6 is never hardcoded as a universal threshold);
//  - the three states from raw inputs: BLOCKED (authorization/integrity,
//    n = 0, D2/D5 missing, calibration NOT_RUN/FAILED, and the recorded
//    unauthorized-activity stop conditions), EXPLORATORY_ONLY (gates passed
//    but n / preregistered minimum / precision / Owner review unmet),
//    CONFIRMATORY_READY;
//  - exploratory results can never produce PROMOTE;
//  - mechanical recomputability: identical inputs produce identical
//    verdicts and the output echoes the inputs;
//  - every QUALIFICATION_REASON_CODES entry is triggered (ERR-146 closed
//    set), and no unlisted code is ever emitted;
//  - CLI: exit 0 for BLOCKED (a valid computed outcome), exit 1 for
//    structurally invalid input, exit 2 for usage errors, deterministic
//    output files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QUALIFICATION_REASON_CODES,
  nMinForAlpha,
  qualifyT6,
  validateQualificationInput,
} from "../dev/pd-lab/t6-qualification.mjs";
import { sourceGroupsDigestOf } from "../dev/pd-lab/admission-probe.mjs";
import { twoSidedThreshold } from "../dev/pd-lab/alignment-report.mjs";
import {
  JUDGE_PROTOCOL_REF,
  judgeProtocolDigest,
  restoreDisplayVerdict,
} from "../dev/pd-lab/judge-protocol.mjs";
import {
  runQualifyCli,
  REPO_ROOT,
} from "./fixtures/pd-lab-t6-qualification-helpers.mjs";

let tempRoot: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pd-lab-t6-qualification-"));
});

afterAll(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

const FAKE_SHA = `sha256:${"a".repeat(64)}`;

/** The declared evidence bindings of a fully-governed input. */
function evidenceBindings() {
  return {
    sourceGroups: { artifactRef: "source-groups.json", sha256: FAKE_SHA },
    admissionReport: { artifactRef: "admission-report.json", sha256: FAKE_SHA },
    preregistration: {
      artifactRef: "t6-preregistration.json",
      sha256: FAKE_SHA,
    },
    judgeCalibration: {
      artifactRef: "judge-calibration.json",
      sha256: FAKE_SHA,
    },
    ownerBlindReview: { artifactRef: "owner-review.json", sha256: FAKE_SHA },
    approvals: {
      d2: { artifactRef: "d2.json", sha256: FAKE_SHA },
      d5: { artifactRef: "d5.json", sha256: FAKE_SHA },
      d6: { artifactRef: "d6.json", sha256: FAKE_SHA },
    },
  };
}

const APPROVAL_BASE = (approved: boolean, scope: string) => ({
  kind: "owner-decision",
  approved,
  decidedBy: "O1",
  decidedAt: "2026-11-21T00:00:00Z",
  scope,
});

const DATASET_SHA = "b".repeat(64);
const PRECISION_TARGET = 0.9;
// The synthetic judge model every calibration invocation claims to have run
// (P1-2/P1-3: the D2 decision freezes the same model).
const JUDGE_MODEL = {
  provider: "synthetic-provider",
  modelId: "judge-synth-1",
  version: "1.0.0",
};
// D5 synthetic thresholds — the fixture review always satisfies them; the
// negative tests below mutate them to prove the bindings fail closed.
const D5_PARAMS = {
  samplePairs: 20,
  agreementRateThreshold: 0.8,
  maxPositionFlipRate: 0.2,
  reviewScope: "t7a-owner-blind-review",
  recheckRequired: true,
};

/** Synthetic resolved evidence docs matching a granted input's claims. */
function resolvedFor(input: Record<string, any>, opts: { exploratory?: boolean } = {}) {
  const n = input.readyIndependentSourceGroups;
  const cases = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`case-${i + 1}`, `group-${i + 1}`]),
  );
  const rationales = Object.fromEntries(
    Object.values(cases).map((groupId) => [
      groupId,
      "synthetic: one case per group",
    ]),
  );
  // The declared digest is the REAL recomputed digest — the gate verifies
  // contents mechanically, so a fixture digest must be honest.
  const groupsDigest = sourceGroupsDigestOf(cases, rationales);
  const perSample = Object.keys(cases).map((caseId) => ({
    caseId,
    sessionId: `sess-${caseId}`,
    completeness: "COMPLETE_FOR_ANALYSIS",
    pathReadiness: {
      PIPELINE_REPLAY: "READY",
      EXPECTATION_LABELING: "READY",
      BEHAVIOR_BRANCH: "READY",
    },
  }));
  // Calibration invocations carry the full per-call evidence (P1-2): the
  // model that served the call, the judge verdict, the reference verdict,
  // and the position-exchange outcome. When the input claims the precision
  // target was NOT met, the first quarter of calls disagree so the
  // RECOMPUTED agreement rate lands below the 0.9 target — the fixture's
  // numbers must be internally consistent with its own claims.
  const callCount = input.judgeModelCalibration.modelCallCount;
  const precisionMet = input.analysisPolicy.precisionTargetMet === true;
  const invocations = Array.from({ length: callCount }, (_, i) => {
    const disagree = !precisionMet && i < Math.ceil(callCount / 4);
    return {
      invocationId: `inv-${i + 1}`,
      status: "SUCCEEDED",
      model: { ...JUDGE_MODEL },
      judgeVerdict: disagree ? "B_BETTER" : "A_BETTER",
      referenceVerdict: "A_BETTER",
      positionExchangeConsistent: true,
    };
  });
  // Blind-review samples carry the actual review record (P1-2): position,
  // identity map, the Owner's verdict, the judge's verdict, the restored
  // candidate-frame verdict (recomputed with the protocol's own
  // restoration), the recheck stability and the disagreement type.
  const reviewCount = input.ownerBlindReview.sampleCount;
  const samples = Array.from({ length: reviewCount }, (_, i) => {
    const identityMap = { A: "candidate", B: "reference" };
    const judgeVerdict = "A_BETTER";
    return {
      sampleId: `s-${i + 1}`,
      packageId: `pkg-${i + 1}`,
      displayOrder: "AB",
      identityMap,
      ownerVerdict: judgeVerdict,
      judgeVerdict,
      judgeRestoredVerdict: restoreDisplayVerdict(judgeVerdict, identityMap),
      recheckStability: "STABLE",
      disagreementType: null,
    };
  });
  return {
    sourceGroups: {
      artifactRef: "source-groups.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-source-groups.v1",
        datasetSha256: DATASET_SHA,
        digest: groupsDigest,
        groups: cases,
        rationales,
      },
    },
    admissionReport: {
      artifactRef: "admission-report.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-admission-report.v1",
        ok: true,
        dataset: { sha256: DATASET_SHA },
        snapshot: { consistencyStatus: "CONSISTENT_WITHIN_WINDOW" },
        invalidPlan: [],
        realDataProbe: {
          status: "RAN_WITH_D6",
          d6Decision: {
            file: "d6.json",
            // admission-probe emits the bare 64-char hex digest; evidence
            // bindings use the sha256: prefix. Exercise the producer format.
            sha256: FAKE_SHA.slice("sha256:".length),
            decidedBy: "O1",
            decidedAt: "2026-11-21T00:00:00Z",
            datasetSha256: DATASET_SHA,
          },
          probeScope: { datasetSha256: DATASET_SHA },
          result: "synthetic fixture probe under a bound D6 decision",
        },
        sourceGroups: {
          digest: groupsDigest,
          groupCount: Object.keys(cases).length,
          independentSourceGroupCount: Object.keys(cases).length,
        },
        perSample,
      },
    },
    preregistration: {
      artifactRef: "t6-preregistration.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-t6-preregistration.v1",
        analysisPolicy: {
          alpha: input.analysisPolicy.alpha,
          minimumIndependentSourceGroups:
            input.analysisPolicy.minimumIndependentSourceGroups,
          precisionTarget: PRECISION_TARGET,
        },
        exploratory: opts.exploratory === true,
      },
    },
    judgeCalibration: {
      artifactRef: "judge-calibration.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-judge-calibration.v1",
        status: input.judgeModelCalibration.status,
        judgeProtocolRef: JUDGE_PROTOCOL_REF,
        judgeProtocolDigest: judgeProtocolDigest(),
        judgeModel: { ...JUDGE_MODEL },
        invocations,
        precisionTarget: PRECISION_TARGET,
        precisionTargetMet: precisionMet,
      },
    },
    ownerBlindReview: {
      artifactRef: "owner-review.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-owner-blind-review.v1",
        status: input.ownerBlindReview.status,
        samples,
      },
    },
    approvals: {
      d2: {
        artifactRef: "d2.json",
        sha256: FAKE_SHA,
        document: {
          ...APPROVAL_BASE(input.authorization.d2Approved, "d2"),
          exploratory: opts.exploratory === true,
          parameters: {
            model: { ...JUDGE_MODEL },
            alpha: input.analysisPolicy.alpha,
            minimumIndependentSourceGroups:
              input.analysisPolicy.minimumIndependentSourceGroups,
            precisionTarget: PRECISION_TARGET,
            callBudget: 10000,
            repetitions: 1,
            licenseConditions: "synthetic-test-license",
          },
        },
      },
      d5: {
        artifactRef: "d5.json",
        sha256: FAKE_SHA,
        document: {
          ...APPROVAL_BASE(input.authorization.d5Approved, "d5"),
          parameters: { ...D5_PARAMS },
        },
      },
      d6: {
        artifactRef: "d6.json",
        sha256: FAKE_SHA,
        document: {
          ...APPROVAL_BASE(input.authorization.d6Approved === true, "d6"),
          parameters: {
            datasetSha256: DATASET_SHA,
            sampleRange: "frozen-16",
            storageScope: "artifacts/pd-lab",
            dataSource: "t1-snapshot",
            retentionDays: 365,
          },
        },
      },
    },
  };
}

/** qualifyT6 with the resolved synthetic evidence for a granted input. */
function run(input: Record<string, any>) {
  return qualifyT6(input, resolvedFor(input) as never);
}

/** Every governance fact granted — only the varying field changes. */
function grantedInput(overrides: Record<string, unknown> = {}) {
  return {
    readyIndependentSourceGroups: 14,
    analysisPolicy: {
      alpha: 0.05,
      minimumIndependentSourceGroups: 14,
      precisionTargetMet: true,
    },
    authorization: {
      dataPathAuthorizationValid: true,
      dataIntegrityValid: true,
      d2Approved: true,
      d5Approved: true,
      d6Approved: true,
    },
    judgeModelCalibration: { status: "PASSED", modelCallCount: 40 },
    ownerBlindReview: { status: "PASSED", sampleCount: 40 },
    evidence: evidenceBindings(),
    ...overrides,
  };
}

/** Today's honest state: no D2, no D5, live calibration NOT_RUN, 0 calls. */
function notRunInput() {
  return {
    readyIndependentSourceGroups: 0,
    analysisPolicy: {
      alpha: 0.05,
      minimumIndependentSourceGroups: 14,
      precisionTargetMet: false,
    },
    authorization: {
      dataPathAuthorizationValid: false,
      dataIntegrityValid: false,
      d2Approved: false,
      d5Approved: false,
    },
    judgeModelCalibration: { status: "NOT_RUN", modelCallCount: 0 },
    ownerBlindReview: { status: "NOT_RUN", sampleCount: 0 },
  };
}

function setPath(
  input: ReturnType<typeof grantedInput>,
  path: string,
  value: unknown,
) {
  const holder = JSON.parse(JSON.stringify(input)) as Record<
    string,
    Record<string, unknown>
  >;
  const segments = path.split(".");
  let cursor: Record<string, unknown> = holder;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return holder as unknown as ReturnType<typeof grantedInput>;
}

// ---------------------------------------------------------------------------
// CONTRACT 6.5 statistics (task P4).
// ---------------------------------------------------------------------------

describe("two-sided threshold k(n, alpha) — CONTRACT 6.5 table", () => {
  it("matches the CONTRACT table exactly at alpha = 0.05 for every tabulated n", () => {
    const table: Record<number, number> = {
      6: 6,
      7: 7,
      8: 8,
      9: 8,
      10: 9,
      11: 10,
      12: 10,
      13: 11,
      14: 12,
      15: 12,
      16: 13,
      20: 15,
      30: 21,
      50: 33,
      100: 61,
    };
    for (const [n, k] of Object.entries(table)) {
      expect(twoSidedThreshold(Number(n), 0.05), `k(${n}, 0.05)`).toBe(k);
    }
  });

  it("task boundary list n = 0/1/5/6/8/9/11/12/14 (DT-08)", () => {
    const expected: Record<number, number | null> = {
      0: null,
      1: null,
      5: null,
      6: 6,
      8: 8,
      9: 8,
      11: 10,
      12: 10,
      14: 12,
    };
    for (const [n, k] of Object.entries(expected)) {
      expect(twoSidedThreshold(Number(n), 0.05), `k(${n}, 0.05)`).toBe(k);
    }
  });

  it("n = 1..5 admits NO k <= n: the test is unreachable, not merely underpowered", () => {
    for (let n = 1; n <= 5; n += 1) {
      expect(twoSidedThreshold(n, 0.05)).toBeNull();
    }
  });

  it("n_min(alpha) is derived from the formula — never the hardcoded 6", () => {
    expect(nMinForAlpha(0.05)).toBe(6);
    expect(nMinForAlpha(0.1)).toBe(5);
    expect(nMinForAlpha(0.01)).toBe(8);
    expect(nMinForAlpha(0.2)).toBe(4);
    // Formula boundary proof: at n_min the all-win tail 2^-n <= alpha/2,
    // and at n_min - 1 it is not (independent binomial recomputation).
    for (const alpha of [0.05, 0.1, 0.01, 0.2]) {
      const nMin = nMinForAlpha(alpha);
      expect(2 ** -nMin).toBeLessThanOrEqual(alpha / 2);
      expect(2 ** -(nMin - 1)).toBeGreaterThan(alpha / 2);
      // Cross-check the same fact through the threshold function itself.
      expect(twoSidedThreshold(nMin, alpha)).toBe(nMin);
      expect(twoSidedThreshold(nMin - 1, alpha)).toBeNull();
    }
    // Invalid alpha fails loud (rc-3), never silently defaults.
    for (const bad of [0, 1, -0.1, 1.5, Number.NaN]) {
      expect(() => nMinForAlpha(bad)).toThrow();
    }
  });

  it("changing alpha changes the reachability floor — 6 is not a universal gate (统计口径不可协商下调)", () => {
    // With gates granted and minimumIndependentSourceGroups = 5:
    const policy = (alpha: number) =>
      grantedInput({
        readyIndependentSourceGroups: 5,
        analysisPolicy: {
          alpha,
          minimumIndependentSourceGroups: 5,
          precisionTargetMet: true,
        },
      });
    expect(run(policy(0.1)).status).toBe("CONFIRMATORY_READY"); // n_min(0.10) = 5
    expect(run(policy(0.05)).status).toBe("EXPLORATORY_ONLY"); // n_min(0.05) = 6 > 5
    // The verdict always echoes the alpha it used, so drift is visible.
    expect(run(policy(0.1)).thresholds.alpha).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Three qualification states (task P3, DT-08 / DT-09).
// ---------------------------------------------------------------------------

describe("qualifyT6 states", () => {
  it("all gates granted at n = 14 (min 14) -> CONFIRMATORY_READY with exact k", () => {
    const result = run(grantedInput());
    expect(result.status).toBe("CONFIRMATORY_READY");
    expect(result.blockedReasons).toEqual([]);
    expect(result.unmetCriteria).toEqual([]);
    expect(result.thresholds).toMatchObject({
      alpha: 0.05,
      nMinAlpha: 6,
      minimumIndependentSourceGroups: 14,
      requiredIndependentSourceGroups: 14,
      readyIndependentSourceGroups: 14,
      kAtReadyN: 12,
    });
    expect(result.t6Permissions).toEqual({
      confirmatoryT6Allowed: true,
      exploratoryT6Allowed: false,
      promotePossible: true,
    });
  });

  it("DT-08 boundary statuses at alpha = 0.05 with minimum 6 and every gate granted", () => {
    const at = (n: number) =>
      run(
        grantedInput({
          readyIndependentSourceGroups: n,
          analysisPolicy: {
            alpha: 0.05,
            minimumIndependentSourceGroups: 6,
            precisionTargetMet: true,
          },
          ownerBlindReview: { status: "PASSED", sampleCount: 30 },
        }),
      );
    // n=0 keeps BLOCKED semantics even with authorizations granted.
    expect(at(0).status).toBe("BLOCKED");
    for (const n of [1, 5]) expect(at(n).status).toBe("EXPLORATORY_ONLY");
    for (const n of [6, 8, 9, 11, 12, 14])
      expect(at(n).status, `n=${n}`).toBe("CONFIRMATORY_READY");
    // Exact k at each boundary (HANDOFF: 6-8 need all-win, 9-11/12-14 computed).
    expect(at(6).thresholds.kAtReadyN).toBe(6);
    expect(at(8).thresholds.kAtReadyN).toBe(8);
    expect(at(9).thresholds.kAtReadyN).toBe(8);
    expect(at(11).thresholds.kAtReadyN).toBe(10);
    expect(at(12).thresholds.kAtReadyN).toBe(10);
    expect(at(14).thresholds.kAtReadyN).toBe(12);
  });

  it("BLOCKED: each authorization / calibration failure blocks T6 (DT-09)", () => {
    const cases: Array<[string, ReturnType<typeof grantedInput>]> = [
      [
        "data path authorization",
        setPath(
          grantedInput(),
          "authorization.dataPathAuthorizationValid",
          false,
        ),
      ],
      [
        "data integrity",
        setPath(grantedInput(), "authorization.dataIntegrityValid", false),
      ],
      ["n = 0", grantedInput({ readyIndependentSourceGroups: 0 })],
      [
        "D2 not approved",
        setPath(grantedInput(), "authorization.d2Approved", false),
      ],
      [
        "D5 not approved",
        setPath(grantedInput(), "authorization.d5Approved", false),
      ],
      [
        "calibration NOT_RUN",
        setPath(grantedInput(), "judgeModelCalibration.status", "NOT_RUN"),
      ],
      [
        "calibration FAILED",
        setPath(grantedInput(), "judgeModelCalibration.status", "FAILED"),
      ],
    ];
    for (const [label, input] of cases) {
      const result = run(input);
      expect(result.status, label).toBe("BLOCKED");
      expect(result.t6Permissions).toEqual({
        confirmatoryT6Allowed: false,
        exploratoryT6Allowed: false,
        promotePossible: false,
      });
    }
  });

  it("recorded activity without its authorization is a stop-condition violation (fail-loud)", () => {
    const noD2WithCalls = setPath(
      grantedInput(),
      "authorization.d2Approved",
      false,
    );
    const result1 = run(noD2WithCalls);
    expect(result1.status).toBe("BLOCKED");
    expect(result1.blockedReasons).toContain("D2_NOT_APPROVED");
    const noD2WithRecordedCalls = setPath(
      grantedInput({
        judgeModelCalibration: { status: "PASSED", modelCallCount: 3 },
      }),
      "authorization.d2Approved",
      false,
    );
    const result2 = run(noD2WithRecordedCalls);
    expect(result2.blockedReasons).toContain(
      "UNAUTHORIZED_MODEL_CALLS_RECORDED",
    );
    const noD5WithSamples = setPath(
      grantedInput({ ownerBlindReview: { status: "PASSED", sampleCount: 2 } }),
      "authorization.d5Approved",
      false,
    );
    expect(run(noD5WithSamples).blockedReasons).toContain(
      "UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED",
    );
  });

  it("EXPLORATORY_ONLY: gates passed but confirmatory criteria unmet; never PROMOTE", () => {
    const cases: Array<[string, ReturnType<typeof grantedInput>, string[]]> = [
      [
        "below n_min(alpha)",
        grantedInput({
          readyIndependentSourceGroups: 5,
          analysisPolicy: {
            alpha: 0.05,
            minimumIndependentSourceGroups: 5,
            precisionTargetMet: true,
          },
        }),
        ["BELOW_N_MIN_ALPHA"],
      ],
      [
        "below preregistered minimum",
        grantedInput({
          readyIndependentSourceGroups: 6,
          analysisPolicy: {
            alpha: 0.05,
            minimumIndependentSourceGroups: 14,
            precisionTargetMet: true,
          },
        }),
        ["BELOW_PREREGISTERED_MIN_SOURCE_GROUPS"],
      ],
      [
        "precision target unmet",
        setPath(grantedInput(), "analysisPolicy.precisionTargetMet", false),
        ["PRECISION_TARGET_NOT_MET"],
      ],
      [
        "owner review not passed",
        grantedInput({
          ownerBlindReview: { status: "NOT_RUN", sampleCount: 0 },
        }),
        ["OWNER_BLIND_REVIEW_NOT_PASSED"],
      ],
    ];
    for (const [label, input, criteria] of cases) {
      const result = run(input);
      expect(result.status, label).toBe("EXPLORATORY_ONLY");
      expect(result.blockedReasons).toEqual([]);
      expect(result.unmetCriteria).toEqual(criteria);
      expect(
        result.t6Permissions.promotePossible,
        `${label}: exploratory can never PROMOTE`,
      ).toBe(false);
      expect(result.t6Permissions.confirmatoryT6Allowed).toBe(false);
    }
  });

  it("exploratory T6 requires prereg marker AND a bound D2 exploratory decision (P1-3)", () => {
    const base = grantedInput({
      readyIndependentSourceGroups: 5,
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 5,
        precisionTargetMet: true,
      },
    });
    // Neither authorization alone suffices — the input boolean is never
    // trusted, and a plain D2 approval does not cover exploratory.
    expect(run(base).t6Permissions.exploratoryT6Allowed).toBe(false);
    expect(
      run({ ...base, d2ExploratoryApproval: true }).t6Permissions
        .exploratoryT6Allowed,
    ).toBe(false);
    const bothAuth = qualifyT6(
      base,
      resolvedFor(base, { exploratory: true }) as never,
    );
    expect(bothAuth.t6Permissions.exploratoryT6Allowed).toBe(true);
    // Even with the exploratory approval, PROMOTE stays impossible.
    expect(bothAuth.t6Permissions.promotePossible).toBe(false);
    // Prereg marker without the D2 exploratory grant → not allowed.
    const preregOnly = resolvedFor(base, { exploratory: true }) as any;
    preregOnly.approvals.d2.document.exploratory = false;
    expect(
      qualifyT6(base, preregOnly).t6Permissions.exploratoryT6Allowed,
    ).toBe(false);
    // D2 exploratory grant without the prereg marker → not allowed.
    const d2Only = resolvedFor(base, { exploratory: true }) as any;
    d2Only.preregistration.document.exploratory = false;
    expect(
      qualifyT6(base, d2Only).t6Permissions.exploratoryT6Allowed,
    ).toBe(false);
  });

  it("P1-1: an exploratory preregistration can NEVER reach CONFIRMATORY_READY, even with every statistical condition met", () => {
    // Every gate granted, n = 14 >= every minimum, precision met, review
    // PASSED — the ONLY exploratory fact is the preregistration marker.
    const result = run(grantedInput());
    expect(result.status).toBe("CONFIRMATORY_READY");
    const exploratory = qualifyT6(
      grantedInput(),
      resolvedFor(grantedInput(), { exploratory: true }) as never,
    );
    // The marker alone caps the verdict at EXPLORATORY_ONLY...
    expect(exploratory.status).toBe("EXPLORATORY_ONLY");
    expect(exploratory.unmetCriteria).toEqual([
      "PREREGISTRATION_EXPLORATORY_CAP",
    ]);
    // ...and forbids both the confirmatory grant and PROMOTE.
    expect(exploratory.t6Permissions.confirmatoryT6Allowed).toBe(false);
    expect(exploratory.t6Permissions.promotePossible).toBe(false);
    // The full exploratory authorization set still grants exploratory T6.
    expect(exploratory.t6Permissions.exploratoryT6Allowed).toBe(true);
    // A confirmatory preregistration with the same evidence stays
    // CONFIRMATORY_READY — the cap discriminates on the registration type.
    expect(run(grantedInput()).status).toBe("CONFIRMATORY_READY");
  });

  it("P1-1: exploratory T6 requires the Owner blind review to have PASSED with the D5 sample floor", () => {
    const base = grantedInput({
      readyIndependentSourceGroups: 5,
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 5,
        precisionTargetMet: true,
      },
    });
    // Owner blind review NOT_RUN → exploratory T6 denied even with the full
    // D2 exploratory + prereg marker authorization pair.
    const notRun = qualifyT6(
      { ...base, ownerBlindReview: { status: "NOT_RUN", sampleCount: 0 } },
      resolvedFor(
        { ...base, ownerBlindReview: { status: "NOT_RUN", sampleCount: 0 } },
        { exploratory: true },
      ) as never,
    );
    expect(notRun.status).toBe("EXPLORATORY_ONLY");
    expect(notRun.unmetCriteria).toContain("OWNER_BLIND_REVIEW_NOT_PASSED");
    expect(notRun.t6Permissions.exploratoryT6Allowed).toBe(false);
    // PASSED but below the D5-approved sample floor (20) → fail-closed
    // BLOCKED (an authorization mismatch, not an unmet criterion).
    const thin = { ...base, ownerBlindReview: { status: "PASSED", sampleCount: 10 } };
    const thinResult = qualifyT6(
      thin,
      resolvedFor(thin, { exploratory: true }) as never,
    );
    expect(thinResult.status).toBe("BLOCKED");
    expect(
      thinResult.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("sample pairs");
    expect(thinResult.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(thinResult.t6Permissions.exploratoryT6Allowed).toBe(false);
  });

  it("today's honest state (no D2/D5/D6) is mechanically BLOCKED", () => {
    const result = qualifyT6(notRunInput());
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toEqual([
      "EVIDENCE_MISSING_FOR_CLAIM",
      "DATA_PATH_AUTHORIZATION_INVALID",
      "DATA_INTEGRITY_UNPROVEN",
      "NO_READY_SOURCE_GROUPS",
      "D2_NOT_APPROVED",
      "D5_NOT_APPROVED",
      "D6_NOT_APPROVED",
      "MODEL_CALIBRATION_NOT_RUN",
    ]);
    expect(result.inputs.judgeModelCalibration).toEqual({
      status: "NOT_RUN",
      modelCallCount: 0,
    });
    expect(result.inputs.ownerBlindReview).toEqual({
      status: "NOT_RUN",
      sampleCount: 0,
    });
  });

  it("closed-set round-trip: every reason code is triggered, none outside the list (ERR-146)", { timeout: 180_000 }, () => {
    // [input, resolvedEvidenceOrNull] — the evidence is the docs matching the
    // claims, except where a fixture intentionally mutates one to trigger a
    // mismatch/invalid code.
    const mismatchedCalibration = (input: ReturnType<typeof grantedInput>) => {
      const ev = resolvedFor(input) as Record<string, any>;
      ev.judgeCalibration.document.invocations = ev.judgeCalibration.document.invocations.slice(0, 3);
      return ev;
    };
    const invalidReview = (input: ReturnType<typeof grantedInput>) => {
      const ev = resolvedFor(input) as Record<string, any>;
      ev.ownerBlindReview.document = { schema: "not-a-review" };
      return ev;
    };
    const driftedPrereg = (input: ReturnType<typeof grantedInput>) => {
      const ev = resolvedFor(input) as Record<string, any>;
      ev.preregistration.document.analysisPolicy.alpha = 0.01;
      return ev;
    };
    const unmeasurablePositionFlip = (input: ReturnType<typeof grantedInput>) => {
      const ev = resolvedFor(input) as Record<string, any>;
      for (const invocation of ev.judgeCalibration.document.invocations) {
        invocation.judgeVerdict = "UNKNOWN";
        invocation.referenceVerdict = "UNKNOWN";
      }
      return ev;
    };
    const fixtures: Array<[Record<string, any>, unknown]> = [
      [notRunInput(), null],
      [
        setPath(
          grantedInput(),
          "authorization.dataPathAuthorizationValid",
          false,
        ),
        null,
      ],
      [setPath(grantedInput(), "authorization.dataIntegrityValid", false), null],
      [grantedInput({ readyIndependentSourceGroups: 0 }), null],
      [setPath(grantedInput(), "authorization.d2Approved", false), null],
      [setPath(grantedInput(), "authorization.d5Approved", false), null],
      [setPath(grantedInput(), "judgeModelCalibration.status", "FAILED"), null],
      [
        setPath(
          grantedInput({
            judgeModelCalibration: { status: "PASSED", modelCallCount: 3 },
          }),
          "authorization.d2Approved",
          false,
        ),
        null,
      ],
      [
        setPath(
          grantedInput({
            ownerBlindReview: { status: "PASSED", sampleCount: 2 },
          }),
          "authorization.d5Approved",
          false,
        ),
        null,
      ],
      [
        grantedInput({
          readyIndependentSourceGroups: 5,
          analysisPolicy: {
            alpha: 0.05,
            minimumIndependentSourceGroups: 5,
            precisionTargetMet: true,
          },
        }),
        "resolved",
      ],
      [
        grantedInput({
          readyIndependentSourceGroups: 6,
          analysisPolicy: {
            alpha: 0.05,
            minimumIndependentSourceGroups: 14,
            precisionTargetMet: true,
          },
        }),
        "resolved",
      ],
      [
        setPath(grantedInput(), "analysisPolicy.precisionTargetMet", false),
        "resolved",
      ],
      [
        grantedInput({
          ownerBlindReview: { status: "NOT_RUN", sampleCount: 0 },
        }),
        "resolved",
      ],
      // Status/count conflicts + evidence-binding codes.
      [
        grantedInput({
          judgeModelCalibration: { status: "PASSED", modelCallCount: 0 },
        }),
        "resolved",
      ],
      [
        grantedInput({
          ownerBlindReview: { status: "NOT_RUN", sampleCount: 2 },
        }),
        "resolved",
      ],
      [grantedInput(), "missing"],
      [grantedInput(), invalidReview],
      [grantedInput(), mismatchedCalibration],
      [grantedInput(), driftedPrereg],
      [grantedInput(), unmeasurablePositionFlip],
      [setPath(grantedInput(), "authorization.d6Approved", false), "resolved"],
      // N_MIN_ALPHA_SEARCH_EXHAUSTED: an alpha so small no k <= n exists
      // inside the search cap must fail closed as BLOCKED, never coerced.
      [
        grantedInput({
          readyIndependentSourceGroups: 5,
          analysisPolicy: {
            alpha: 1e-310,
            minimumIndependentSourceGroups: 5,
            precisionTargetMet: true,
          },
        }),
        "resolved",
      ],
      // PREREGISTRATION_EXPLORATORY_CAP: every statistical condition met,
      // only the exploratory registration marker caps the verdict.
      [
        grantedInput(),
        (input: ReturnType<typeof grantedInput>) =>
          resolvedFor(input, { exploratory: true }),
      ],
    ];
    const emitted = new Set<string>();
    for (const [input, evidence] of fixtures) {
      const resolved =
        evidence === "resolved"
          ? resolvedFor(input)
          : evidence === "missing"
            ? null
            : typeof evidence === "function"
              ? evidence(input)
              : null;
      const result = qualifyT6(input, resolved as never);
      expect(result.ok).toBe(true);
      for (const code of [...result.blockedReasons, ...result.unmetCriteria]) {
        expect(QUALIFICATION_REASON_CODES).toContain(code);
        emitted.add(code);
      }
    }
    expect([...emitted].sort()).toEqual([...QUALIFICATION_REASON_CODES].sort());
  });

  it("mechanical recomputability: identical inputs -> identical verdicts, inputs echoed", () => {
    const input = grantedInput({
      readyIndependentSourceGroups: 7,
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 9,
        precisionTargetMet: false,
      },
    });
    const first = run(input);
    const second = run(JSON.parse(JSON.stringify(input)));
    expect(second).toEqual(first);
    expect(first.inputs).toEqual(input);
    expect(first.status).toBe("EXPLORATORY_ONLY");
  });

  it("status/count consistency table: PASSED+0 and NOT_RUN+>0 are rejected claims", () => {
    const passedZero = run(
      grantedInput({
        judgeModelCalibration: { status: "PASSED", modelCallCount: 0 },
      }),
    );
    expect(passedZero.status).toBe("BLOCKED");
    expect(passedZero.blockedReasons).toContain(
      "CALIBRATION_STATUS_COUNT_CONFLICT",
    );
    const notRunNonZero = run(
      grantedInput({
        judgeModelCalibration: { status: "NOT_RUN", modelCallCount: 3 },
      }),
    );
    expect(notRunNonZero.status).toBe("BLOCKED");
    expect(notRunNonZero.blockedReasons).toContain(
      "CALIBRATION_STATUS_COUNT_CONFLICT",
    );
    const reviewPassedZero = run(
      grantedInput({
        ownerBlindReview: { status: "PASSED", sampleCount: 0 },
      }),
    );
    expect(reviewPassedZero.blockedReasons).toContain(
      "OWNER_REVIEW_STATUS_COUNT_CONFLICT",
    );
    // A FAILED calibration keeps its evidence (calls>0 is legal audit) and
    // never counts as passed.
    const failed = run(
      grantedInput({
        judgeModelCalibration: { status: "FAILED", modelCallCount: 7 },
      }),
    );
    expect(failed.status).toBe("BLOCKED");
    expect(failed.blockedReasons).toContain("MODEL_CALIBRATION_FAILED");
  });

  it("evidence binding: derived facts that contradict the declaration reject the input", () => {
    // Report count != declared count.
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.judgeCalibration.document.invocations =
      ev.judgeCalibration.document.invocations.slice(0, 7);
    const mismatch = qualifyT6(input, ev as never);
    expect(mismatch.status).toBe("BLOCKED");
    expect(mismatch.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");
    // Missing the reports entirely blocks the affirmative claims.
    const unbound = qualifyT6(grantedInput());
    expect(unbound.status).toBe("BLOCKED");
    expect(unbound.blockedReasons).toContain("EVIDENCE_MISSING_FOR_CLAIM");
    // Missing D2/D5/D6 structured approval records block.
    const noApprovals = qualifyT6(
      grantedInput(),
      { ...ev, approvals: {} } as never,
    );
    expect(noApprovals.status).toBe("BLOCKED");
    expect(noApprovals.blockedReasons).toContain("D2_NOT_APPROVED");
    expect(noApprovals.blockedReasons).toContain("D5_NOT_APPROVED");
    expect(noApprovals.blockedReasons).toContain("D6_NOT_APPROVED");
  });

  it("readyIndependentSourceGroups is mechanically derived: dedup by groupId, READY-on-all-paths only", () => {
    const input = grantedInput({ readyIndependentSourceGroups: 2 });
    const ev = resolvedFor(input) as Record<string, any>;
    // Two cases sharing one sourceGroupId count as ONE group; a third group
    // whose case is not READY on every T6 path is excluded.
    ev.sourceGroups.document.groups = {
      "case-1": "group-a",
      "case-2": "group-a",
      "case-3": "group-b",
      "case-4": "group-c",
    };
    ev.sourceGroups.document.digest = sourceGroupsDigestOf(
      ev.sourceGroups.document.groups,
      ev.sourceGroups.document.rationales,
    );
    ev.admissionReport.document.sourceGroups.digest =
      ev.sourceGroups.document.digest;
    ev.admissionReport.document.perSample = [
      { caseId: "case-1", sessionId: "sess-1", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "READY", BEHAVIOR_BRANCH: "READY" } },
      { caseId: "case-2", sessionId: "sess-2", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "READY", BEHAVIOR_BRANCH: "READY" } },
      { caseId: "case-3", sessionId: "sess-3", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "READY", BEHAVIOR_BRANCH: "READY" } },
      { caseId: "case-4", sessionId: "sess-4", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "BLOCKED", BEHAVIOR_BRANCH: "READY" } },
    ];
    const result = qualifyT6(input, ev as never);
    expect(result.evidenceCheck.artifacts.readySourceGroups.derived).toBe(2);
    expect(result.evidenceCheck.artifacts.readySourceGroups.readyGroupIds).toEqual(
      ["group-a", "group-b"],
    );
    // Declared 2 == derived 2 -> the count stands; dropping a case to a
    // non-READY group makes the declaration wrong and is rejected.
    ev.sourceGroups.document.groups["case-4"] = "group-b";
    ev.sourceGroups.document.digest = sourceGroupsDigestOf(
      ev.sourceGroups.document.groups,
      ev.sourceGroups.document.rationales,
    );
    ev.admissionReport.document.sourceGroups.digest =
      ev.sourceGroups.document.digest;
    const honest = qualifyT6(input, ev as never);
    expect(honest.evidenceCheck.artifacts.readySourceGroups.verdict).toBe(
      "mismatch",
    );
    expect(honest.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");
    // The dataset binding is mandatory: a source-groups file from a
    // different frozen dataset is invalid evidence.
    ev.sourceGroups.document.groups["case-4"] = "group-c";
    ev.sourceGroups.document.datasetSha256 = "0".repeat(64);
    const wrongDataset = qualifyT6(input, ev as never);
    expect(wrongDataset.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("preregistration drift in alpha/minimum rejects the input", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.preregistration.document.analysisPolicy.alpha = 0.01;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("PREREGISTRATION_DRIFT");
    ev.preregistration.document.analysisPolicy.alpha = 0.05;
    ev.preregistration.document.analysisPolicy.minimumIndependentSourceGroups = 9;
    expect(
      qualifyT6(input, ev as never).blockedReasons,
    ).toContain("PREREGISTRATION_DRIFT");
  });

  it("full-consistency synthetic evidence produces all three states correctly", () => {
    // CONFIRMATORY_READY: every claim bound and matching.
    expect(run(grantedInput()).status).toBe("CONFIRMATORY_READY");
    // EXPLORATORY_ONLY: bound evidence consistent, confirmatory criteria unmet.
    const exploratory = run(
      grantedInput({
        readyIndependentSourceGroups: 5,
        analysisPolicy: {
          alpha: 0.05,
          minimumIndependentSourceGroups: 5,
          precisionTargetMet: true,
        },
      }),
    );
    expect(exploratory.status).toBe("EXPLORATORY_ONLY");
    expect(exploratory.t6Permissions.promotePossible).toBe(false);
    // BLOCKED: no real evidence.
    expect(qualifyT6(notRunInput()).status).toBe("BLOCKED");
  });

  it("structurally invalid inputs are refused, never guessed (rc-3)", () => {
    const bad = validateQualificationInput({
      readyIndependentSourceGroups: -1,
      analysisPolicy: { alpha: 0 },
      authorization: {},
      judgeModelCalibration: {},
      ownerBlindReview: {},
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(5);
    const result = qualifyT6({ readyIndependentSourceGroups: -1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.inputProblems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence semantics — review-hardening regression cases.
// ---------------------------------------------------------------------------

describe("evidence semantics hardening", () => {
  it("PASSED calibration with all-failed invocations is not success evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    for (const inv of ev.judgeCalibration.document.invocations)
      inv.status = "FAILED";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");
  });

  it("failed invocations still count as unauthorized calls without D2", () => {
    const input = grantedInput();
    input.authorization.d2Approved = false;
    const ev = resolvedFor(input) as Record<string, any>;
    for (const inv of ev.judgeCalibration.document.invocations)
      inv.status = "FAILED";
    ev.approvals.d2.document.approved = false;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain(
      "UNAUTHORIZED_MODEL_CALLS_RECORDED",
    );
  });

  it("a D5-scope approval record bound to the d2 slot is rejected", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d2.document.scope = "d5";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("an unbound preregistration blocks confirmatory qualification", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    delete ev.preregistration;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_MISSING_FOR_CLAIM");
  });

  it("precision evidence must be anchored to the preregistered target", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.judgeCalibration.document.precisionTarget = 0.5;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");
    delete ev.judgeCalibration.document.precisionTarget;
    const unanchored = qualifyT6(input, ev as never);
    expect(unanchored.status).toBe("BLOCKED");
    expect(unanchored.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("data-path authorization requires the agreed RAN_WITH_D6 probe state", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.admissionReport.document.realDataProbe.status = "NOT_RUN_WITHOUT_D6";
    const result = qualifyT6(input, ev as never);
    expect(result.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");
    ev.admissionReport.document.realDataProbe.status = "anything-else";
    expect(qualifyT6(input, ev as never).blockedReasons).toContain(
      "EVIDENCE_CLAIM_MISMATCH",
    );
  });

  it("source-groups must be the grouping the admission run recorded", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    // Two well-formed files, different recorded groupings: the doc's own
    // digest is honest but never what the admission run produced.
    ev.admissionReport.document.sourceGroups.digest = `sha256:${"d".repeat(64)}`;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
    expect(
      result.evidenceCheck.artifacts.readySourceGroups.groupingBindingMismatch,
    ).toBe(true);
    // A declared digest that no longer matches the artifact's own contents
    // is artifact-invalid BEFORE the cross-file comparison.
    const stale = resolvedFor(input) as Record<string, any>;
    stale.sourceGroups.document.digest = `sha256:${"d".repeat(64)}`;
    const tampered = qualifyT6(input, stale as never);
    expect(tampered.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
    expect(
      tampered.evidenceCheck.artifacts.readySourceGroups.contentDigestMismatch,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-2: calibration and blind-review facts must be re-derivable from the
// raw evidence — a report's own headline boolean proves nothing.
// ---------------------------------------------------------------------------

describe("calibration evidence re-derivation (P1-2)", () => {
  const flags = (result: any) =>
    result.evidenceCheck.artifacts.readySourceGroups ?? {};

  it("a calibration report missing its judge protocol digest is invalid evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    delete ev.judgeCalibration.document.judgeProtocolDigest;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("a calibration report bound to a DIFFERENT protocol digest is invalid evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.judgeCalibration.document.judgeProtocolDigest = `sha256:${"e".repeat(64)}`;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("a calibration report whose SUCCEEDED invocations ran a different model than the report claims is invalid", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    // The report says judgeModel X; one invocation actually ran model Y.
    ev.judgeCalibration.document.invocations[3].model = {
      provider: "other-provider",
      modelId: "other-model",
      version: "9.9.9",
    };
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("a declared PASSED precision target contradicted by the raw metrics is rejected", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    // Declared met + input claims met, but 3/4 of the raw calls disagree —
    // the RECOMPUTED agreement rate (0.25) is below the 0.9 target.
    const invocations = ev.judgeCalibration.document.invocations;
    for (let i = 0; i < Math.ceil(invocations.length * 0.75); i += 1)
      invocations[i].judgeVerdict = "B_BETTER";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");
    expect(result.evidenceCheck.artifacts.precisionTarget.recomputed).toBe(
      false,
    );
    expect(result.evidenceCheck.artifacts.precisionTarget.reportClaimed).toBe(
      true,
    );
  });

  it("a SUCCEEDED invocation without its position-exchange outcome is invalid evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    delete ev.judgeCalibration.document.invocations[7]
      .positionExchangeConsistent;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("duplicate invocation ids inside the calibration report are invalid evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.judgeCalibration.document.invocations[1].invocationId =
      ev.judgeCalibration.document.invocations[0].invocationId;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });
});

describe("owner blind-review evidence re-derivation (P1-2)", () => {
  it("a sample carrying only a sampleId (no actual judgments) is invalid evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.ownerBlindReview.document.samples[0] = { sampleId: "s-1" };
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("duplicate blind-review sample ids are invalid evidence (never double-counted)", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.ownerBlindReview.document.samples[1].sampleId =
      ev.ownerBlindReview.document.samples[0].sampleId;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("a recorded identity map that does not explain the recorded verdict is invalid", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    // The judge verdict says A won; the recorded restored verdict names the
    // reference — the blinding does not explain the record.
    ev.ownerBlindReview.document.samples[0].judgeRestoredVerdict =
      "REFERENCE_BETTER";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("an agreeing sample that carries a disagreement type is structurally invalid", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.ownerBlindReview.document.samples[0].disagreementType =
      "VERDICT_CONFLICT";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });
});

// ---------------------------------------------------------------------------
// P1-3: D2/D5/D6 approvals must bind the experiment parameters they froze;
// any mismatch with the actual evidence is an authorization violation.
// ---------------------------------------------------------------------------

describe("approval parameter binding (P1-3)", () => {
  it("D2 approved model A but the calibration ran model B → BLOCKED with the finding", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d2.document.parameters.model = {
      provider: "approved-provider",
      modelId: "approved-model",
      version: "1.2.3",
    };
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("authorized model approved-provider/approved-model/1.2.3");
  });

  it("D2 froze alpha 0.05 but the preregistration froze 0.01 → BLOCKED", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d2.document.parameters.alpha = 0.01;
    const result = qualifyT6(input, ev as never);
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("alpha=0.01");
  });

  it("D5 approved 40 sample pairs but only 20 were reviewed → BLOCKED", () => {
    const input = grantedInput({
      ownerBlindReview: { status: "PASSED", sampleCount: 20 },
    });
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d5.document.parameters.samplePairs = 40;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("40 blind-review sample pairs but only 20");
  });

  it("D6 authorized dataset A but the admission report probed dataset B → BLOCKED", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d6.document.parameters.datasetSha256 = "c".repeat(64);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    // The data-path gate also fails closed on the same inconsistency.
    expect(result.blockedReasons).toContain("DATA_PATH_AUTHORIZATION_INVALID");
  });

  it("a granted approval record missing its parameter block is non-interpretable", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    delete ev.approvals.d2.document.parameters;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
    // Per-key fragments of parameters fail the same way.
    const partial = resolvedFor(input) as Record<string, any>;
    delete partial.approvals.d6.document.parameters.retentionDays;
    expect(qualifyT6(input, partial as never).blockedReasons).toContain(
      "EVIDENCE_ARTIFACT_INVALID",
    );
    const noModel = resolvedFor(input) as Record<string, any>;
    delete noModel.approvals.d2.document.parameters.model;
    expect(qualifyT6(input, noModel as never).blockedReasons).toContain(
      "EVIDENCE_ARTIFACT_INVALID",
    );
  });

  it("D2 call budget exceeded by the actual calibration calls → BLOCKED", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d2.document.parameters.callBudget = 10;
    const result = qualifyT6(input, ev as never);
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("budget of 10");
  });

  it("an unauthorized experiment cannot grant itself permission by editing input booleans (P1-1)", () => {
    // The honest state claims every authorization but binds no records:
    // every affirmative boolean fails for lack of bound evidence.
    const forged = {
      ...notRunInput(),
      authorization: {
        dataPathAuthorizationValid: true,
        dataIntegrityValid: true,
        d2Approved: true,
        d5Approved: true,
        d6Approved: true,
      },
      judgeModelCalibration: { status: "PASSED", modelCallCount: 40 },
      ownerBlindReview: { status: "PASSED", sampleCount: 40 },
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 14,
        precisionTargetMet: true,
      },
      readyIndependentSourceGroups: 14,
    };
    const result = qualifyT6(forged);
    expect(result.status).toBe("BLOCKED");
    expect(result.t6Permissions.exploratoryT6Allowed).toBe(false);
    expect(result.t6Permissions.confirmatoryT6Allowed).toBe(false);
    expect(result.t6Permissions.promotePossible).toBe(false);
    expect(result.blockedReasons).toContain("EVIDENCE_MISSING_FOR_CLAIM");
  });
});

// ---------------------------------------------------------------------------
// P1-4: source-group record integrity — duplicates, session anchors and
// count consistency can never inflate the READY group count.
// ---------------------------------------------------------------------------

describe("source-group record integrity (P1-4)", () => {
  const flags = (result: any) =>
    result.evidenceCheck.artifacts.readySourceGroups ?? {};

  it("a duplicate caseId (INCOMPLETE then READY) is invalid — the later record cannot bury the earlier probe", () => {
    const input = grantedInput({ readyIndependentSourceGroups: 2 });
    const ev = resolvedFor(input) as Record<string, any>;
    const perSample = ev.admissionReport.document.perSample;
    perSample.push({
      ...perSample[0],
      completeness: "INCOMPLETE",
      pathReadiness: {
        PIPELINE_REPLAY: "BLOCKED",
        EXPECTATION_LABELING: "READY",
        BEHAVIOR_BRANCH: "READY",
      },
    });
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
    expect(flags(result).duplicateCase).toBe(perSample[0].caseId);
  });

  it("a duplicate caseId (READY then INCOMPLETE) is equally invalid — no overwrite in either direction", () => {
    const input = grantedInput({ readyIndependentSourceGroups: 2 });
    const ev = resolvedFor(input) as Record<string, any>;
    const perSample = ev.admissionReport.document.perSample;
    const incompleteClone = {
      ...perSample[0],
      completeness: "INCOMPLETE",
      pathReadiness: {
        PIPELINE_REPLAY: "BLOCKED",
        EXPECTATION_LABELING: "READY",
        BEHAVIOR_BRANCH: "READY",
      },
    };
    perSample.unshift(incompleteClone);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).duplicateCase).toBe(perSample[1].caseId);
  });

  it("a session-less case in a SHARED group is invalid (no provable common origin)", () => {
    const input = grantedInput({
      readyIndependentSourceGroups: 2,
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 2,
        precisionTargetMet: true,
      },
    });
    const ev = resolvedFor(input) as Record<string, any>;
    // Both cases lose their session anchor but stay in separate groups...
    const perSample = ev.admissionReport.document.perSample;
    perSample[0].sessionId = "";
    perSample[1].sessionId = "";
    // ...single-case groups are the producer's mechanical rule for
    // session-less cases, so the evidence stays VALID: both singleton
    // groups derive READY (the status may still be EXPLORATORY_ONLY for
    // statistical reasons — that is not an evidence defect).
    const separate = qualifyT6(input, ev as never);
    expect(separate.blockedReasons).toEqual([]);
    expect(separate.evidenceCheck.artifacts.readySourceGroups.derived).toBe(2);
    // ...but merging them into ONE group claims an independence violation:
    // no session anchor can prove the shared origin.
    const merged = resolvedFor(input) as Record<string, any>;
    merged.sourceGroups.document.groups = {
      "case-1": "group-a",
      "case-2": "group-a",
    };
    merged.sourceGroups.document.rationales = {
      "group-a": "synthetic: shared group",
    };
    merged.sourceGroups.document.digest = sourceGroupsDigestOf(
      merged.sourceGroups.document.groups,
      merged.sourceGroups.document.rationales,
    );
    merged.admissionReport.document.sourceGroups.digest =
      merged.sourceGroups.document.digest;
    merged.admissionReport.document.perSample[0].sessionId = "";
    merged.admissionReport.document.perSample[1].sessionId = "";
    const result = qualifyT6(input, merged as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
    expect(flags(result).sessionAnchorMissingSharedGroup).toBeTruthy();
  });

  it("a missing sessionId field is not silently skipped — the same shared-group rule applies", () => {
    const input = grantedInput({
      readyIndependentSourceGroups: 2,
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 2,
        precisionTargetMet: true,
      },
    });
    const ev = resolvedFor(input) as Record<string, any>;
    delete ev.admissionReport.document.perSample[0].sessionId;
    ev.admissionReport.document.perSample[1].sessionId = "";
    // Both anchor-less cases in separate singleton groups stay valid
    // evidence — no session check was silently skipped, the singleton rule
    // applied and both groups still derive READY.
    const result = qualifyT6(input, ev as never);
    expect(result.blockedReasons).toEqual([]);
    expect(result.evidenceCheck.artifacts.readySourceGroups.derived).toBe(2);
  });

  it("dataset.sampleCount disagreeing with the per-sample records is invalid", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.admissionReport.document.dataset.sampleCount = 99;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).countMismatch).toBe("dataset.sampleCount");
  });

  it("counts.caseCount disagreeing with the per-sample records is invalid", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.admissionReport.document.counts = { caseCount: 3 };
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).countMismatch).toBe("counts.caseCount");
  });

  it("extra mapping keys beyond the probed cases are invalid (count mismatch)", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    const groups = { ...ev.sourceGroups.document.groups };
    groups["case-ghost"] = "group-ghost";
    ev.sourceGroups.document.groups = groups;
    ev.sourceGroups.document.rationales["group-ghost"] = "synthetic: ghost";
    ev.sourceGroups.document.digest = sourceGroupsDigestOf(
      groups,
      ev.sourceGroups.document.rationales,
    );
    ev.admissionReport.document.sourceGroups.digest =
      ev.sourceGroups.document.digest;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    // The bidirectional check names the unknown case first.
    expect(flags(result).unknownCase).toBe("case-ghost");
  });
});

// ---------------------------------------------------------------------------
// P2-1: nMinAlpha null must fail closed — never silently coerced by
// JavaScript's relational comparison rules.
// ---------------------------------------------------------------------------

describe("nMinAlpha null boundary (P2-1)", () => {
  it("an exhausted n_min search is BLOCKED and nMeetsNMinAlpha is explicitly false (not >= null → true)", { timeout: 180_000 }, () => {
    const input = grantedInput({
      readyIndependentSourceGroups: 5,
      analysisPolicy: {
        alpha: 1e-310,
        minimumIndependentSourceGroups: 5,
        precisionTargetMet: true,
      },
    });
    const result = run(input);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("N_MIN_ALPHA_SEARCH_EXHAUSTED");
    expect(result.thresholds.nMinAlpha).toBeNull();
    // The bug this pins: 5 >= null coerces null to 0 and evaluates TRUE.
    expect(result.checks.nMeetsNMinAlpha).toBe(false);
    expect(result.unmetCriteria).not.toContain("BELOW_N_MIN_ALPHA");
  });

  it("n_min(alpha) boundary values remain exact at practical alphas", () => {
    expect(nMinForAlpha(0.05)).toBe(6);
    expect(nMinForAlpha(0.1)).toBe(5);
    expect(nMinForAlpha(0.01)).toBe(8);
    expect(nMinForAlpha(0.2)).toBe(4);
    expect(() => nMinForAlpha(0)).toThrow();
    expect(() => nMinForAlpha(1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// P1-6 (engine side): the positive RAN_WITH_D6 state is only accepted when
// the probe's dataset matches the D6-authorized dataset.
// ---------------------------------------------------------------------------

describe("D6 positive data-path binding (P1-6, engine side)", () => {
  it("a forged RAN_WITH_D6 over a dataset the D6 decision never authorized is rejected", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    // The report claims RAN_WITH_D6, the D6 decision authorized THIS
    // dataset — but the probe actually ran over a different one (the
    // probeScope echo is the authoritative record of what was probed).
    ev.admissionReport.document.realDataProbe.probeScope.datasetSha256 = "f".repeat(64);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("DATA_PATH_AUTHORIZATION_INVALID");
  });

  it("an honest RAN_WITH_D6 report whose d6Decision echo matches everything passes the data-path gate", () => {
    const result = run(grantedInput());
    expect(result.status).toBe("CONFIRMATORY_READY");
    expect(result.checks.dataPathAuthorizationValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Devin/CodeRabbit round-4 findings — evidence-binding regressions.
// ---------------------------------------------------------------------------

describe("review round-4 hardening (Devin/CodeRabbit)", () => {
  it("DV2/CR8: an UNSTABLE recheck fails the D5 stability gate even when every sample was rechecked", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.ownerBlindReview.document.samples[3].recheckStability = "UNSTABLE";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("not all STABLE");
  });

  it("DV3: UNKNOWN judge verdicts stay OUT of the position-flip denominator (no dilution)", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    const invocations = ev.judgeCalibration.document.invocations;
    // Half the calls are UNKNOWN (their reference verdicts are UNKNOWN too,
    // so agreement stays perfect) and "flipped"; the determinate half is
    // all consistent. Old behavior: flipRate 20/40 = 0.5 > 0.2 → mismatch.
    // Fixed behavior: UNKNOWN never enters the denominator → 0/20 = 0.
    for (let i = 0; i < invocations.length / 2; i += 1) {
      invocations[i].judgeVerdict = "UNKNOWN";
      invocations[i].referenceVerdict = "UNKNOWN";
      invocations[i].positionExchangeConsistent = false;
    }
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("CONFIRMATORY_READY");
    expect(result.blockedReasons).not.toContain("APPROVAL_PARAMETER_MISMATCH");
    // A genuinely flipped determinate half still exceeds the 0.2 cap.
    const flipped = resolvedFor(input) as Record<string, any>;
    const finv = flipped.judgeCalibration.document.invocations;
    for (let i = 0; i < finv.length / 2; i += 1)
      finv[i].positionExchangeConsistent = false;
    const flippedResult = qualifyT6(input, flipped as never);
    expect(flippedResult.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      flippedResult.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("position-flip rate");
  });

  it("DV3: all UNKNOWN outcomes leave the D5 position-flip rate unmeasured and block T6", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    for (const invocation of ev.judgeCalibration.document.invocations) {
      invocation.judgeVerdict = "UNKNOWN";
      invocation.referenceVerdict = "UNKNOWN";
    }
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("POSITION_FLIP_RATE_UNMEASURED");
  });

  it("DV4/CR7: reviewing the SAME package in the SAME order twice does not add sample pairs", () => {
    const input = grantedInput({ ownerBlindReview: { status: "PASSED", sampleCount: 40 } });
    const ev = resolvedFor(input) as Record<string, any>;
    const samples = ev.ownerBlindReview.document.samples;
    // Re-review pkg-1 (same displayOrder) under a fresh sampleId.
    const dupe = { ...samples[1], sampleId: "s-dup", packageId: samples[0].packageId };
    samples.push(dupe);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("DV5/CR9: a probe report citing a DIFFERENT D6 decision than the bound one is rejected", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.admissionReport.document.realDataProbe.d6Decision.sha256 = `sha256:${"a".repeat(63)}0`;
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("DATA_PATH_AUTHORIZATION_INVALID");
  });

  it("DV6: a FAILED invocation served by a model the report never declared is invalid evidence", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.judgeCalibration.document.invocations[0].status = "FAILED";
    ev.judgeCalibration.document.invocations[0].model = {
      provider: "off-book-provider",
      modelId: "off-book",
      version: "0",
    };
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("DV7: a bound artifact whose bytes are a bare JSON null degrades to BLOCKED, never a crash", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.admissionReport.document = null;
    ev.sourceGroups.document = null;
    let result;
    expect(() => {
      result = qualifyT6(input, ev as never);
    }).not.toThrow();
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toContain("EVIDENCE_ARTIFACT_INVALID");
  });

  it("CR6: the declared call count is the ACTUAL total — successes AND failures", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    // Isolate CR6 from the separately-tested D6 producer digest format.
    ev.admissionReport.document.realDataProbe.d6Decision.sha256 =
      ev.approvals.d6.sha256;
    const invocations = ev.judgeCalibration.document.invocations;
    // 39 succeeded + 1 failed, input declares 40 total calls: the audit
    // total matches (the old succeeded-only comparison rejected this).
    invocations[0].status = "FAILED";
    const result = qualifyT6(input, ev as never);
    expect(result.evidenceCheck.artifacts.judgeCalibration.verdict).toBe(
      "match",
    );
    expect(result.status).toBe("CONFIRMATORY_READY");
    // Declaring 39 against 40 actual calls (same evidence) is a mismatch.
    const under = JSON.parse(JSON.stringify(input));
    under.judgeModelCalibration.modelCallCount = 39;
    const underResult = qualifyT6(under, ev as never);
    expect(underResult.blockedReasons).toContain("EVIDENCE_CLAIM_MISMATCH");

    // An untrusted auditCallCount input must never override the declared
    // modelCallCount. The derived audit total comes only from raw invocations.
    const masked = JSON.parse(JSON.stringify(input));
    masked.judgeModelCalibration.modelCallCount = 39;
    masked.judgeModelCalibration.auditCallCount = 40;
    // Keep this CR6 assertion isolated from the separate D6 digest-format
    // regression: the pre-fix comparison expected the prefixed form here.
    const maskedEvidence = JSON.parse(JSON.stringify(ev));
    maskedEvidence.admissionReport.document.realDataProbe.d6Decision.sha256 =
      maskedEvidence.approvals.d6.sha256;
    const maskedResult = qualifyT6(masked, maskedEvidence as never);
    expect(maskedResult.ok).toBe(false);
    expect(maskedResult.inputProblems.join(" ")).toContain(
      "auditCallCount is derived from the bound calibration evidence",
    );
  });

  it("DV8: a D6 decision pinning a trajectory snapshot rejects a report read from another snapshot", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d6.document.parameters.trajectoryDbSha256 = "9".repeat(64);
    ev.admissionReport.document.snapshot = {
      consistencyStatus: "CONSISTENT_WITHIN_WINDOW",
      trajectoryDb: { sha256: "8".repeat(64) },
    };
    const result = qualifyT6(input, ev as never);
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("pinned trajectory snapshot");
  });

  it("CR10: a D2 preregistration digest in bare hex matches the prefixed evidence binding", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d2.document.parameters.preregistrationSha256 =
      FAKE_SHA.slice("sha256:".length);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("CONFIRMATORY_READY");
    expect(result.blockedReasons).not.toContain("APPROVAL_PARAMETER_MISMATCH");
  });

  it("CR10: a D2 decision that freezes the preregistration digest rejects a swapped registration", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.approvals.d2.document.parameters.preregistrationSha256 = "7".repeat(64);
    const result = qualifyT6(input, ev as never);
    expect(result.blockedReasons).toContain("APPROVAL_PARAMETER_MISMATCH");
    expect(
      result.evidenceCheck.approvalParameterBinding.findings.join(" "),
    ).toContain("froze preregistration");
    // Without the digest binding the limitation is DISCLOSED, not blocking.
    const unbound = resolvedFor(input) as Record<string, any>;
    delete unbound.approvals.d2.document.parameters.preregistrationSha256;
    const unboundResult = qualifyT6(input, unbound as never);
    expect(unboundResult.status).toBe("CONFIRMATORY_READY");
    expect(
      unboundResult.disclosures.map((d: { code: string }) => d.code),
    ).toContain("PREREGISTRATION_IDENTITY_UNBOUND");
  });
});

// ---------------------------------------------------------------------------
// P2-2: artifactRef is a relative path inside the input file's directory.
// Traversal, absolute paths and symlink escapes are verification failures.
// ---------------------------------------------------------------------------

describe("t6-qualify artifactRef path security (P2-2)", () => {
  const setupDirs = (name: string) => {
    const dir = fs.mkdtempSync(path.join(tempRoot, `p22-${name}-`));
    const outside = fs.mkdtempSync(path.join(tempRoot, `p22-outside-${name}-`));
    return { dir, outside };
  };
  const writeInputWithD2Ref = (dir: string, artifactRef: string) => {
    const input = {
      ...notRunInput(),
      evidence: {
        approvals: { d2: { artifactRef, sha256: FAKE_SHA } },
      },
    };
    const file = path.join(dir, "qualification-input.json");
    fs.writeFileSync(file, JSON.stringify(input, null, 2), "utf8");
    const out = path.join(dir, "out");
    return { file, out };
  };
  const problemOf = (out: string) => {
    const verification = JSON.parse(
      fs.readFileSync(path.join(out, "evidence-verification.json"), "utf8"),
    );
    return verification.artifacts["approvals.d2"].problem ?? null;
  };

  it("a parent-traversal artifactRef (../) is rejected before any read", () => {
    const { dir, outside } = setupDirs("traversal");
    fs.writeFileSync(path.join(outside, "d2.json"), "{}", "utf8");
    // The exact relative escape regardless of tmp naming (forward slashes
    // keep the ref in the "relative with .." class on both platforms).
    const rel = path.relative(dir, path.join(outside, "d2.json"));
    const input = {
      ...notRunInput(),
      evidence: { approvals: { d2: { artifactRef: rel, sha256: FAKE_SHA } } },
    };
    const file = path.join(dir, "qualification-input.json");
    fs.writeFileSync(file, JSON.stringify(input, null, 2), "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    expect(run.status).toBe(1);
    expect(problemOf(out)).toContain("parent traversal");
  });

  it("absolute artifactRefs are rejected (POSIX root and Windows drive forms)", () => {
    const { dir } = setupDirs("absolute");
    for (const ref of ["/etc/passwd", "C:\\Windows\\system32\\config.json"]) {
      const suffix = ref.replace(/[^a-z]+/gi, "-");
      const out = path.join(dir, `out-${suffix}`);
      const input = {
        ...notRunInput(),
        evidence: { approvals: { d2: { artifactRef: ref, sha256: FAKE_SHA } } },
      };
      const file = path.join(dir, `input-${suffix}.json`);
      fs.writeFileSync(file, JSON.stringify(input, null, 2), "utf8");
      const run = runQualifyCli(["--input", file, "--out", out]);
      expect(run.status, ref).toBe(1);
      expect(problemOf(out), ref).toMatch(/absolute|drive-qualified/);
    }
  });

  it("a symlink inside the evidence directory that escapes it is rejected", (ctx) => {
    const { dir, outside } = setupDirs("symlink");
    const target = path.join(outside, "d2.json");
    fs.writeFileSync(target, "{}", "utf8");
    const link = path.join(dir, "d2-link.json");
    try {
      fs.symlinkSync(target, link, "file");
    } catch {
      // Windows without symlink privilege — the containment gate cannot be
      // exercised here; the traversal/absolute gates above still cover the
      // escaping-path classes this environment can create.
      ctx.skip();
      return;
    }
    const { file, out } = writeInputWithD2Ref(dir, "d2-link.json");
    const run = runQualifyCli(["--input", file, "--out", out]);
    expect(run.status).toBe(1);
    expect(problemOf(out)).toContain("escapes the evidence root");
  });

  it("a legitimately nested relative path inside the evidence root resolves normally", () => {
    const { dir } = setupDirs("nested");
    fs.mkdirSync(path.join(dir, "nested", "dir"), { recursive: true });
    const doc = {
      kind: "owner-decision",
      approved: false,
      decidedBy: "O1",
      decidedAt: "2026-11-22T00:00:00Z",
      scope: "d2",
    };
    const docPath = path.join(dir, "nested", "dir", "d2.json");
    fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const sha = `sha256:${createHash("sha256").update(fs.readFileSync(docPath)).digest("hex")}`;
    const input = {
      ...notRunInput(),
      evidence: {
        approvals: { d2: { artifactRef: "nested/dir/d2.json", sha256: sha } },
      },
    };
    const file = path.join(dir, "qualification-input.json");
    fs.writeFileSync(file, JSON.stringify(input, null, 2), "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    expect(run.status).toBe(0); // BLOCKED verdict is a valid computed outcome
    const verification = JSON.parse(
      fs.readFileSync(path.join(out, "evidence-verification.json"), "utf8"),
    );
    expect(verification.artifacts["approvals.d2"].verified).toBe(true);
    const qualification = JSON.parse(
      fs.readFileSync(path.join(out, "qualification.json"), "utf8"),
    );
    expect(qualification.status).toBe("BLOCKED");
    expect(qualification.blockedReasons).toContain("D2_NOT_APPROVED");
  });
});

// ---------------------------------------------------------------------------
// CLI (real subprocess).
// ---------------------------------------------------------------------------

describe("t6-qualify CLI", () => {
  // Writes every bound evidence artifact next to the input file and fixes
  // each declared sha256 to the artifact's ACTUAL digest (the only honest
  // fixture path — the CLI recomputes it from the bytes).
  function writeEvidence(dir: string, input: Record<string, any>) {
    const resolved = resolvedFor(input) as Record<string, any>;
    // Fixture refs are always plain filenames inside the temp dir — the
    // basename guard keeps the write provably contained (the CLI's own
    // path-safety rules live in t6-qualify.mjs and are tested separately).
    const bind = (binding: { artifactRef: string; sha256: string }, doc: unknown) => {
      if (path.basename(binding.artifactRef) !== binding.artifactRef)
        throw new Error(`fixture artifactRef must be a plain filename: ${binding.artifactRef}`);
      const filePath = path.join(dir, path.basename(binding.artifactRef));
      fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      const actual = `sha256:${createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex")}`;
      binding.sha256 = actual;
    };
    // Approvals first: the admission report echoes the D6 file digest in
    // the producer's bare-hex format; evidence bindings retain sha256: prefix.
    for (const key of ["d2", "d5", "d6"]) {
      if (input.evidence?.approvals?.[key])
        bind(input.evidence.approvals[key], resolved.approvals[key].document);
    }
    if (
      input.evidence?.approvals?.d6 &&
      resolved.admissionReport.document.realDataProbe?.status === "RAN_WITH_D6"
    ) {
      resolved.admissionReport.document.realDataProbe.d6Decision.sha256 =
        input.evidence.approvals.d6.sha256.slice("sha256:".length);
    }
    for (const key of [
      "sourceGroups",
      "admissionReport",
      "preregistration",
      "judgeCalibration",
      "ownerBlindReview",
    ]) {
      if (input.evidence?.[key]) bind(input.evidence[key], resolved[key].document);
    }
    return input;
  }

  function runOn(name: string, input: unknown, writeFiles = false) {
    const dir = path.join(tempRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "input.json");
    const holder = input as Record<string, any>;
    if (writeFiles && holder.evidence) writeEvidence(dir, holder);
    fs.writeFileSync(file, `${JSON.stringify(holder, null, 2)}\n`, "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    const reportPath = path.join(out, "qualification.json");
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
      : null;
    const verificationPath = path.join(out, "evidence-verification.json");
    const verification = fs.existsSync(verificationPath)
      ? JSON.parse(fs.readFileSync(verificationPath, "utf8"))
      : null;
    return { run, report, verification, dir, out, file };
  }

  it(
    "computes a BLOCKED verdict with exit 0 and a deterministic report",
    { timeout: 30_000 },
    () => {
      const first = runOn("blocked-first", notRunInput());
      expect(first.run.status).toBe(0);
      const summary = JSON.parse(first.run.stdout.trim());
      expect(summary.status).toBe("BLOCKED");
      expect(summary.blockedReasons).toContain("D2_NOT_APPROVED");
      expect(summary.t6Permissions.promotePossible).toBe(false);
      expect(first.report.status).toBe("BLOCKED");
      expect(first.report.inputs.judgeModelCalibration.modelCallCount).toBe(0);
      // Deterministic rerun: byte-identical qualification.json.
      const second = runOn("blocked-second", notRunInput());
      expect(second.run.status).toBe(0);
      expect(
        fs.readFileSync(path.join(first.out, "qualification.json"), "utf8"),
      ).toBe(
        fs.readFileSync(path.join(second.out, "qualification.json"), "utf8"),
      );
    },
  );

  it("computes CONFIRMATORY_READY when every gate is granted AND evidence-bound", () => {
    const { run, report } = runOn("confirmatory", grantedInput(), true);
    expect(run.status).toBe(0);
    expect(report.status).toBe("CONFIRMATORY_READY");
    expect(report.thresholds.kAtReadyN).toBe(12);
    expect(report.t6Permissions.promotePossible).toBe(true);
    // Every bound artifact was byte-verified.
    const check = report.evidenceCheck;
    expect(check.artifacts.readySourceGroups.verdict).toBe("match");
    expect(check.artifacts.judgeCalibration.verdict).toBe("match");
    // Affirmative claims without bound evidence are never trusted: the same
    // declarations WITHOUT an evidence block are mechanically BLOCKED.
    const { evidence: _drop, ...rest } = grantedInput();
    const unbound = runOn("confirmatory-unbound", rest);
    expect(unbound.run.status).toBe(0);
    expect(unbound.report.status).toBe("BLOCKED");
    expect(unbound.report.blockedReasons).toContain(
      "EVIDENCE_MISSING_FOR_CLAIM",
    );
  });

  it("exits 1 when a bound artifact's bytes do not match its declared sha256 (tamper rejected)", () => {
    const dir = path.join(tempRoot, "tampered-evidence");
    fs.mkdirSync(dir, { recursive: true });
    const input = grantedInput();
    writeEvidence(dir, input as Record<string, any>);
    // Tamper: rewrite the approval doc but keep the declared sha256 — the
    // recomputed digest must reject it.
    fs.writeFileSync(
      path.join(dir, "d2.json"),
      `${JSON.stringify({ kind: "owner-decision", approved: false, decidedBy: "O1", decidedAt: "2026-11-21T00:00:00Z", scope: "d2" })}\n`,
      "utf8",
    );
    const file = path.join(dir, "input.json");
    fs.writeFileSync(file, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    expect(run.status).toBe(1);
    expect(fs.existsSync(path.join(out, "qualification.json"))).toBe(false);
    const verification = JSON.parse(
      fs.readFileSync(path.join(out, "evidence-verification.json"), "utf8"),
    );
    expect(verification.ok).toBe(false);
    expect(verification.artifacts["approvals.d2"].verified).toBe(false);
    // A missing artifact file fails the same way.
    const dir2 = path.join(tempRoot, "missing-evidence");
    fs.mkdirSync(dir2, { recursive: true });
    const file2 = path.join(dir2, "input.json");
    fs.writeFileSync(file2, `${JSON.stringify(grantedInput(), null, 2)}\n`, "utf8");
    const run2 = runQualifyCli(["--input", file2, "--out", path.join(dir2, "out")]);
    expect(run2.status).toBe(1);
  });

  it("exits 1 on structurally invalid input without writing output", () => {
    const { run, report } = runOn("invalid", {
      readyIndependentSourceGroups: "many",
    });
    expect(run.status).toBe(1);
    expect(report).toBeNull();
    expect(run.stderr).toContain("structurally invalid");
  });

  it(
    "exits 2 on usage errors and unreadable input",
    { timeout: 30_000 },
    () => {
      expect(runQualifyCli(["--input"]).status).toBe(2);
      expect(runQualifyCli(["--wat", "x", "--out", "y"]).status).toBe(2);
      expect(
        runQualifyCli([
          "--input",
          path.join(tempRoot, "missing.json"),
          "--out",
          path.join(tempRoot, "missing-out"),
        ]).status,
      ).toBe(2);
      const dir = path.join(tempRoot, "write-once");
      fs.mkdirSync(path.join(dir, "out"), { recursive: true });
      const file = path.join(dir, "input.json");
      fs.writeFileSync(file, `${JSON.stringify(notRunInput())}\n`, "utf8");
      expect(
        runQualifyCli(["--input", file, "--out", path.join(dir, "out")]).status,
      ).toBe(2);
    },
  );
});

// ---------------------------------------------------------------------------
// P2-3 / P2-4: structural checks run BEFORE any path or filesystem touch.
// ---------------------------------------------------------------------------

describe("t6-qualify CLI input-structure gates (P2-3, P2-4)", () => {
  function writeEvidenceFiles(dir: string, input: Record<string, any>) {
    const resolved = resolvedFor(input) as Record<string, any>;
    // Same containment guard as the CLI suite's writeEvidence (fixture refs
    // are plain filenames; the CLI's own path rules are under test, not
    // bypassed here).
    const bind = (binding: { artifactRef: string; sha256: string }, doc: unknown) => {
      if (path.basename(binding.artifactRef) !== binding.artifactRef)
        throw new Error(`fixture artifactRef must be a plain filename: ${binding.artifactRef}`);
      const filePath = path.join(dir, path.basename(binding.artifactRef));
      fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      binding.sha256 = `sha256:${createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex")}`;
    };
    for (const key of ["d2", "d5", "d6"]) {
      if (input.evidence?.approvals?.[key])
        bind(input.evidence.approvals[key], resolved.approvals[key].document);
    }
    if (
      input.evidence?.approvals?.d6 &&
      resolved.admissionReport.document.realDataProbe?.status === "RAN_WITH_D6"
    ) {
      resolved.admissionReport.document.realDataProbe.d6Decision.sha256 =
        input.evidence.approvals.d6.sha256.slice("sha256:".length);
    }
    for (const key of [
      "sourceGroups",
      "admissionReport",
      "preregistration",
      "judgeCalibration",
      "ownerBlindReview",
    ]) {
      if (input.evidence?.[key]) bind(input.evidence[key], resolved[key].document);
    }
    return input;
  }

  function runOn(name: string, input: unknown, writeFiles = false) {
    const dir = path.join(tempRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "input.json");
    const holder = input as Record<string, any>;
    if (writeFiles && holder.evidence) writeEvidenceFiles(dir, holder);
    fs.writeFileSync(file, `${JSON.stringify(holder, null, 2)}\n`, "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    return { run, dir, out };
  }

  it("a non-string artifactRef is a named problem, never a TypeError (P2-3)", () => {
    const input = grantedInput() as Record<string, any>;
    const dir = path.join(tempRoot, "bad-artifactref");
    fs.mkdirSync(dir, { recursive: true });
    writeEvidenceFiles(dir, input);
    input.evidence.sourceGroups.artifactRef = 42;
    const file = path.join(dir, "input.json");
    fs.writeFileSync(file, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain("TypeError");
    // The malformed binding is rejected by the input-structure gate: named
    // problem on stderr, and no verdict is ever written.
    expect(run.stderr).toContain("artifactRef");
    expect(fs.existsSync(path.join(out, "qualification.json"))).toBe(false);
  });

  it("structurally invalid input writes nothing and exits 1 (P2-4)", () => {
    const { run, out } = runOn("invalid-input", { garbage: true });
    expect(run.status).toBe(1);
    expect(run.stderr).not.toContain("TypeError");
    // The out directory is created only after the evidence layer verifies —
    // an input that fails its own structure check leaves zero artifacts.
    expect(fs.existsSync(out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-2: no edit to the recorded grouping, rationale set or case mapping can
// silently preserve (or inflate) the claimed effective sample size.
// ---------------------------------------------------------------------------

describe("source-group artifacts that cannot produce a false sample size (P1-2)", () => {
  const flags = (result: any) =>
    result.evidenceCheck.artifacts.readySourceGroups;
  const honestRebind = (ev: Record<string, any>) => {
    ev.sourceGroups.document.digest = sourceGroupsDigestOf(
      ev.sourceGroups.document.groups,
      ev.sourceGroups.document.rationales,
    );
    ev.admissionReport.document.sourceGroups.digest =
      ev.sourceGroups.document.digest;
  };

  it("tampered groups with the ORIGINAL digest are caught by the recompute", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.sourceGroups.document.groups["case-2"] = "group-a"; // merge two groups
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).contentDigestMismatch).toBe(true);
  });

  it("tampered rationales with the ORIGINAL digest are caught by the recompute", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.sourceGroups.document.rationales = { "group-a": "invented rationale" };
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).contentDigestMismatch).toBe(true);
  });

  it("tampered groups with an HONESTLY recomputed digest still fail the admission binding", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.sourceGroups.document.groups["case-2"] = "group-a";
    ev.sourceGroups.document.digest = sourceGroupsDigestOf(
      ev.sourceGroups.document.groups,
      ev.sourceGroups.document.rationales,
    );
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).contentDigestMismatch).toBeFalsy();
    expect(flags(result).groupingBindingMismatch).toBe(true);
  });

  it("one session split across two groups is rejected — never counted twice", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.sourceGroups.document.groups["case-2"] = "group-c"; // second group
    honestRebind(ev);
    // case-1 and case-2 now sit in different groups but share one session.
    ev.admissionReport.document.perSample[1].sessionId = "sess-case-1";
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).sessionSplit).toBe("sess-case-1");
  });

  it("a deleted case mapping is an unmapped case, not a silent n-1", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    delete ev.sourceGroups.document.groups["case-2"];
    honestRebind(ev);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).unmappedCase).toBe("case-2");
  });

  it("a mapping pointing at an unknown case is rejected", () => {
    const input = grantedInput();
    const ev = resolvedFor(input) as Record<string, any>;
    ev.sourceGroups.document.groups["case-ghost"] = "group-z";
    honestRebind(ev);
    const result = qualifyT6(input, ev as never);
    expect(result.status).toBe("BLOCKED");
    expect(flags(result).unknownCase).toBe("case-ghost");
  });
});
