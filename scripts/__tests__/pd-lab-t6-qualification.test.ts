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
import { twoSidedThreshold } from "../dev/pd-lab/alignment-report.mjs";
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

const APPROVAL_DOC = (approved: boolean, scope: string) => ({
  kind: "owner-decision",
  approved,
  decidedBy: "O1",
  decidedAt: "2026-11-21T00:00:00Z",
  scope,
});

const DATASET_SHA = "b".repeat(64);

/** Synthetic resolved evidence docs matching a granted input's claims. */
function resolvedFor(input: Record<string, any>) {
  const n = input.readyIndependentSourceGroups;
  const cases = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`case-${i + 1}`, `group-${i + 1}`]),
  );
  const perSample = Object.keys(cases).map((caseId) => ({
    caseId,
    completeness: "COMPLETE_FOR_ANALYSIS",
    pathReadiness: {
      PIPELINE_REPLAY: "READY",
      EXPECTATION_LABELING: "READY",
      BEHAVIOR_BRANCH: "READY",
    },
  }));
  return {
    sourceGroups: {
      artifactRef: "source-groups.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-source-groups.v1",
        datasetSha256: DATASET_SHA,
        groups: cases,
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
        realDataProbe: { status: "RAN_WITH_D6" },
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
        },
        exploratory: false,
      },
    },
    judgeCalibration: {
      artifactRef: "judge-calibration.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-judge-calibration.v1",
        status: input.judgeModelCalibration.status,
        invocations: Array.from(
          { length: input.judgeModelCalibration.modelCallCount },
          (_, i) => ({ invocationId: `inv-${i + 1}`, status: "SUCCEEDED" }),
        ),
        precisionTargetMet: input.analysisPolicy.precisionTargetMet,
      },
    },
    ownerBlindReview: {
      artifactRef: "owner-review.json",
      sha256: FAKE_SHA,
      document: {
        schema: "pd-lab-owner-blind-review.v1",
        status: input.ownerBlindReview.status,
        samples: Array.from(
          { length: input.ownerBlindReview.sampleCount },
          (_, i) => ({ sampleId: `s-${i + 1}` }),
        ),
      },
    },
    approvals: {
      d2: {
        artifactRef: "d2.json",
        sha256: FAKE_SHA,
        document: APPROVAL_DOC(input.authorization.d2Approved, "d2"),
      },
      d5: {
        artifactRef: "d5.json",
        sha256: FAKE_SHA,
        document: APPROVAL_DOC(input.authorization.d5Approved, "d5"),
      },
      d6: {
        artifactRef: "d6.json",
        sha256: FAKE_SHA,
        document: APPROVAL_DOC(input.authorization.d6Approved === true, "d6"),
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

  it("exploratory T6 requires an explicit D2 exploratory approval on top", () => {
    const base = grantedInput({
      readyIndependentSourceGroups: 5,
      analysisPolicy: {
        alpha: 0.05,
        minimumIndependentSourceGroups: 5,
        precisionTargetMet: true,
      },
      ownerBlindReview: { status: "NOT_RUN", sampleCount: 0 },
    });
    expect(run(base).t6Permissions.exploratoryT6Allowed).toBe(false);
    expect(
      run({ ...base, d2ExploratoryApproval: true }).t6Permissions
        .exploratoryT6Allowed,
    ).toBe(true);
    // Even with the exploratory approval, PROMOTE stays impossible.
    expect(
      run({ ...base, d2ExploratoryApproval: true }).t6Permissions
        .promotePossible,
    ).toBe(false);
  });

  it("today's honest state (no D2/D5/D6) is mechanically BLOCKED", () => {
    const result = qualifyT6(notRunInput());
    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReasons).toEqual([
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

  it("closed-set round-trip: every reason code is triggered, none outside the list (ERR-146)", () => {
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
    const fixtures: Array<[ReturnType<typeof grantedInput>, unknown]> = [
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
      [setPath(grantedInput(), "authorization.d6Approved", false), "resolved"],
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
    ev.admissionReport.document.perSample = [
      { caseId: "case-1", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "READY", BEHAVIOR_BRANCH: "READY" } },
      { caseId: "case-2", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "READY", BEHAVIOR_BRANCH: "READY" } },
      { caseId: "case-3", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "READY", BEHAVIOR_BRANCH: "READY" } },
      { caseId: "case-4", completeness: "COMPLETE_FOR_ANALYSIS", pathReadiness: { PIPELINE_REPLAY: "READY", EXPECTATION_LABELING: "BLOCKED", BEHAVIOR_BRANCH: "READY" } },
    ];
    const result = qualifyT6(input, ev as never);
    expect(result.evidenceCheck.artifacts.readySourceGroups.derived).toBe(2);
    expect(result.evidenceCheck.artifacts.readySourceGroups.readyGroupIds).toEqual(
      ["group-a", "group-b"],
    );
    // Declared 2 == derived 2 -> the count stands; dropping a case to a
    // non-READY group makes the declaration wrong and is rejected.
    ev.sourceGroups.document.groups["case-4"] = "group-b";
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
// CLI (real subprocess).
// ---------------------------------------------------------------------------

describe("t6-qualify CLI", () => {
  // Writes every bound evidence artifact next to the input file and fixes
  // each declared sha256 to the artifact's ACTUAL digest (the only honest
  // fixture path — the CLI recomputes it from the bytes).
  function writeEvidence(dir: string, input: Record<string, any>) {
    const resolved = resolvedFor(input) as Record<string, any>;
    const bind = (binding: { artifactRef: string; sha256: string }, doc: unknown) => {
      const filePath = path.join(dir, binding.artifactRef);
      fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      const actual = `sha256:${createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex")}`;
      binding.sha256 = actual;
    };
    for (const key of [
      "sourceGroups",
      "admissionReport",
      "preregistration",
      "judgeCalibration",
      "ownerBlindReview",
    ]) {
      if (input.evidence?.[key]) bind(input.evidence[key], resolved[key].document);
    }
    for (const key of ["d2", "d5", "d6"]) {
      if (input.evidence?.approvals?.[key])
        bind(input.evidence.approvals[key], resolved.approvals[key].document);
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
