/**
 * P1 review: the submit-time precheck and the durable approval write do not
 * share one SQLite snapshot. These tests mutate the material/ledger in the
 * window between them and assert the Owner gets the DISTINCT `precheck_stale`
 * result — nothing written, nothing labelled permanently unapprovable, and no
 * approval whose measured identity no longer holds.
 *
 * The window is induced by wrapping the private precheck entry point: the real
 * implementation runs first, then the test's mutation lands, then `approve`
 * continues into the freshness re-check under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrincipleTreeLedgerAdapter, SqliteActivationStateStore, SqliteConnection } from "@principles/core/runtime";
import { loadLedger, saveLedger } from "@principles/core/principle-tree-ledger";
import { ApprovalsConsoleModel } from "../../src/server/models/ApprovalsConsoleModel.js";

let tmpDir: string;
let conn: SqliteConnection;
const NOW = "2026-10-13T08:00:00.000Z";

type PrecheckFn = (artifactId: string, targetHost?: string) => Promise<{ ok: boolean }>;
const prototype = ApprovalsConsoleModel.prototype as unknown as { precheckPromptCapacity: PrecheckFn };
const originalPrecheck = prototype.precheckPromptCapacity;

let mutateAfterPrecheck: (() => void) | undefined;
let precheckResults: { ok: boolean }[] = [];

function seedLegacyApproval(): { approvalId: string; artifactId: string; principleId: string; candidateId: string } {
  const candidateId = crypto.randomUUID();
  const principleId = crypto.randomUUID();
  const artifactId = `pi-art-scribe-${candidateId}-prompt-run_scribe-${candidateId}-prompt_1`;
  const approvalId = `apr_prompt_${artifactId}`;
  const db = conn.getDb();
  const dreamerTaskId = `dreamer-${candidateId}-prompt`;
  const dreamerArtifactId = `pi-art-dreamer-${candidateId}-prompt`;
  const scribeTaskId = `scribe-${candidateId}-prompt`;
  const runId = crypto.randomUUID();

  db.prepare(
    "INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts) VALUES (?, ?, ?, ?, ?, 0, 3)",
  ).run(dreamerTaskId, "dreamer", "succeeded", NOW, NOW);
  db.prepare(
    "INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
  ).run(runId, dreamerTaskId, "openclaw", "succeeded", NOW, NOW, NOW);
  db.prepare(
    "INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(dreamerArtifactId, runId, dreamerTaskId, "dreamer", "{}", NOW);
  db.prepare(`
    INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
       source_recommendation_json, idempotency_key, status, consumed_at, created_at, recommendation_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?, 'principle')
  `).run(candidateId, dreamerArtifactId, dreamerTaskId, runId, "race", "race", 0.9, "{}", `idem-${candidateId}`, NOW, NOW);

  new PrincipleTreeLedgerAdapter({ stateDir: path.join(tmpDir, ".state") }).writeProbationEntry({
    id: principleId,
    title: "Race principle",
    text: "A committed statement with a real consequence.",
    triggerPattern: "before_tool_call",
    action: "inject review note",
    status: "probation",
    evaluability: "weak_heuristic",
    sourceRef: `candidate://${candidateId}`,
    createdAt: NOW,
  });

  const insertArtifact = db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, 'validated', ?, ?, ?)
  `);
  insertArtifact.run(dreamerArtifactId, "dreamer", dreamerTaskId, "[]", "{}", NOW, NOW);
  insertArtifact.run(artifactId, "principle", scribeTaskId, JSON.stringify([dreamerArtifactId]), JSON.stringify({
    principleDraft: { title: "Race principle", statement: "A committed statement with a real consequence.", rationale: "race" },
    sourceTrace: { dreamerArtifactId },
  }), NOW, NOW);

  db.prepare(`
    INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)
    VALUES (?, ?, 'prompt', 'low', 'pending', 0.85, ?, ?, 'race window test')
  `).run(approvalId, artifactId, NOW, `${approvalId} summary`);

  return { approvalId, artifactId, principleId, candidateId };
}

function approvalStatus(approvalId: string): string | undefined {
  const row = conn.getDb().prepare("SELECT status FROM approvals WHERE approval_id = ?").get(approvalId) as { status?: string } | undefined;
  return row?.status;
}

async function decide(approvalId: string) {
  const model = new ApprovalsConsoleModel(tmpDir);
  return model.approve(approvalId, "owner", { targetHost: "openclaw" });
}

beforeEach(() => {
  // Each case owns a fresh workspace: the outage case poisons the ledger file
  // on purpose, and a shared directory would leak that into the next case.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-approve-race-"));
  conn = new SqliteConnection({ workspaceDir: tmpDir });
  mutateAfterPrecheck = undefined;
  precheckResults = [];
  vi.spyOn(prototype, "precheckPromptCapacity").mockImplementation(async function (this: unknown, artifactId, targetHost) {
    const result = await originalPrecheck.apply(this as never, [artifactId, targetHost]);
    precheckResults.push(result);
    mutateAfterPrecheck?.();
    return result;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { conn.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("approve precheck vs durable write (P1 race window)", () => {
  it("control: no mutation in the window approves the same material the precheck measured", async () => {
    const { approvalId } = seedLegacyApproval();

    const result = await decide(approvalId);

    expect(precheckResults).toHaveLength(1);
    expect(precheckResults[0], "the submit-time precheck must accept the seeded material").toMatchObject({ ok: true });
    expect(approvalStatus(approvalId)).toBe("approved");
    expect(result.ok || result.error === "activation_failed").toBe(true);
  });

  it("ledger becomes unreadable: precheck_stale with authority_unreadable, not a permanent identity verdict", async () => {
    const { approvalId } = seedLegacyApproval();
    mutateAfterPrecheck = () => {
      fs.writeFileSync(path.join(tmpDir, ".state", "principle_training_state.json"), "{ not valid json", "utf8");
    };

    const result = await decide(approvalId);

    expect(precheckResults[0]?.ok).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "precheck_stale" });
    if (result.ok === false && result.error === "precheck_stale") {
      expect(result.reason).toContain("authority_unreadable");
      expect(result.reason).not.toContain("artifact_content_unresolved: ledger_unavailable");
      expect(result.nextAction).toContain("ledger");
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("identity resolution fails: precheck_stale (reload and re-judge), never a wrong allow", async () => {
    const { approvalId, principleId } = seedLegacyApproval();
    mutateAfterPrecheck = () => {
      const store = loadLedger(path.join(tmpDir, ".state"));
      delete store.tree.principles[principleId];
      saveLedger(path.join(tmpDir, ".state"), store);
    };

    const result = await decide(approvalId);

    expect(precheckResults[0]?.ok).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "precheck_stale" });
    if (result.ok === false && result.error === "precheck_stale") {
      expect(result.reason).toContain("artifact_content_unresolved");
      expect(result.nextAction).toContain("reload");
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("identity resolves to a different ledger principle: precheck_stale, not activation under the wrong id", async () => {
    const { approvalId, principleId } = seedLegacyApproval();
    const otherPrincipleId = crypto.randomUUID();
    mutateAfterPrecheck = () => {
      const stateDir = path.join(tmpDir, ".state");
      const store = loadLedger(stateDir);
      const entry = store.tree.principles[principleId];
      if (!entry) throw new Error("seed principle missing");
      delete store.tree.principles[principleId];
      store.tree.principles[otherPrincipleId] = { ...entry, id: otherPrincipleId, title: "Race principle (rewritten)" };
      saveLedger(stateDir, store);
    };

    const result = await decide(approvalId);

    expect(precheckResults[0]?.ok).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "precheck_stale" });
    if (result.ok === false && result.error === "precheck_stale") {
      expect(result.reason).toContain("ledger_identity_changed");
      expect(result.reason).toContain(otherPrincipleId);
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("artifact replaced after the precheck: precheck_stale with artifact_replaced", async () => {
    const { approvalId, artifactId } = seedLegacyApproval();
    mutateAfterPrecheck = () => {
      conn.getDb().prepare("UPDATE pi_artifacts SET content_json = ?, updated_at = ? WHERE artifact_id = ?")
        .run(JSON.stringify({ principleDraft: { title: "Replaced", statement: "Different content.", rationale: "x" } }), "2026-10-13T09:00:00.000Z", artifactId);
    };

    const result = await decide(approvalId);

    expect(precheckResults[0]?.ok).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "precheck_stale" });
    if (result.ok === false && result.error === "precheck_stale") {
      expect(result.reason).toContain("artifact_replaced");
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("artifact disappears after replacement detection: precheck_stale with artifact_unavailable", async () => {
    const { approvalId, artifactId } = seedLegacyApproval();
    // Replacement detection reads the approval artifact FIRST and only then
    // lists live activations (prompt-replacement.ts:47 then :56). Deleting it
    // inside that listing lands exactly in the precheck → write window without
    // racing a timer, so the freshness re-check sees an unavailable artifact.
    let deleteOnNextActivationList = false;
    const storeProto = SqliteActivationStateStore.prototype as unknown as {
      listPromptActivations: () => Promise<unknown[]>;
    };
    const originalList = storeProto.listPromptActivations;
    vi.spyOn(storeProto, "listPromptActivations").mockImplementation(async function (this: unknown) {
      if (deleteOnNextActivationList) {
        deleteOnNextActivationList = false;
        conn.getDb().prepare("DELETE FROM pi_artifacts WHERE artifact_id = ?").run(artifactId);
      }
      return originalList.apply(this as never, []);
    });
    mutateAfterPrecheck = () => { deleteOnNextActivationList = true; };

    const result = await decide(approvalId);

    expect(precheckResults[0]?.ok).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "precheck_stale" });
    if (result.ok === false && result.error === "precheck_stale") {
      expect(result.reason).toContain("artifact_unavailable");
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });

  it("freshness read itself fails: precheck_stale with the unreadable reason, no write", async () => {
    const { approvalId } = seedLegacyApproval();
    mutateAfterPrecheck = () => {
      conn.getDb().exec("DROP TABLE principle_candidates");
    };

    const result = await decide(approvalId);

    expect(precheckResults[0]?.ok).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "precheck_stale" });
    if (result.ok === false && result.error === "precheck_stale") {
      expect(result.reason).toContain("precheck_freshness_unreadable");
    }
    expect(approvalStatus(approvalId)).toBe("pending");
  });
});

