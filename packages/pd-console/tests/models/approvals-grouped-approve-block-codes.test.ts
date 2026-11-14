/**
 * The review card's approve fence (`approveBlock`) maps the server precheck's
 * verdict onto owner-facing copy. Only a pending PROMPT record is gated, and
 * the whole point of the fence is that the card never offers an action the
 * approve precheck refuses.
 *
 * These cases pin the mapping from real deliverability verdict shapes (the
 * reasons the precheck actually returns) to each block code. `getApprovalsGrouped`
 * is exercised through its public boundary; only the deliverability port is
 * controlled so every verdict branch is reachable deterministically.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrincipleTreeLedgerAdapter, SqliteConnection } from "@principles/core/runtime";
import { ApprovalsGroupedConsoleModel } from "../../src/server/models/ApprovalsGroupedConsoleModel.js";

const { deliverabilityMock } = vi.hoisted(() => ({ deliverabilityMock: vi.fn() }));

vi.mock("@principles/host-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@principles/host-runtime")>();
  return {
    ...actual,
    checkPromptArtifactDeliverability: (...args: unknown[]) => deliverabilityMock(...args),
  };
});

let tmpDir: string;
let conn: SqliteConnection;

const NOW = "2026-10-13T08:00:00.000Z";

/** One prompt approval whose artifact has a ledger-valid direct identity. */
function seedPromptApproval(): { principleId: string; artifactId: string } {
  const principleId = crypto.randomUUID();
  const candidateId = crypto.randomUUID();
  const artifactId = `pi-art-scribe-${candidateId}-prompt-run_scribe-${candidateId}-prompt_1`;
  new PrincipleTreeLedgerAdapter({ stateDir: path.join(tmpDir, ".state") }).writeProbationEntry({
    id: principleId,
    title: "Ledger-anchored principle",
    text: "A committed statement with a real consequence.",
    triggerPattern: "before_tool_call",
    action: "inject review note",
    status: "probation",
    evaluability: "weak_heuristic",
    sourceRef: `candidate://${candidateId}`,
    createdAt: NOW,
  });
  conn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)
  `).run(
    artifactId,
    `scribe-${candidateId}-prompt`,
    principleId,
    JSON.stringify({
      principleId,
      principleDraft: { title: "Ledger-anchored principle", statement: "A committed statement with a real consequence.", rationale: "r" },
    }),
    NOW,
    NOW,
  );
  conn.getDb().prepare(`
    INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)
    VALUES (?, ?, 'prompt', 'low', 'pending', 0.85, ?, ?, 'approve block mapping test')
  `).run(`apr_prompt_${artifactId}`, artifactId, NOW, `${artifactId} summary`);
  return { principleId, artifactId };
}

async function groupFor(principleId: string) {
  const model = new ApprovalsGroupedConsoleModel(tmpDir);
  const result = await model.getApprovalsGrouped("openclaw");
  return result.groups.find((group) => group.principleId === principleId);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-approve-block-"));
  conn = new SqliteConnection({ workspaceDir: tmpDir });
});

afterAll(() => {
  try { conn.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  deliverabilityMock.mockReset();
});

describe("approveBlock — deliverability verdict to owner-facing code", () => {
  it("route facts missing: route_unconfirmed (no budget promise without per-host facts)", async () => {
    const { principleId } = seedPromptApproval();
    deliverabilityMock.mockResolvedValue({
      status: "unconfirmed",
      reason: "route_unconfirmed: effective injection route cannot be confirmed",
      nextAction: "pass an explicit target host (openclaw|codex|workbuddy)",
    });

    const group = await groupFor(principleId);
    expect(group?.approveBlock?.code).toBe("route_unconfirmed");
    expect(group?.promptBudgetTierFit).toBe("unconfirmed");
  });

  it("per-host disagreement: route_unconfirmed and an honest model_dependent fit, never oversized", async () => {
    const { principleId } = seedPromptApproval();
    deliverabilityMock.mockResolvedValue({
      status: "unconfirmed",
      reason: "route_unconfirmed: effective injection route cannot be confirmed",
      nextAction: "pass an explicit target host (openclaw|codex|workbuddy)",
      perHost: [
        { hostKind: "openclaw", tierFit: "fits_all_tiers", costChars: 12000 },
        { hostKind: "codex", tierFit: "exceeds_max_tier", costChars: 40000 },
      ],
    });

    const group = await groupFor(principleId);
    expect(group?.approveBlock?.code).toBe("route_unconfirmed");
    expect(group?.promptBudgetTierFit).toBe("model_dependent");
  });

  it("every applicable host exceeds: budget_exceeded even though the route is unconfirmed", async () => {
    const { principleId } = seedPromptApproval();
    deliverabilityMock.mockResolvedValue({
      status: "unconfirmed",
      reason: "route_unconfirmed: effective injection route cannot be confirmed",
      nextAction: "pass an explicit target host (openclaw|codex|workbuddy)",
      perHost: [
        { hostKind: "openclaw", tierFit: "exceeds_max_tier", costChars: 40000 },
        { hostKind: "codex", tierFit: "exceeds_max_tier", costChars: 40000 },
      ],
    });

    const group = await groupFor(principleId);
    expect(group?.approveBlock?.code).toBe("budget_exceeded");
    expect(group?.promptBudgetTierFit).toBe("exceeds_max_tier");
  });

  it("authority read failed: authority_unreadable, not a fabricated cheap cost", async () => {
    const { principleId } = seedPromptApproval();
    deliverabilityMock.mockResolvedValue({
      status: "unconfirmed",
      reason: "authority_read_failed: state.db is locked; the single-entry cost cannot be measured",
      nextAction: "repair the workspace state.db readability (the authority join read failed), then retry",
    });

    const group = await groupFor(principleId);
    expect(group?.approveBlock?.code).toBe("authority_unreadable");
  });

  it("unrecognised content verdict falls back to content_unconfirmed", async () => {
    const { principleId } = seedPromptApproval();
    deliverabilityMock.mockResolvedValue({
      status: "unconfirmed",
      reason: "statement_missing: draft has no measurable statement",
      nextAction: "fix the artifact content, then retry",
    });

    const group = await groupFor(principleId);
    expect(group?.approveBlock?.code).toBe("content_unconfirmed");
  });

  it("artifact store unreadable (missing table): artifact_unavailable with the closed reason", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-approve-block-nodb-"));
    const seed = new SqliteConnection({ workspaceDir: dir });
    try {
      seed.getDb().prepare(`
        INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)
        VALUES ('apr-nodb', 'art-nodb', 'prompt', 'low', 'pending', 0.85, ?, 'nodb', 'approve block mapping test')
      `).run(NOW);
      // The approvals table stays readable; only the artifact store is gone.
      seed.getDb().exec("DROP TABLE pi_artifacts");
    } finally {
      seed.close();
    }
    try {
      const model = new ApprovalsGroupedConsoleModel(dir);
      const result = await model.getApprovalsGrouped("openclaw");
      const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-nodb"));
      expect(group?.approveBlock?.code).toBe("artifact_unavailable");
      expect(group?.approveBlock?.reason).toBe("approval_artifact_store_unreadable");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
