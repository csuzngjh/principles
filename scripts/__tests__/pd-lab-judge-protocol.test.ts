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
      ATTEMPT_MISSING: (r) => {
        delete r.attempt;
      },
      ATTEMPT_STATUS_INVALID: (r) => {
        r.attemptStatus = "RETRY";
      },
      JUDGE_SLOT_ID_INVALID: (r) => {
        r.judgeSlotId = "";
      },
      JUDGE_SLOT_BINDING_MISSING: (r) => {
        delete r.judgeSlotId;
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
      PROTOCOL_DIGEST_MISMATCH: (r) => {
        r.judgeProtocolDigest = `sha256:${"0".repeat(64)}`;
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

  it("T7a record checks and T4 mergeJudgments agree on slot/attempt integrity (P1-2)", () => {
    const built = healthyPackage();
    const blindmapOf = (record: { identityMap: unknown }, id: string) => ({
      map: { [id]: record.identityMap },
    });
    // Missing slot: T7a flags JUDGE_SLOT_BINDING_MISSING on the record AND
    // T4 gates the same unit UNKNOWN with the same code — same judgment.
    const noSlot = healthyRecord(built, "A_BETTER", "j-ns") as unknown as Record<
      string,
      unknown
    >;
    delete noSlot.judgeSlotId;
    expect(
      validateProtocolRecord(noSlot).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("JUDGE_SLOT_BINDING_MISSING");
    const mergedNoSlot = mergeJudgments({
      plan: minimalPlan(1),
      judgments: [noSlot],
      blindmap: blindmapOf(noSlot, "j-ns"),
    });
    expect(mergedNoSlot.evidenceProblems.map((p: { code: string }) => p.code)).toContain(
      "JUDGE_SLOT_BINDING_MISSING",
    );
    expect(mergedNoSlot.finalComparisons[0].verdict).toBe("UNKNOWN");
    // Missing attempt: same agreement.
    const noAttempt = healthyRecord(
      built,
      "A_BETTER",
      "j-na",
    ) as unknown as Record<string, unknown>;
    delete noAttempt.attempt;
    expect(
      validateProtocolRecord(noAttempt).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("ATTEMPT_MISSING");
    const mergedNoAttempt = mergeJudgments({
      plan: minimalPlan(1),
      judgments: [noAttempt],
      blindmap: blindmapOf(noAttempt, "j-na"),
    });
    expect(
      mergedNoAttempt.evidenceProblems.map((p: { code: string }) => p.code),
    ).toContain("ATTEMPT_MISSING");
    // Two same-slot records with DIFFERENT restored verdicts conflict in T4
    // (one seat, no averaging) — and the second record adds no extra seat.
    const retryAgree1 = healthyRecord(built, "A_BETTER", "j-r1", undefined, {
      judgeSlotId: "slot-shared",
    });
    const retryAgree2 = healthyRecord(
      built,
      "A_BETTER",
      "j-r2",
      undefined,
      { judgeSlotId: "slot-shared", attempt: 2 },
    );
    const mergedAgree = mergeJudgments({
      plan: minimalPlan(1),
      judgments: [retryAgree1, retryAgree2],
      blindmap: {
        map: { "j-r1": retryAgree1.identityMap, "j-r2": retryAgree2.identityMap },
      },
    });
    expect(mergedAgree.finalComparisons[0].verdict).toBe("CANDIDATE_BETTER");
    const retryConflict = healthyRecord(
      built,
      "B_BETTER",
      "j-r3",
      undefined,
      { judgeSlotId: "slot-shared", attempt: 2 },
    );
    const mergedConflict = mergeJudgments({
      plan: minimalPlan(1),
      judgments: [retryAgree1, retryConflict],
      blindmap: {
        map: {
          "j-r1": retryAgree1.identityMap,
          "j-r3": retryConflict.identityMap,
        },
      },
    });
    expect(
      mergedConflict.evidenceProblems.map((p: { code: string }) => p.code),
    ).toContain("CONFLICTING_ATTEMPT_RECORDS");
    expect(mergedConflict.finalComparisons[0].verdict).toBe("UNKNOWN");
    // A FAILED attempt never votes: preserved but excluded.
    const failed = healthyRecord(
      built,
      "A_BETTER",
      "j-f",
      undefined,
      { attemptStatus: "FAILED", judgeSlotId: "slot-f" },
    ) as unknown as Record<string, unknown>;
    delete failed.displayVerdict;
    delete failed.reason;
    delete failed.evidence;
    const mergedFailed = mergeJudgments({
      plan: minimalPlan(1),
      judgments: [failed],
      blindmap: blindmapOf(failed, "j-f"),
    });
    expect(mergedFailed.finalComparisons[0].verdict).toBe("UNKNOWN");
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
// PR #2740 remediation: deep freeze, record binding, complete semantic swap,
// T4-parity arbitration binding, per-record validity, CLI exception safety.
// ---------------------------------------------------------------------------

describe("protocol deep freeze and record binding (P1-2/P1-3)", () => {
  it("the protocol definition and exported vocabularies are frozen all the way down", () => {
    expect(Object.isFrozen(JUDGE_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(JUDGE_PROTOCOL.specRefs)).toBe(true);
    expect(Object.isFrozen(JUDGE_PROTOCOL.unknownPolicy)).toBe(true);
    expect(Object.isFrozen(JUDGE_PROTOCOL.lossyInputPolicy)).toBe(true);
    for (const arr of [
      JUDGE_PROTOCOL.verdictVocabulary,
      JUDGE_PROTOCOL.outputContract ? [0] : [],
    ]) {
      void arr;
    }
    const before = judgeProtocolDigest();
    // Mutation attempts on nested structure are impossible in strict mode —
    // and the digest is invariant either way.
    expect(() => {
      (JUDGE_PROTOCOL.verdictVocabulary as string[]).push("MAYBE");
    }).toThrow();
    expect(() => {
      (JUDGE_PROTOCOL.unknownPolicy as Record<string, unknown>).explicitOnly =
        false;
    }).toThrow();
    expect(judgeProtocolDigest()).toBe(before);
  });

  it("records bind the protocol digest; a stale or missing digest is rejected", () => {
    const built = healthyPackage();
    const record = healthyRecord(built, "A_BETTER") as unknown as Record<
      string,
      unknown
    >;
    expect(record.judgeProtocolDigest).toBe(judgeProtocolDigest());
    record.judgeProtocolDigest = `sha256:${"9".repeat(64)}`;
    expect(
      validateProtocolRecord(record).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("PROTOCOL_DIGEST_MISMATCH");
    delete record.judgeProtocolDigest;
    expect(
      validateProtocolRecord(record).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("FIELD_MISSING");
  });

  it("missing judgeSlotId is never defaulted; missing attempt is never defaulted (T4 parity)", () => {
    const built = healthyPackage();
    const noSlot = healthyRecord(built, "A_BETTER") as unknown as Record<
      string,
      unknown
    >;
    delete noSlot.judgeSlotId;
    expect(
      validateProtocolRecord(noSlot).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("JUDGE_SLOT_BINDING_MISSING");
    const noAttempt = healthyRecord(built, "A_BETTER") as unknown as Record<
      string,
      unknown
    >;
    delete noAttempt.attempt;
    expect(
      validateProtocolRecord(noAttempt).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("ATTEMPT_MISSING");
    // A FAILED record may keep no attempt; its slot binding is still required.
    const failedNoSlot = healthyRecord(
      built,
      "A_BETTER",
      "j-f",
      undefined,
      { attemptStatus: "FAILED" },
    ) as unknown as Record<string, unknown>;
    delete failedNoSlot.judgeSlotId;
    expect(
      validateProtocolRecord(failedNoSlot).problems.map(
        (p: { code: string }) => p.code,
      ),
    ).toContain("JUDGE_SLOT_BINDING_MISSING");
    const failedNoAttempt = healthyRecord(
      built,
      "A_BETTER",
      "j-f2",
      undefined,
      { attemptStatus: "FAILED" },
    ) as unknown as Record<string, unknown>;
    delete failedNoAttempt.attempt;
    delete failedNoAttempt.displayVerdict;
    delete failedNoAttempt.reason;
    delete failedNoAttempt.evidence;
    expect(validateProtocolRecord(failedNoAttempt).problems).toEqual([]);
  });
});

describe("complete semantic swap verification via real CLI (P0-2)", () => {
  const makePair = () => {
    const original = healthyPackage();
    const swapped = swapJudgePackage(
      original.blindPackage,
      original.secretBinding,
      "pkg-1:swap",
    );
    return { original, swapped };
  };
  const entryOf = (
    built: ReturnType<typeof healthyPackage>,
    verdict: string,
    judgmentId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    blindPackage: built.blindPackage,
    secretBinding: built.secretBinding,
    rawResponse: rawResponseOf({ displayVerdict: verdict }),
    record: healthyRecord(built, verdict, judgmentId),
    ...extra,
  });
  const bundle = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
    schema: "pd-lab-judge-protocol-bundle.v1",
    entries,
    ...extra,
  });
  const codes = (report: { problems: { code: string }[] }) =>
    report.problems.map((p) => p.code);

  it("a content swap without the inverted identity map is rejected (and flips the digest)", () => {
    const { original, swapped } = makePair();
    const badBinding = {
      // Swapped package but the ORIGINAL (non-inverted) binding.
      packageId: "pkg-1:swap",
      displayOrder: original.secretBinding.displayOrder,
      identityMap: original.secretBinding.identityMap,
    };
    const record = healthyRecord(swapped, "A_BETTER", "j-2") as unknown as Record<
      string,
      unknown
    >;
    record.identityMap = original.secretBinding.identityMap;
    record.displayOrder = original.secretBinding.displayOrder;
    const { run, report } = validateBundle(
      "swap-map-not-inverted",
      bundle([
        entryOf(original, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
        {
          blindPackage: swapped.blindPackage,
          secretBinding: badBinding,
          rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
          record,
        },
      ]),
    );
    expect(run.status).toBe(1);
    expect(codes(report)).toContain("SWAP_IDENTITY_NOT_INVERTED");
    expect(codes(report)).toContain("SWAP_DISPLAY_ORDER_MISMATCH");
    expect(report.positionExchange.invalidPairs).toBe(1);
  });

  it("a swap whose context/rubric/question changed is rejected", () => {
    const { original, swapped } = makePair();
    const tamperedPkg = {
      ...swapped.blindPackage,
      context: `${swapped.blindPackage.context}!`,
    };
    const record = healthyRecord(swapped, "B_BETTER", "j-2") as unknown as Record<
      string,
      unknown
    >;
    record.comparisonInputDigest = comparisonInputDigestOf(
      tamperedPkg,
      swapped.secretBinding.identityMap,
    );
    const { run, report } = validateBundle(
      "swap-context-drift",
      bundle([
        entryOf(original, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
        {
          blindPackage: tamperedPkg,
          secretBinding: swapped.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "B_BETTER" }),
          record,
        },
      ]),
    );
    expect(run.status).toBe(1);
    // The exchanged sides no longer mirror: the content check names it. The
    // role-canonical digest only covers the swapped arms, so context drift
    // is caught by content, not by the digest.
    expect(codes(report)).toContain("SWAP_CONTENT_MISMATCH");
  });

  it("a swap that does not exchange the truncation sides by role is rejected", () => {
    const original = buildJudgePackage({
      packageId: "pkg-lossy",
      context: "ctx",
      outputCandidate: "x".repeat(50),
      outputReference: "y",
      identityMap: { A: "candidate", B: "reference" },
      displayOrder: "AB",
      maxOutputChars: 10,
    });
    const swapped = swapJudgePackage(
      original.blindPackage,
      original.secretBinding,
      "pkg-lossy:swap",
    );
    expect(swapped.ok).toBe(true);
    // Tamper: the swap must carry the truncation on side B (the candidate
    // moved to B); keeping it on A truncates the wrong arm.
    const badPkg = {
      ...swapped.blindPackage,
      truncation: [{ truncatedSide: "A", truncatedAt: 10, originalChars: 50 }],
    };
    const badRecord = healthyRecord(swapped, "UNKNOWN", "j-2") as unknown as Record<
      string,
      unknown
    >;
    badRecord.truncation = [
      { truncatedSide: "A", truncatedAt: 10, originalChars: 50 },
    ];
    badRecord.comparisonInputDigest = comparisonInputDigestOf(
      badPkg,
      swapped.secretBinding.identityMap,
    );
    const { run, report } = validateBundle(
      "swap-truncation-side",
      bundle([
        {
          blindPackage: original.blindPackage,
          secretBinding: original.secretBinding,
          rawResponse: rawResponseOf({
            displayVerdict: "UNKNOWN",
            unknownReason: "insufficient comparable evidence",
          }),
          record: healthyRecord(original, "UNKNOWN", "j-1"),
          swapOf: "pkg-lossy:swap",
        },
        {
          blindPackage: badPkg,
          secretBinding: swapped.secretBinding,
          rawResponse: rawResponseOf({
            displayVerdict: "UNKNOWN",
            unknownReason: "insufficient comparable evidence",
          }),
          record: badRecord,
        },
      ]),
    );
    expect(run.status).toBe(1);
    expect(codes(report)).toContain("SWAP_TRUNCATION_MISMATCH");
    expect(codes(report)).toContain("SWAP_DIGEST_MISMATCH");
  });

  it("UNKNOWN verdicts and invalid records are disclosed separately, never counted consistent", () => {
    const { original, swapped } = makePair();
    const { report } = validateBundle(
      "swap-unknowns",
      bundle([
        {
          ...entryOf(original, "UNKNOWN", "j-1", { swapOf: "pkg-1:swap" }),
        },
        { ...entryOf(swapped, "UNKNOWN", "j-2") },
      ]),
    );
    expect(report.positionExchange.undetermined).toBe(1);
    expect(report.positionExchange.consistent).toBe(0);
    // A record that fails validation never enters the exchange denominator.
    const badRecord = healthyRecord(swapped, "B_BETTER", "j-2") as unknown as Record<
      string,
      unknown
    >;
    badRecord.comparisonInputDigest = `sha256:${"0".repeat(64)}`;
    const { report: invalidReport } = validateBundle(
      "swap-invalid-record",
      bundle([
        entryOf(original, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
        {
          blindPackage: swapped.blindPackage,
          secretBinding: swapped.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "B_BETTER" }),
          record: badRecord,
        },
      ]),
    );
    expect(invalidReport.positionExchange.evaluatedPairs).toBe(0);
    expect(invalidReport.positionExchange.consistent).toBe(0);
    expect(invalidReport.positionExchange.invalidPairs).toBe(1);
  });

  it("duplicate pairing, missing target and malformed swapOf are named problems", () => {
    const { original, swapped } = makePair();
    // pkg-1 <-> pkg-1:swap is bound; a THIRD entry that also has the
    // counter-image shape declares pkg-1 as its partner — one package must
    // not be paired twice.
    const third = swapJudgePackage(
      original.blindPackage,
      original.secretBinding,
      "pkg-1b:swap",
    );
    const { run, report } = validateBundle(
      "swap-dupe",
      bundle([
        entryOf(original, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
        entryOf(swapped, "B_BETTER", "j-2"),
        entryOf(third, "A_BETTER", "j-3", { swapOf: "pkg-1" }),
      ]),
    );
    expect(run.status).toBe(1);
    expect(codes(report)).toContain("SWAP_DUPLICATE_PAIRING");
    const missing = validateBundle(
      "swap-missing-target",
      bundle([entryOf(original, "A_BETTER", "j-1", { swapOf: "pkg-ghost" })]),
    );
    expect(codes(missing.report)).toContain("SWAP_PARTNER_MISSING");
    const malformed = validateBundle(
      "swap-malformed-of",
      bundle([entryOf(original, "A_BETTER", "j-1", { swapOf: 42 })]),
    );
    expect(codes(malformed.report)).toContain("SWAP_OF_INVALID");
  });

  it("two independent swaps over identical content both pair cleanly", () => {
    // Regression: explicit declarations are registered before inference, so
    // an undeclared arm never steals another pair's already-bound partner.
    const a = healthyPackage();
    const aSwap = swapJudgePackage(a.blindPackage, a.secretBinding, "pkg-1:swap");
    const b = healthyPackage({ packageId: "pkg-2" });
    const bSwap = swapJudgePackage(b.blindPackage, b.secretBinding, "pkg-2:swap");
    const { run, report } = validateBundle(
      "swap-two-pairs-same-content",
      bundle([
        entryOf(a, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
        entryOf(aSwap, "B_BETTER", "j-2"),
        entryOf(b, "A_BETTER", "j-3", { swapOf: "pkg-2:swap" }),
        entryOf(bSwap, "B_BETTER", "j-4"),
      ]),
    );
    expect(codes(report).filter((c: string) => c.startsWith("SWAP_"))).toEqual(
      [],
    );
    expect(report.positionExchange.evaluatedPairs).toBe(2);
    expect(report.positionExchange.invalidPairs).toBe(0);
  });

  it("counter-image content from a different assignment is never paired", () => {
    // Regression: a duplicate task reusing the same trajectories with
    // inverted roles is NOT a position exchange of the same comparison —
    // pairing requires the same assignmentKey.
    const a = healthyPackage();
    const aSwap = swapJudgePackage(a.blindPackage, a.secretBinding, "pkg-1:swap");
    const crossTask = {
      blindPackage: aSwap.blindPackage,
      secretBinding: aSwap.secretBinding,
      rawResponse: rawResponseOf({ displayVerdict: "B_BETTER" }),
      record: healthyRecord(
        aSwap,
        "B_BETTER",
        "j-2",
        "cfg-candidate+case-1@v1+opp-2+rep-1+ref-1",
      ),
    };
    const { report } = validateBundle(
      "swap-cross-task",
      bundle([
        entryOf(a, "A_BETTER", "j-1"),
        crossTask,
        entryOf(a, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
      ]),
    );
    // The declared claim on a different task's package is a binding defect,
    // and the unpaired entries never enter the flip-rate denominator.
    expect(codes(report)).toContain("SWAP_CONTENT_MISMATCH");
    expect(report.positionExchange.evaluatedPairs).toBe(0);
  });

  it("a chained explicit claim on an already-bound package is still reported", () => {
    // Regression: being claimed as a partner does not mute a package's own
    // explicit swapOf — A→B′ paired, then B′→C must still flag the double
    // binding, in either entry order.
    const a = healthyPackage();
    const aSwap = swapJudgePackage(a.blindPackage, a.secretBinding, "pkg-1:swap");
    const c = healthyPackage({ packageId: "pkg-3" });
    for (const [name, entries] of [
      [
        "swap-chain-fwd",
        [
          entryOf(a, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
          entryOf(aSwap, "B_BETTER", "j-2", { swapOf: "pkg-3" }),
          entryOf(c, "A_BETTER", "j-3"),
        ],
      ],
      [
        "swap-chain-rev",
        [
          entryOf(a, "A_BETTER", "j-1", { swapOf: "pkg-1:swap" }),
          entryOf(c, "A_BETTER", "j-3"),
          entryOf(aSwap, "B_BETTER", "j-2", { swapOf: "pkg-3" }),
        ],
      ],
    ] as const) {
      const { run, report } = validateBundle(name, bundle([...entries]));
      expect(run.status).toBe(1);
      expect(codes(report)).toContain("SWAP_DUPLICATE_PAIRING");
    }
  });
});

describe("arbitration binding parity with T4 (P0-3)", () => {
  const setup = () => {
    const built = healthyPackage();
    const swapped = swapJudgePackage(
      built.blindPackage,
      built.secretBinding,
      "pkg-1:swap",
    );
    const j1 = healthyRecord(built, "A_BETTER", "j-1");
    const j2 = healthyRecord(swapped, "A_BETTER", "j-2");
    const entries = [
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
    ];
    return { j1, j2, entries };
  };
  const arbitration = (j1: any, j2: any, overrides: Record<string, unknown> = {}) => ({
    arbitrationId: "arb-1",
    assignmentKey: j1.assignmentKey,
    verdict: "CANDIDATE_BETTER",
    boundJudgmentIds: [j1.judgmentId, j2.judgmentId],
    boundComparisonInputDigests: [
      j1.comparisonInputDigest,
      j2.comparisonInputDigest,
    ],
    ...overrides,
  });
  const codes = (report: { problems: { code: string }[] }) =>
    report.problems.map((p) => p.code);

  it("missing/tampered/partial digest bindings stay UNKNOWN — never resolve", () => {
    const { j1, j2, entries } = setup();
    const base = {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries,
    };
    // Digest set missing entirely -> the arbitration record itself is invalid.
    const noDigests = validateBundle("arb-no-digests", {
      ...base,
      arbitrations: [
        {
          arbitrationId: "a",
          assignmentKey: j1.assignmentKey,
          verdict: "TIE",
          boundJudgmentIds: ["j-1", "j-2"],
        },
      ],
    });
    expect(codes(noDigests.report)).toContain("INVALID_ARBITRATION_RECORD");
    // Tampered digest -> binding incomplete -> UNKNOWN.
    const tampered = validateBundle("arb-tampered-digest", {
      ...base,
      arbitrations: [
        arbitration(j1, j2, {
          boundComparisonInputDigests: [
            j1.comparisonInputDigest,
            `sha256:${"0".repeat(64)}`,
          ],
        }),
      ],
    });
    expect(tampered.report.perAssignment[0].outcome).toBe("UNKNOWN");
    expect(
      tampered.report.perAssignment[0].arbitrationBindingComplete,
    ).toBe(false);
    // Partial ids -> UNKNOWN; extra ids -> UNKNOWN.
    for (const bound of [
      ["j-1"],
      ["j-1", "j-2", "j-ghost"],
    ]) {
      const variant = validateBundle(`arb-ids-${bound.length}`, {
        ...base,
        arbitrations: [
          arbitration(j1, j2, { boundJudgmentIds: bound }),
        ],
      });
      expect(variant.report.perAssignment[0].outcome).toBe("UNKNOWN");
    }
    // Partial digest set -> UNKNOWN. Two records of the SAME assignment on
    // different comparison inputs carry two distinct digests; binding only
    // one is incomplete.
    const otherPkg = healthyPackage({
      packageId: "pkg-2",
      outputCandidate: "a different candidate output",
    });
    const j3 = healthyRecord(otherPkg, "B_BETTER", "j-3", j1.assignmentKey);
    const partialDigest = validateBundle("arb-partial-digest", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [
        entries[0],
        {
          blindPackage: otherPkg.blindPackage,
          secretBinding: otherPkg.secretBinding,
          rawResponse: rawResponseOf({ displayVerdict: "B_BETTER" }),
          record: j3,
        },
      ],
      arbitrations: [
        arbitration(j1, j3, {
          boundComparisonInputDigests: [j1.comparisonInputDigest],
        }),
      ],
    });
    expect(partialDigest.report.perAssignment[0].outcome).toBe("UNKNOWN");
  });

  it("missing arbitrationId / unknown assignmentKey are invalid records", () => {
    const { j1, j2, entries } = setup();
    const base = { schema: "pd-lab-judge-protocol-bundle.v1", entries };
    const noId = validateBundle("arb-no-id", {
      ...base,
      arbitrations: [arbitration(j1, j2, { arbitrationId: undefined })],
    });
    expect(codes(noId.report)).toContain("INVALID_ARBITRATION_RECORD");
    const orphan = validateBundle("arb-orphan", {
      ...base,
      arbitrations: [
        arbitration(j1, j2, { assignmentKey: "no-such-assignment" }),
      ],
    });
    expect(codes(orphan.report)).toContain("INVALID_ARBITRATION_RECORD");
  });

  it("a completely bound UNKNOWN arbitration keeps the outcome UNKNOWN", () => {
    const { j1, j2, entries } = setup();
    const { report } = validateBundle("arb-unknown", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries,
      arbitrations: [arbitration(j1, j2, { verdict: "UNKNOWN" })],
    });
    expect(report.perAssignment[0].arbitrationBindingComplete).toBe(true);
    expect(report.perAssignment[0].outcome).toBe("UNKNOWN");
  });
});

describe("per-record validity aggregation via real CLI (P1-1)", () => {
  it("an invalid record is excluded from voting and its assignment stays UNKNOWN", () => {
    const built = healthyPackage();
    const swapped = swapJudgePackage(
      built.blindPackage,
      built.secretBinding,
      "pkg-1:swap",
    );
    const j1 = healthyRecord(built, "A_BETTER", "j-1");
    const bad = healthyRecord(swapped, "A_BETTER", "j-2") as unknown as Record<
      string,
      unknown
    >;
    bad.comparisonInputDigest = `sha256:${"0".repeat(64)}`;
    const { run, report } = validateBundle("invalid-record-vote", {
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
          record: bad,
        },
      ],
    });
    expect(run.status).toBe(1);
    const badRow = report.perRecord.find(
      (r: { judgmentId: string }) => r.judgmentId === "j-2",
    );
    expect(badRow.valid).toBe(false);
    expect(badRow.problemCodes).toContain("COMPARISON_INPUT_DIGEST_MISMATCH");
    const assignment = report.perAssignment[0];
    // Only j-1 votes — the invalid record never enters the judgment set.
    expect(assignment.votingJudgments).toEqual(["j-1"]);
    expect(assignment.outcome).toBe("CANDIDATE_BETTER");
  });

  it("a slot not in the preregistered registry is flagged; no registry is disclosed unverified", () => {
    const built = healthyPackage();
    const entries = [
      {
        blindPackage: built.blindPackage,
        secretBinding: built.secretBinding,
        rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
        record: healthyRecord(built, "A_BETTER", "j-1"),
      },
    ];
    const noRegistry = validateBundle("slot-no-registry", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries,
    });
    expect(
      noRegistry.report.disclosures.map((d: { code: string }) => d.code),
    ).toContain("JUDGE_SLOT_REGISTRATION_UNVERIFIED");
    const wrongSlot = validateBundle("slot-wrong-registry", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      judgeSlots: ["slot-other"],
      entries,
    });
    expect(
      wrongSlot.report.problems.map((p: { code: string }) => p.code),
    ).toContain("JUDGE_SLOT_NOT_PREREGISTERED");
    const rightSlot = validateBundle("slot-right-registry", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      judgeSlots: ["slot-j-1"],
      entries,
    });
    expect(rightSlot.run.status).toBe(0);
  });
});

describe("CLI exception safety on malformed input (P1-4)", () => {
  const entry = (overrides: Record<string, unknown>) => {
    const built = healthyPackage();
    return {
      blindPackage: built.blindPackage,
      secretBinding: built.secretBinding,
      rawResponse: rawResponseOf({ displayVerdict: "A_BETTER" }),
      record: healthyRecord(built, "A_BETTER"),
      ...overrides,
    };
  };
  const malformed = (name: string, entries: unknown[]) =>
    validateBundle(name, {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries,
    });

  it(
    "malformed packages/bindings/records produce named problems, never a crash",
    { timeout: 60_000 },
    () => {
    const cases: Array<[string, unknown[]]> = [
      ["mal-null-pkg", [{ ...entry({}), blindPackage: null }]],
      ["mal-array-pkg", [{ ...entry({}), blindPackage: [1, 2] }]],
      ["mal-empty-pkg", [{ ...entry({}), blindPackage: {} }]],
      ["mal-empty-binding", [{ ...entry({}), secretBinding: {} }]],
      ["mal-no-binding", [{ ...entry({}), secretBinding: undefined }]],
      [
        "mal-bad-map",
        [
          {
            ...entry({}),
            secretBinding: {
              displayOrder: "AB",
              identityMap: { A: "candidate", B: "candidate" },
            },
          },
        ],
      ],
      [
        "mal-bad-truncation",
        [
          {
            ...entry({}),
            blindPackage: {
              ...healthyPackage().blindPackage,
              truncation: [null],
            },
          },
        ],
      ],
      ["mal-null-record", [{ ...entry({}), record: null }]],
    ];
    for (const [name, entries] of cases) {
      const { run, report } = malformed(name, entries);
      expect(run.status, name).toBe(1);
      expect(report.problems.length, name).toBeGreaterThan(0);
      expect(run.stderr, name).not.toContain("TypeError");
    }
    // A malformed arbitration record is a named problem, not a crash.
    const { run, report } = validateBundle("mal-arb", {
      schema: "pd-lab-judge-protocol-bundle.v1",
      entries: [entry({})],
      arbitrations: [{ verdict: "TIE" }, "not-an-object"],
    });
    expect(run.status).toBe(1);
    expect(report.problems.map((p: { code: string }) => p.code)).toContain(
      "INVALID_ARBITRATION_RECORD",
    );
    },
  );
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
