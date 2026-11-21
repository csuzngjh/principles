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
    },
    judgeModelCalibration: { status: "PASSED", modelCallCount: 40 },
    ownerBlindReview: { status: "PASSED", sampleCount: 40 },
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
    expect(qualifyT6(policy(0.1)).status).toBe("CONFIRMATORY_READY"); // n_min(0.10) = 5
    expect(qualifyT6(policy(0.05)).status).toBe("EXPLORATORY_ONLY"); // n_min(0.05) = 6 > 5
    // The verdict always echoes the alpha it used, so drift is visible.
    expect(qualifyT6(policy(0.1)).thresholds.alpha).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Three qualification states (task P3, DT-08 / DT-09).
// ---------------------------------------------------------------------------

describe("qualifyT6 states", () => {
  it("all gates granted at n = 14 (min 14) -> CONFIRMATORY_READY with exact k", () => {
    const result = qualifyT6(grantedInput());
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
      qualifyT6(
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
      const result = qualifyT6(input);
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
    const result1 = qualifyT6(noD2WithCalls);
    expect(result1.status).toBe("BLOCKED");
    expect(result1.blockedReasons).toContain("D2_NOT_APPROVED");
    const noD2WithRecordedCalls = setPath(
      grantedInput({
        judgeModelCalibration: { status: "PASSED", modelCallCount: 3 },
      }),
      "authorization.d2Approved",
      false,
    );
    const result2 = qualifyT6(noD2WithRecordedCalls);
    expect(result2.blockedReasons).toContain(
      "UNAUTHORIZED_MODEL_CALLS_RECORDED",
    );
    const noD5WithSamples = setPath(
      grantedInput({ ownerBlindReview: { status: "PASSED", sampleCount: 2 } }),
      "authorization.d5Approved",
      false,
    );
    expect(qualifyT6(noD5WithSamples).blockedReasons).toContain(
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
        setPath(grantedInput(), "ownerBlindReview.status", "NOT_RUN"),
        ["OWNER_BLIND_REVIEW_NOT_PASSED"],
      ],
    ];
    for (const [label, input, criteria] of cases) {
      const result = qualifyT6(input);
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
    expect(qualifyT6(base).t6Permissions.exploratoryT6Allowed).toBe(false);
    expect(
      qualifyT6({ ...base, d2ExploratoryApproval: true }).t6Permissions
        .exploratoryT6Allowed,
    ).toBe(true);
    // Even with the exploratory approval, PROMOTE stays impossible.
    expect(
      qualifyT6({ ...base, d2ExploratoryApproval: true }).t6Permissions
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
    const fixtures: ReturnType<typeof grantedInput>[] = [
      notRunInput(),
      setPath(
        grantedInput(),
        "authorization.dataPathAuthorizationValid",
        false,
      ),
      setPath(grantedInput(), "authorization.dataIntegrityValid", false),
      grantedInput({ readyIndependentSourceGroups: 0 }),
      setPath(grantedInput(), "authorization.d2Approved", false),
      setPath(grantedInput(), "authorization.d5Approved", false),
      setPath(grantedInput(), "judgeModelCalibration.status", "FAILED"),
      setPath(
        grantedInput({
          judgeModelCalibration: { status: "PASSED", modelCallCount: 3 },
        }),
        "authorization.d2Approved",
        false,
      ),
      setPath(
        grantedInput({
          ownerBlindReview: { status: "PASSED", sampleCount: 2 },
        }),
        "authorization.d5Approved",
        false,
      ),
      grantedInput({
        readyIndependentSourceGroups: 5,
        analysisPolicy: {
          alpha: 0.05,
          minimumIndependentSourceGroups: 5,
          precisionTargetMet: true,
        },
      }),
      grantedInput({
        readyIndependentSourceGroups: 6,
        analysisPolicy: {
          alpha: 0.05,
          minimumIndependentSourceGroups: 14,
          precisionTargetMet: true,
        },
      }),
      setPath(grantedInput(), "analysisPolicy.precisionTargetMet", false),
      setPath(grantedInput(), "ownerBlindReview.status", "NOT_RUN"),
    ];
    const emitted = new Set<string>();
    for (const input of fixtures) {
      const result = qualifyT6(input);
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
    const first = qualifyT6(input);
    const second = qualifyT6(JSON.parse(JSON.stringify(input)));
    expect(second).toEqual(first);
    expect(first.inputs).toEqual(input);
    expect(first.status).toBe("EXPLORATORY_ONLY");
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
  function runOn(name: string, input: unknown) {
    const dir = path.join(tempRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "input.json");
    fs.writeFileSync(file, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    const out = path.join(dir, "out");
    const run = runQualifyCli(["--input", file, "--out", out]);
    const reportPath = path.join(out, "qualification.json");
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
      : null;
    return { run, report, dir, out, file };
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

  it("computes CONFIRMATORY_READY when every gate is granted", () => {
    const { run, report } = runOn("confirmatory", grantedInput());
    expect(run.status).toBe(0);
    expect(report.status).toBe("CONFIRMATORY_READY");
    expect(report.thresholds.kAtReadyN).toBe(12);
    expect(report.t6Permissions.promotePossible).toBe(true);
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
