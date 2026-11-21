// PRI-1258 / PD-Lab v0.3 T7a-judge — versioned Judge Protocol contract tests.
//
// Drives the pure module (scripts/dev/pd-lab/judge-protocol.mjs) AND the real
// CLI (scripts/dev/pd-lab/judge-protocol-validate.mjs, the `npm run
// lab:judge-validate` entry) as a subprocess over synthetic bundles. No real
// model calls (D2 not granted — the live judge-model calibration stays
// NOT_RUN), no real full-fidelity data, no network.
//
// Coverage required by the task card / HANDOFF T7a item 3 (layer 1):
//  1. protocol schema — closed-set round-trip of every record problem code
//     (ERR-146: no dead codes, no unlisted codes);
//  2. four-value result parsing incl. UNKNOWN reason validation;
//  3. illegal output fail-closed — never coerced to TIE;
//  4. comparison input digest consistency (recompute + tamper detection);
//  5. blindpack leak checks (arm tokens, worktree paths, arm-word values);
//  6. A/B position exchange (SC-09) and candidate/reference identity
//     restoration, incl. conflicting records and unresolved conflicts (SC-10);
//  7. failed-attempt preservation (audit trail, never votes);
//  8. arbitration: complete binding resolves, incomplete stays UNKNOWN;
//  9. deterministic merge through the REAL T4 authority (mergeJudgments) —
//     protocol records are drop-in T4 inputs;
// 10. lossyInput marking + truncation facts + lossy verdict must be UNKNOWN;
// 11. reproducibility: identical bundles validate to byte-identical reports;
// 12. purity: no fs / process.env / Date in the pure modules.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JUDGE_PROTOCOL,
  JUDGE_PROTOCOL_REF,
  JUDGE_OUTPUT_PROBLEM_CODES,
  PROTOCOL_RECORD_PROBLEM_CODES,
  parseJudgeResponse,
  buildJudgePackage,
  swapJudgePackage,
  checkPackageForLeaks,
  comparisonInputDigestOf,
  buildProtocolRecord,
  validateProtocolRecord,
  restoreDisplayVerdict,
  judgeProtocolDigest,
} from "../dev/pd-lab/judge-protocol.mjs";
import { mergeJudgments } from "../dev/pd-lab/alignment-report.mjs";
import {
  runValidateCli,
  REPO_ROOT,
} from "./fixtures/pd-lab-judge-protocol-helpers.mjs";

let tempRoot: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pd-lab-judge-protocol-"));
});

afterAll(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

const MODELS = {
  judgeModel: { provider: "synthetic", model: "fixture-judge", version: "1" },
  generatorModel: { provider: "synthetic", model: "fixture-gen", version: "1" },
  modelRelationDisclosure: "SAME_FAMILY",
};

function healthyPackage(overrides: Record<string, unknown> = {}) {
  return buildJudgePackage({
    packageId: "pkg-1",
    context: "Owner expects bounded scope and honest uncertainty reporting.",
    outputCandidate:
      "trajectory one: bounded plan, cites turn 3 evidence, flags one unknown",
    outputReference:
      "trajectory two: broader sweep, no citations, silent on risk",
    identityMap: { A: "candidate", B: "reference" },
    displayOrder: "AB",
    ...overrides,
  });
}

function rawResponseOf(parsed: {
  displayVerdict: string;
  reason?: string;
  unknownReason?: string;
}) {
  const lines = [
    `VERDICT: ${parsed.displayVerdict}`,
    `REASON: ${parsed.reason ?? "synthetic reason"}`,
  ];
  if (parsed.displayVerdict === "UNKNOWN")
    lines.push(
      `UNKNOWN_REASON: ${parsed.unknownReason ?? "insufficient comparable evidence"}`,
    );
  return lines.join("\n");
}

function evidenceFor(verdict: string) {
  if (verdict === "TIE")
    return [
      { side: "A", anchor: "turn:3" },
      { side: "B", anchor: "turn:4" },
    ];
  if (verdict === "A_BETTER") return [{ side: "A", anchor: "turn:3" }];
  if (verdict === "B_BETTER") return [{ side: "B", anchor: "turn:4" }];
  return [{ side: "A", anchor: "turn:3" }];
}

function healthyRecord(
  built: {
    blindPackage: Record<string, unknown>;
    secretBinding: Record<string, unknown>;
  },
  verdict: string,
  judgmentId = "j-1",
  assignmentKey = "cfg-candidate+case-1@v1+opp-1+rep-1+ref-1",
  extra: Record<string, unknown> = {},
) {
  return buildProtocolRecord({
    judgmentId,
    assignmentKey,
    blindPackage: built.blindPackage,
    secretBinding: built.secretBinding,
    parsed: {
      displayVerdict: verdict,
      reason: "synthetic reason",
      ...(verdict === "UNKNOWN"
        ? { unknownReason: "insufficient comparable evidence" }
        : {}),
    },
    attempt: 1,
    ...MODELS,
    judgeSlotId: `slot-${judgmentId}`,
    evidence: evidenceFor(verdict),
    ...extra,
  });
}

function writeBundle(name: string, bundle: Record<string, unknown>) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "bundle.json");
  fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { dir, file };
}

function validateBundle(name: string, bundle: Record<string, unknown>) {
  const { dir, file } = writeBundle(name, bundle);
  const out = path.join(dir, "out");
  const run = runValidateCli(["--bundle", file, "--out", out]);
  const reportPath = path.join(out, "protocol-validation.json");
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : null;
  const stdoutLine =
    run.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .pop() ?? "";
  return { run, report, stdoutLine, dir, out };
}

/** A minimal T4 plan with one assignment, protocol ref bound to jp-pd-lab@1. */
function minimalPlan(requiredJudgments = 1) {
  return {
    schemaVersion: "pd-lab-plan.v1",
    benchmarkId: "bench-protocol",
    benchmarkVersion: "1",
    comparisonDesign: "CHANGE_VS_BASELINE",
    judgeProtocolRef: JUDGE_PROTOCOL_REF,
    judgeProtocol: { requiredJudgments },
    analysisPolicy: { alpha: 0.05 },
    owners: [{ ownerId: "O1", weight: 1 }],
    scenarios: [{ scenarioId: "SC1", ownerId: "O1", weight: 1 }],
    assignments: [
      {
        candidateConfigId: "cfg-candidate",
        caseId: "case-1",
        caseVersion: "v1",
        opportunityId: "opp-1",
        repetitionId: "rep-1",
        referenceId: "ref-1",
        scenarioId: "SC1",
        candidateTrajectoryRef: "traj-cand",
        referenceTrajectoryRef: "traj-ref",
        expectationRef: "exp-1",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Protocol identity and digest.
// ---------------------------------------------------------------------------

describe("judge protocol identity", () => {
  it("exposes a versioned protocol ref and a stable content digest", () => {
    expect(JUDGE_PROTOCOL_REF).toBe("jp-pd-lab@1");
    expect(JUDGE_PROTOCOL.judgeProtocolRef).toBe(JUDGE_PROTOCOL_REF);
    const first = judgeProtocolDigest();
    expect(judgeProtocolDigest()).toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest equals sha256 over canonical JSON of the frozen definition (key-order independent)", () => {
    const canonical = JSON.stringify(sortDeep(JUDGE_PROTOCOL));
    expect(
      `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    ).toBe(judgeProtocolDigest());
  });

  it("freezes the CONTRACT 5.1 fail-closed policies in the definition", () => {
    expect(JUDGE_PROTOCOL.illegalOutputPolicy).toBe("REJECT_NEVER_TIE");
    expect(JUDGE_PROTOCOL.unknownPolicy.explicitOnly).toBe(true);
    expect(JUDGE_PROTOCOL.lossyInputPolicy.truncatedJudgedInputForces).toBe(
      "UNKNOWN",
    );
    expect(JUDGE_PROTOCOL.verdictVocabulary).toEqual([
      "A_BETTER",
      "TIE",
      "B_BETTER",
      "UNKNOWN",
    ]);
  });
});

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Four-value parsing (task P2 items 2, 3, 12).
// ---------------------------------------------------------------------------

describe("parseJudgeResponse", () => {
  it("parses each of the four verdicts (CRLF tolerated)", () => {
    expect(parseJudgeResponse("VERDICT: A_BETTER\r\nREASON: r")).toEqual({
      ok: true,
      displayVerdict: "A_BETTER",
      reason: "r",
      unknownReason: null,
    });
    expect(parseJudgeResponse("VERDICT: B_BETTER\nREASON: r")).toEqual({
      ok: true,
      displayVerdict: "B_BETTER",
      reason: "r",
      unknownReason: null,
    });
    expect(parseJudgeResponse("VERDICT: TIE\nREASON: r")).toEqual({
      ok: true,
      displayVerdict: "TIE",
      reason: "r",
      unknownReason: null,
    });
    expect(
      parseJudgeResponse(
        "VERDICT: UNKNOWN\nREASON: r\nUNKNOWN_REASON: evidence gap",
      ),
    ).toEqual({
      ok: true,
      displayVerdict: "UNKNOWN",
      reason: "r",
      unknownReason: "evidence gap",
    });
  });

  it("rejects illegal output and NEVER produces TIE or any verdict (fail-closed)", () => {
    const illegal = [
      "",
      "   ",
      "VERDICT: maybe tie?",
      "VERDICT: a_better\nREASON: r",
      "VERDICT A_BETTER\nREASON: r",
      '```json\n{"verdict": "A_BETTER"}\n```',
      '{"verdict":"TIE","reason":"json"}',
      "VERDICT: A_BETTER\nREASON: r\nEXTRA: prose",
    ];
    for (const raw of illegal) {
      const parsed = parseJudgeResponse(raw);
      expect(parsed.ok, `input ${JSON.stringify(raw)} must be rejected`).toBe(
        false,
      );
      expect(
        (parsed as { displayVerdict?: string }).displayVerdict,
      ).toBeUndefined();
    }
  });

  it("UNKNOWN without a reason is rejected; a reason on a non-UNKNOWN verdict is rejected", () => {
    expect(parseJudgeResponse("VERDICT: UNKNOWN\nREASON: r").ok).toBe(false);
    expect(
      parseJudgeResponse("VERDICT: UNKNOWN\nREASON: r\nUNKNOWN_REASON: ").ok,
    ).toBe(false);
    expect(
      parseJudgeResponse("VERDICT: TIE\nREASON: r\nUNKNOWN_REASON: leftover")
        .ok,
    ).toBe(false);
  });

  it("closed-set round-trip: every JUDGE_OUTPUT code is triggered, none outside the list (ERR-146)", () => {
    const triggers: Record<string, string> = {
      JUDGE_OUTPUT_EMPTY: "",
      JUDGE_OUTPUT_LINE_MALFORMED: "VERDICT A_BETTER",
      JUDGE_OUTPUT_LINE_INVALID: "FOO: bar\nVERDICT: A_BETTER\nREASON: r",
      JUDGE_OUTPUT_VERDICT_MISSING: "REASON: r",
      JUDGE_OUTPUT_VERDICT_DUPLICATE:
        "VERDICT: A_BETTER\nVERDICT: TIE\nREASON: r",
      JUDGE_OUTPUT_VERDICT_UNKNOWN_VALUE: "VERDICT: TIE_MAYBE\nREASON: r",
      JUDGE_OUTPUT_REASON_MISSING: "VERDICT: A_BETTER\nREASON: ",
      JUDGE_OUTPUT_REASON_DUPLICATE: "VERDICT: A_BETTER\nREASON: a\nREASON: b",
      JUDGE_OUTPUT_UNKNOWN_REASON_MISSING: "VERDICT: UNKNOWN\nREASON: r",
      JUDGE_OUTPUT_UNKNOWN_REASON_FORBIDDEN:
        "VERDICT: UNKNOWN\nREASON: r\nUNKNOWN_REASON: a\nUNKNOWN_REASON: b",
    };
    expect(Object.keys(triggers).sort()).toEqual(
      [...JUDGE_OUTPUT_PROBLEM_CODES].sort(),
    );
    const emitted = new Set<string>();
    for (const raw of Object.values(triggers)) {
      const parsed = parseJudgeResponse(raw) as { ok: boolean; code?: string };
      expect(parsed.ok).toBe(false);
      emitted.add(parsed.code as string);
    }
    expect([...emitted].sort()).toEqual([...JUDGE_OUTPUT_PROBLEM_CODES].sort());
    // Single-reason-on-non-UNKNOWN is the same FORBIDDEN flavor.
    expect(
      (
        parseJudgeResponse(
          "VERDICT: A_BETTER\nREASON: r\nUNKNOWN_REASON: x",
        ) as { code: string }
      ).code,
    ).toBe("JUDGE_OUTPUT_UNKNOWN_REASON_FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Record schema validation (task P2 item 1).
// ---------------------------------------------------------------------------

describe("validateProtocolRecord", () => {
  it("accepts a healthy record and carries the CONTRACT 5.1 field set", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER");
    const result = validateProtocolRecord(record);
    expect(result.problems).toEqual([]);
    for (const field of [
      "judgmentId",
      "assignmentKey",
      "judgeProtocolRef",
      "comparisonInputDigest",
      "rubricVersion",
      "attempt",
      "displayOrder",
      "identityMap",
      "displayVerdict",
      "evidence",
      "reason",
      "judgeModel",
      "generatorModel",
      "modelRelationDisclosure",
      "lossyInput",
    ]) {
      expect(record).toHaveProperty(field);
    }
  });

  it("closed-set round-trip: every record problem code is triggered, none outside the list (ERR-146)", () => {
    const base = () =>
      healthyRecord(healthyPackage(), "A_BETTER") as unknown as Record<
        string,
        unknown
      >;
    const mutations: Record<string, (r: Record<string, unknown>) => void> = {
      RECORD_NOT_OBJECT: () => undefined,
      FIELD_MISSING: (r) => {
        delete r.judgmentId;
      },
      FIELD_INVALID: (r) => {
        r.lossyInput = "yes";
      },
      PROTOCOL_REF_MISMATCH: (r) => {
        r.judgeProtocolRef = "jp-other@9";
      },
      RUBRIC_VERSION_MISMATCH: (r) => {
        r.rubricVersion = "jp-other-rubric@9";
      },
      DISPLAY_VERDICT_INVALID: (r) => {
        r.displayVerdict = "TIE?";
      },
      UNKNOWN_REASON_MISSING: (r) => {
        r.displayVerdict = "UNKNOWN";
        delete r.unknownReason;
      },
      UNKNOWN_REASON_FORBIDDEN: (r) => {
        r.unknownReason = "leftover";
      },
      LOSSY_VERDICT_NOT_UNKNOWN: (r) => {
        r.lossyInput = true;
        r.truncation = [
          { truncatedSide: "A", truncatedAt: 10, originalChars: 50 },
        ];
      },
      TRUNCATION_MISSING: (r) => {
        r.lossyInput = true;
      },
      TRUNCATION_FORBIDDEN: (r) => {
        r.truncation = [
          { truncatedSide: "A", truncatedAt: 10, originalChars: 50 },
        ];
      },
      TRUNCATION_INVALID: (r) => {
        r.lossyInput = true;
        r.truncation = [
          { truncatedSide: "A", truncatedAt: 50, originalChars: 10 },
        ];
      },
      IDENTITY_MAP_INVALID: (r) => {
        r.identityMap = { A: "candidate", B: "candidate" };
      },
      DISPLAY_ORDER_INVALID: (r) => {
        r.displayOrder = "AA";
      },
      EVIDENCE_INVALID: (r) => {
        r.evidence = [];
      },
      EVIDENCE_SIDES_INVALID: (r) => {
        r.evidence = [{ side: "B", anchor: "turn:4" }];
      },
      ATTEMPT_INVALID: (r) => {
        r.attempt = 0;
      },
      ATTEMPT_STATUS_INVALID: (r) => {
        r.attemptStatus = "RETRY";
      },
      JUDGE_SLOT_ID_INVALID: (r) => {
        r.judgeSlotId = "";
      },
      MODEL_BLOCK_INVALID: (r) => {
        r.judgeModel = { provider: "x", model: "y" };
      },
      RELATION_DISCLOSURE_INVALID: (r) => {
        r.modelRelationDisclosure = "UNRELATED";
      },
      REASON_MISSING: (r) => {
        delete r.reason;
      },
      DIGEST_INVALID: (r) => {
        r.comparisonInputDigest = "not-a-digest";
      },
    };
    expect(Object.keys(mutations).sort()).toEqual(
      [...PROTOCOL_RECORD_PROBLEM_CODES].sort(),
    );
    const emitted = new Set<string>();
    for (const [code, mutate] of Object.entries(mutations)) {
      const record: unknown = code === "RECORD_NOT_OBJECT" ? 42 : base();
      if (code !== "RECORD_NOT_OBJECT")
        mutate(record as Record<string, unknown>);
      const result = validateProtocolRecord(record);
      expect(result.ok).toBe(false);
      const codes = result.problems.map((p: { code: string }) => p.code);
      expect(codes, `${code} must be among the emitted problems`).toContain(
        code,
      );
      for (const c of codes) {
        expect(PROTOCOL_RECORD_PROBLEM_CODES).toContain(c);
        emitted.add(c);
      }
    }
    expect([...emitted].sort()).toEqual(
      [...PROTOCOL_RECORD_PROBLEM_CODES].sort(),
    );
  });

  it("TIE must cite both sides; wins must cite the winning side (两侧证据锚点)", () => {
    const built = healthyPackage();
    const tie = healthyRecord(built, "TIE");
    (tie as unknown as Record<string, unknown>).evidence = [
      { side: "A", anchor: "turn:3" },
    ];
    expect(
      validateProtocolRecord(tie).problems.map((p: { code: string }) => p.code),
    ).toContain("EVIDENCE_SIDES_INVALID");
    const win = healthyRecord(built, "B_BETTER");
    (win as unknown as Record<string, unknown>).evidence = [
      { side: "A", anchor: "turn:3" },
    ];
    expect(
      validateProtocolRecord(win).problems.map((p: { code: string }) => p.code),
    ).toContain("EVIDENCE_SIDES_INVALID");
  });

  it("a FAILED attempt may omit verdict/reason/evidence and stays a legal audit record", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER", "j-failed", undefined, {
      attemptStatus: "FAILED",
    }) as unknown as Record<string, unknown>;
    delete record.displayVerdict;
    delete record.reason;
    delete record.evidence;
    expect(validateProtocolRecord(record).problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Blind package: leak scan, position exchange, lossy marking (task P1).
// ---------------------------------------------------------------------------

describe("blind judge package", () => {
  it("separates the blind package from the secret identity binding", () => {
    const { ok, blindPackage, secretBinding } = healthyPackage();
    expect(ok).toBe(true);
    expect(JSON.stringify(blindPackage)).not.toContain("candidate");
    expect(JSON.stringify(blindPackage)).not.toContain("reference");
    expect(secretBinding.identityMap).toEqual({
      A: "candidate",
      B: "reference",
    });
    expect(checkPackageForLeaks(blindPackage)).toEqual([]);
  });

  it("refuses a package that leaks arm identity (fail-closed at build time)", () => {
    const leaks = [
      healthyPackage({
        context: "see D:/Code/_worktrees/principles/arm-x for details",
      }),
      healthyPackage({ context: "v1" }),
      healthyPackage({ context: "candidate" }),
    ];
    for (const build of leaks) {
      expect(build.ok).toBe(false);
      expect((build as { code: string }).code).toBe("BLIND_PACKAGE_LEAK");
      expect(
        (build as { violations: unknown[] }).violations.length,
      ).toBeGreaterThan(0);
    }
  });

  it("exchanges A/B positions without changing the true candidate identity (SC-09)", () => {
    const original = healthyPackage();
    const swapped = swapJudgePackage(
      original.blindPackage,
      original.secretBinding,
      "pkg-1:swap",
    );
    expect(swapped.ok).toBe(true);
    expect(swapped.blindPackage.outputA).toBe(original.blindPackage.outputB);
    expect(swapped.blindPackage.outputB).toBe(original.blindPackage.outputA);
    expect(swapped.secretBinding.identityMap).toEqual({
      A: "reference",
      B: "candidate",
    });
    expect(swapped.secretBinding.displayOrder).toBe("BA");
    // Same comparison input: the role-canonical digest is IDENTICAL across
    // the two presentations (one frozen comparison), while any content
    // change flips it.
    expect(
      comparisonInputDigestOf(
        swapped.blindPackage,
        swapped.secretBinding.identityMap,
      ),
    ).toBe(
      comparisonInputDigestOf(
        original.blindPackage,
        original.secretBinding.identityMap,
      ),
    );
    const tampered = {
      ...original.blindPackage,
      outputA: `${original.blindPackage.outputA}!`,
    };
    expect(
      comparisonInputDigestOf(tampered, original.secretBinding.identityMap),
    ).not.toBe(
      comparisonInputDigestOf(
        original.blindPackage,
        original.secretBinding.identityMap,
      ),
    );
    // Swapping contents WITHOUT inverting the map is a different comparison
    // input (the candidate/reference binding changed) and must flip the digest.
    const misbound = swapJudgePackage(
      original.blindPackage,
      original.secretBinding,
      "pkg-misbound",
    );
    expect(
      comparisonInputDigestOf(
        misbound.blindPackage,
        original.secretBinding.identityMap,
      ),
    ).not.toBe(
      comparisonInputDigestOf(
        original.blindPackage,
        original.secretBinding.identityMap,
      ),
    );
    // Judge prefers position A in both presentations -> same candidate verdict.
    expect(
      restoreDisplayVerdict("A_BETTER", original.secretBinding.identityMap),
    ).toBe("CANDIDATE_BETTER");
    expect(
      restoreDisplayVerdict("B_BETTER", swapped.secretBinding.identityMap),
    ).toBe("CANDIDATE_BETTER");
    // TIE and UNKNOWN are position-invariant.
    expect(
      restoreDisplayVerdict("TIE", swapped.secretBinding.identityMap),
    ).toBe("TIE");
    expect(
      restoreDisplayVerdict("UNKNOWN", swapped.secretBinding.identityMap),
    ).toBe("UNKNOWN");
    expect(
      restoreDisplayVerdict("A_BETTER", { A: "x" } as unknown as Record<
        string,
        string
      >),
    ).toBeNull();
  });

  it("truncation marks the package lossy with position facts, and follows the content through a swap", () => {
    const built = buildJudgePackage({
      packageId: "pkg-lossy",
      context: "ctx",
      outputCandidate: "x".repeat(50),
      outputReference: "y",
      identityMap: { A: "candidate", B: "reference" },
      displayOrder: "AB",
      maxOutputChars: 10,
    });
    expect(built.ok).toBe(true);
    expect(built.blindPackage.truncation).toEqual([
      { truncatedSide: "A", truncatedAt: 10, originalChars: 50 },
    ]);
    const record = healthyRecord(built, "UNKNOWN");
    expect(record.lossyInput).toBe(true);
    expect(record.truncation).toEqual([
      { truncatedSide: "A", truncatedAt: 10, originalChars: 50 },
    ]);
    // A lossy input judged as a win is INVALID — incomplete input cannot be
    // scored as if complete (CONTRACT 5.1).
    const cheating = healthyRecord(built, "A_BETTER");
    expect(
      validateProtocolRecord(cheating).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("LOSSY_VERDICT_NOT_UNKNOWN");
    // The swap moves the truncation to side B.
    const swapped = swapJudgePackage(
      built.blindPackage,
      built.secretBinding,
      "pkg-lossy:swap",
    );
    expect(swapped.blindPackage.truncation).toEqual([
      { truncatedSide: "B", truncatedAt: 10, originalChars: 50 },
    ]);
    // Role-canonical digest is unchanged: the truncated arm is the candidate
    // in both presentations.
    expect(
      comparisonInputDigestOf(
        swapped.blindPackage,
        swapped.secretBinding.identityMap,
      ),
    ).toBe(
      comparisonInputDigestOf(
        built.blindPackage,
        built.secretBinding.identityMap,
      ),
    );
  });

  it("an untruncated package never carries lossy facts", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER");
    expect(record.lossyInput).toBe(false);
    expect(record).not.toHaveProperty("truncation");
  });
});

// ---------------------------------------------------------------------------
// CLI: real subprocess matrix (task P2 — real CLI, synthetic fixtures).
// ---------------------------------------------------------------------------

describe("judge-protocol-validate CLI", () => {
  it("validates a healthy two-record swap bundle: exit 0, single-line JSON, deterministic rerun", () => {
    const original = healthyPackage();
    const swapped = swapJudgePackage(
      original.blindPackage,
      original.secretBinding,
      "pkg-1:swap",
    );
    const j1 = healthyRecord(original, "A_BETTER", "j-1");
    const j2 = healthyRecord(swapped, "B_BETTER", "j-2");
    const bundle = {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: original.blindPackage,
          secretBinding: original.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record: j1,
        },
        {
          blindPackage: swapped.blindPackage,
          secretBinding: swapped.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "B_BETTER" }),
          record: j2,
        },
      ],
    };
    const first = validateBundle("healthy-first", bundle);
    expect(first.run.status).toBe(0);
    const summary = JSON.parse(first.stdoutLine);
    expect(summary).toMatchObject({
      ok: true,
      judgeProtocolRef: JUDGE_PROTOCOL_REF,
      entries: 2,
      problems: 0,
      swaps: 1,
    });
    expect(first.report.totals).toMatchObject({
      entries: 2,
      validEntries: 2,
      problemCount: 0,
    });
    // SC-09 at CLI level: both exchanges restore to the same candidate verdict.
    expect(first.report.positionExchange.consistent).toBe(1);
    expect(first.report.positionExchange.flipped).toBe(0);
    const assignment = first.report.perAssignment[0];
    expect(assignment).toMatchObject({
      conflict: false,
      resolvedBy: "CONSISTENT_JUDGMENTS",
      outcome: "CANDIDATE_BETTER",
    });
    // Reproducibility: byte-identical report on a second run.
    const second = validateBundle("healthy-second", bundle);
    expect(second.run.status).toBe(0);
    expect(
      fs.readFileSync(path.join(first.out, "protocol-validation.json"), "utf8"),
    ).toBe(
      fs.readFileSync(
        path.join(second.out, "protocol-validation.json"),
        "utf8",
      ),
    );
    // The report binds the protocol version + digest.
    expect(first.report.judgeProtocolDigest).toBe(judgeProtocolDigest());
  });

  it("detects a tampered comparison input digest (task P2 item 4)", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER") as unknown as Record<
      string,
      unknown
    >;
    record.comparisonInputDigest = `sha256:${"0".repeat(64)}`;
    const { run, report } = validateBundle("tampered-digest", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(report.problems.map((p: { code: string }) => p.code)).toContain(
      "COMPARISON_INPUT_DIGEST_MISMATCH",
    );
  });

  it("rejects an illegal raw judge response on a voting record — never TIE (task P2 item 12)", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "TIE");
    const { run, report } = validateBundle("illegal-raw", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: "I think they are about the same, call it a tie",
          record,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(report.problems.map((p: { code: string }) => p.code)).toContain(
      "JUDGE_OUTPUT_LINE_MALFORMED",
    );
    expect(report.totals.problemCount).toBeGreaterThan(0);
  });

  it("detects a record verdict that does not derive from its raw response", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER");
    const { run, report } = validateBundle("raw-mismatch", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "B_BETTER" }),
          record,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(report.problems.map((p: { code: string }) => p.code)).toContain(
      "RAW_RESPONSE_MISMATCH",
    );
  });

  it("detects lossy-marking drift between package and record", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER") as unknown as Record<
      string,
      unknown
    >;
    record.lossyInput = true; // package is NOT truncated
    const { run, report } = validateBundle("lossy-drift", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(report.problems.map((p: { code: string }) => p.code)).toContain(
      "LOSSY_MARKING_MISMATCH",
    );
  });

  it("preserves failed attempts in the audit trail and excludes them from voting (task P2 item 8)", () => {
    const built = healthyPackage();
    const ok2 = healthyRecord(built, "A_BETTER", "j-2");
    const failedAttempt = (judgmentId: string, attempt: number) =>
      buildProtocolRecord({
        judgmentId,
        assignmentKey: ok2.assignmentKey,
        blindPackage: built.blindPackage,
        secretBinding: built.secretBinding,
        parsed: {},
        attempt,
        attemptStatus: "FAILED",
        ...MODELS,
        judgeSlotId: `slot-${judgmentId}`,
        evidence: [],
      });
    // Two DISTINCT failing attempts of two different slots (EP-05 rc-7:
    // per-attempt evidence, never one stale iteration's result standing in
    // for the other): attempt 1 produced no output at all; attempt 2 kept
    // its illegal raw response as failure evidence.
    const failed1 = failedAttempt("j-failed", 1);
    const failed2 = failedAttempt("j-failed-2", 2);
    const { run, report } = validateBundle("failed-attempt", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record: ok2,
        },
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          record: failed1,
        }, // no raw response, no verdict
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: "timeout – no verdict produced",
          record: failed2,
        }, // illegal raw kept as failure evidence; still no verdict -> preserved
      ],
    });
    expect(run.status).toBe(0);
    expect(report.totals.failedAttemptsPreserved).toEqual(["j-failed", "j-failed-2"]);
    const assignment = report.perAssignment[0];
    expect(assignment.votingJudgments).toEqual(["j-2"]);
    expect([...assignment.judgmentIds].sort()).toEqual(["j-2", "j-failed", "j-failed-2"]);
    expect(assignment.outcome).toBe("CANDIDATE_BETTER");
  });

  it("unresolved conflicts stay UNKNOWN; a completely bound arbitration resolves them (task P2 item 9)", () => {
    const built = healthyPackage();
    const swapped = swapJudgePackage(
      built.blindPackage,
      built.secretBinding,
      "pkg-1:swap",
    );
    // j-1: candidate at A wins. j-2 (swapped positions): judge again prefers
    // position A -> restores to REFERENCE_BETTER: a REAL conflict (SC-10).
    const j1 = healthyRecord(built, "A_BETTER", "j-1");
    const j2 = healthyRecord(swapped, "A_BETTER", "j-2");
    const bundleBase = {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record: j1,
        },
        {
          blindPackage: swapped.blindPackage,
          secretBinding: swapped.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record: j2,
        },
      ],
    };
    const unresolved = validateBundle("conflict-unresolved", bundleBase);
    expect(unresolved.run.status).toBe(0); // a conflict is DATA, not a CLI failure
    const assignment = unresolved.report.perAssignment[0];
    expect(assignment.conflict).toBe(true);
    expect(assignment.resolvedBy).toBe("UNRESOLVED");
    expect(assignment.outcome).toBe("UNKNOWN");
    // The position flip between the two orders is disclosed, not averaged.
    expect(unresolved.report.positionExchange.flipped).toBe(1);
    expect(unresolved.report.positionExchange.consistent).toBe(0);

    // Complete arbitration (binds every voting record and both digests).
    const arbitrated = validateBundle("conflict-arbitrated", {
      ...bundleBase,
      arbitrations: [
        {
          arbitrationId: "arb-1",
          assignmentKey: j1.assignmentKey,
          verdict: "CANDIDATE_BETTER",
          boundJudgmentIds: ["j-1", "j-2"],
          boundComparisonInputDigests: [
            j1.comparisonInputDigest,
            j2.comparisonInputDigest,
          ],
        },
      ],
    });
    expect(arbitrated.run.status).toBe(0);
    const resolved = arbitrated.report.perAssignment[0];
    expect(resolved.resolvedBy).toBe("BLIND_ARBITRATION");
    expect(resolved.outcome).toBe("CANDIDATE_BETTER");
    expect(resolved.arbitrationBindingComplete).toBe(true);

    // Incomplete binding (misses j-2) does not resolve anything.
    const halfBound = validateBundle("conflict-half-bound", {
      ...bundleBase,
      arbitrations: [
        {
          arbitrationId: "arb-2",
          assignmentKey: j1.assignmentKey,
          verdict: "CANDIDATE_BETTER",
          boundJudgmentIds: ["j-1"],
          boundComparisonInputDigests: [j1.comparisonInputDigest],
        },
      ],
    });
    expect(halfBound.report.perAssignment[0]).toMatchObject({
      resolvedBy: "UNRESOLVED",
      outcome: "UNKNOWN",
    });
  });

  it("rejects a declared swap partner whose contents were not exchanged", () => {
    const built = healthyPackage();
    const other = healthyPackage({ packageId: "pkg-2" });
    const j1 = healthyRecord(built, "A_BETTER", "j-1");
    const j2 = healthyRecord(other, "A_BETTER", "j-2");
    const { run, report } = validateBundle("bad-swap", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        {
          blindPackage: built.blindPackage,
          secretBinding: built.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record: j1,
          swapOf: "pkg-2",
        },
        {
          blindPackage: other.blindPackage,
          secretBinding: other.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record: j2,
        },
      ],
    });
    expect(run.status).toBe(1);
    expect(report.problems.map((p: { code: string }) => p.code)).toContain(
      "SWAP_CONTENT_MISMATCH",
    );
  });

  it(
    "usage errors and unreadable bundles exit 2 without writing output",
    { timeout: 60_000 },
    () => {
      expect(runValidateCli(["--bundle"]).status).toBe(2);
      expect(runValidateCli(["--nope", "x"]).status).toBe(2);
      const missing = runValidateCli([
        "--bundle",
        path.join(tempRoot, "no-such-bundle.json"),
        "--out",
        path.join(tempRoot, "no-out"),
      ]);
      expect(missing.status).toBe(2);
      const badSchema = writeBundle("bad-schema", {
        schema: "something-else",
        entries: [],
      });
      expect(
        runValidateCli([
          "--bundle",
          badSchema.file,
          "--out",
          path.join(badSchema.dir, "o"),
        ]).status,
      ).toBe(2);
      // Write-once --out: an existing directory is refused.
      const built = healthyPackage();
      const record = healthyRecord(built, "A_BETTER");
      const { file, dir } = writeBundle("write-once", {
        schema: "pd-lab-judge-protocol-bundle.v1",
        entries: [
          {
            blindPackage: built.blindPackage,
            secretBinding: built.secretBinding,
            rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
            record,
          },
        ],
      });
      const outOnce = path.join(dir, "out-once");
      fs.mkdirSync(outOnce);
      expect(runValidateCli(["--bundle", file, "--out", outOnce]).status).toBe(
        2,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Deterministic merge through the REAL T4 authority (task P2 items 9, 10).
// ---------------------------------------------------------------------------

describe("protocol records merge through T4 mergeJudgments", () => {
  it("swap-agreeing records merge to CANDIDATE_BETTER; order-independent", () => {
    const built = healthyPackage();
    const swapped = swapJudgePackage(
      built.blindPackage,
      built.secretBinding,
      "pkg-1:swap",
    );
    const j1 = healthyRecord(built, "A_BETTER", "j-1");
    const j2 = healthyRecord(swapped, "B_BETTER", "j-2");
    // The decision blindmap is derived FROM the protocol records' embedded
    // identity maps — one mapping per judgment record. A both-orders
    // protocol preregisters TWO judge seats (CONTRACT 5.2a: requiredJudgments
    // counts valid independent slots, never raw records).
    const plan = minimalPlan(2);
    const blindmap = { map: { "j-1": j1.identityMap, "j-2": j2.identityMap } };
    const merged = mergeJudgments({ plan, judgments: [j1, j2], blindmap });
    expect(merged.problems).toEqual([]);
    expect(merged.finalComparisons[0]).toMatchObject({
      verdict: "CANDIDATE_BETTER",
      resolvedBy: "CONSISTENT_JUDGMENTS",
      judgmentRefs: ["j-1", "j-2"],
    });
    // Deterministic merge: permuted input, identical output.
    expect(mergeJudgments({ plan, judgments: [j2, j1], blindmap })).toEqual(
      merged,
    );
  });

  it("SC-10: opposite restored verdicts without arbitration stay UNKNOWN", () => {
    const built = healthyPackage();
    const swapped = swapJudgePackage(
      built.blindPackage,
      built.secretBinding,
      "pkg-1:swap",
    );
    const j1 = healthyRecord(built, "A_BETTER", "j-1");
    const j2 = healthyRecord(swapped, "A_BETTER", "j-2");
    const blindmap = { map: { "j-1": j1.identityMap, "j-2": j2.identityMap } };
    const merged = mergeJudgments({
      plan: minimalPlan(2),
      judgments: [j1, j2],
      blindmap,
    });
    expect(merged.finalComparisons[0]).toMatchObject({
      verdict: "UNKNOWN",
      resolvedBy: "UNRESOLVED",
    });
    // With a completely bound blind arbitration, the conflict resolves.
    const arbitrated = mergeJudgments({
      plan: minimalPlan(2),
      judgments: [j1, j2],
      blindmap,
      arbitrations: [
        {
          arbitrationId: "arb-1",
          assignmentKey: j1.assignmentKey,
          verdict: "TIE",
          boundJudgmentIds: ["j-1", "j-2"],
          boundComparisonInputDigests: [
            j1.comparisonInputDigest,
            j2.comparisonInputDigest,
          ],
        },
      ],
    });
    expect(arbitrated.finalComparisons[0]).toMatchObject({
      verdict: "TIE",
      resolvedBy: "BLIND_ARBITRATION",
      arbitrationRef: "arb-1",
    });
  });

  it("a lossy UNKNOWN record never votes a win (CONTRACT 5.1 lossy policy through T4)", () => {
    const truncated = buildJudgePackage({
      packageId: "pkg-lossy",
      context: "ctx",
      outputCandidate: "x".repeat(50),
      outputReference: "y",
      identityMap: { A: "candidate", B: "reference" },
      displayOrder: "AB",
      maxOutputChars: 10,
    });
    const record = healthyRecord(truncated, "UNKNOWN");
    const blindmap = { map: { "j-1": record.identityMap } };
    const merged = mergeJudgments({
      plan: minimalPlan(1),
      judgments: [record],
      blindmap,
    });
    expect(merged.finalComparisons[0]).toMatchObject({
      verdict: "UNKNOWN",
      reasonCode: "JUDGMENTS_UNKNOWN",
    });
  });
});

// ---------------------------------------------------------------------------
// Purity (HANDOFF T4 precedent: the pure modules carry no I/O surface).
// ---------------------------------------------------------------------------

describe("module purity", () => {
  it("judge-protocol.mjs and t6-qualification.mjs reference no fs, process.env or Date", () => {
    for (const rel of [
      "scripts/dev/pd-lab/judge-protocol.mjs",
      "scripts/dev/pd-lab/t6-qualification.mjs",
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(source, `${rel} must not read the filesystem`).not.toContain(
        "from 'node:fs'",
      );
      expect(source, `${rel} must not read the environment`).not.toContain(
        "process.env",
      );
      expect(source, `${rel} must not read the clock`).not.toMatch(
        /\bnew Date\b|\bDate\.now\b/,
      );
    }
  });
});
