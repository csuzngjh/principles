import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  RUNTIME_V2_PRINCIPLE_BUDGET,
  resolvePrincipleFromArtifact,
} from '@principles/core/runtime-v2';
import { buildLivePromptInjectionProjection } from '@principles/host-runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import type { ApprovalRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import {
  createArtifactPrincipleResolutionDeps,
  resolveArtifactPrincipleId,
} from './artifact-principle-resolver.js';
import type { PromptInjectionBudgetStatus } from '../../shared/prompt-injection-contract.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Type guard: non-null object (not array). Replaces `as Record<string, unknown>` assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ApprovalGroup {
  principleId: string;
  principleTitle: string;
  /** Human-readable description extracted from the first record's artifact contentJson.
   *  Wave 7: replaces raw fake principleId as card title so Owner can actually
   *  review the candidate content instead of staring at an internal ID. */
  candidateDescription?: string;
  status: 'pending' | 'approved' | 'rejected';
  /**
   * PR-1894: whether this candidate's own serialized prompt entry fits the
   * injection budget on its own. `false` means the entry is oversized, so fair
   * rotation can NEVER inject it �?the pre-approval badge must not promise it
   * will come around. Computed server-side with the production serializer
   * (the client has no access to the escaped, serialized size).
   */
  fitsPromptBudget?: boolean;
  /**
   * PRI-940: the pinned artifact no longer exists in pi_artifacts (typically
   * superseded by a newer scribe revision). There is no contentJson, so
   * `candidateDescription` is unavailable and `principleTitle` degrades to the
   * synthesized `unlinked:<artifactId>` grouping key — a machine id that must
   * never be rendered as a title. Absent when the artifact is readable. rc-9:
   * the UI shows a visible degradation note instead of going silently blank.
   */
  artifactUnavailable?: boolean;
  records: {
    id: string;
    artifactId: string;
    channel: string;
    createdAt: string;
  }[];
}

export interface ApprovalsGroupedResponse {
  groups: ApprovalGroup[];
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely empty */
  note?: string;
  /** PRI-908: prompt-channel injection budget status for the pre-approval forecast. */
  promptInjection?: PromptInjectionBudgetStatus;
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

/**
 * Wave 7: Extract a human-readable description from a PIArtifact's contentJson.
 *
 * The artifact kinds have different contentJson shapes �?this function unifies
 * them into a single description string the Owner can actually read to make a
 * review decision, instead of staring at a fabricated principleId.
 *
 * Supported shapes:
 * - rule:           extract `// Principle: <text>` and `// Rule: <text>` from implementationCode
 * - principle/demo: contentJson.text
 * - scribe:         contentJson.principleDraft.title + .statement
 * - philosopher:    contentJson.principleCandidate.title
 * - dreamer:        contentJson.candidates[0].betterDecision
 *
 * Returns null if no readable description can be extracted.
 */
function extractCandidateDescription(contentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const obj = parsed;

  // rule artifact: extract from implementationCode comments
  if (typeof obj.implementationCode === 'string') {
    const principleMatch = /\/\/\s*Principle:\s*(.+)/.exec(obj.implementationCode);
    const ruleMatch = /\/\/\s*Rule:\s*(.+)/.exec(obj.implementationCode);
    const principleRaw = principleMatch ? principleMatch[1] : undefined;
    const ruleRaw = ruleMatch ? ruleMatch[1] : undefined;
    const principleText = principleRaw ? principleRaw.trim() : null;
    const ruleText = ruleRaw ? ruleRaw.trim() : null;
    if (principleText && ruleText) return `${principleText} �?${ruleText}`;
    if (ruleText) return ruleText;
    if (principleText) return principleText;
  }

  // principle artifact (demo shape): text field
  if (typeof obj.text === 'string' && obj.text.trim().length > 0) return obj.text.trim();

  // scribe artifact: principleDraft.title + .statement
  if (isRecord(obj.principleDraft)) {
    const draft = obj.principleDraft;
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    const statement = typeof draft.statement === 'string' ? draft.statement.trim() : '';
    if (title && statement) return `${title} �?${statement}`;
    if (title) return title;
    if (statement) return statement;
  }

  // philosopher artifact: principleCandidate.title
  if (isRecord(obj.principleCandidate)) {
    const cand = obj.principleCandidate;
    if (typeof cand.title === 'string' && cand.title.trim().length > 0) return cand.title.trim();
  }

  // dreamer artifact: candidates[0].betterDecision
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const [first] = obj.candidates;
    if (isRecord(first)) {
      const c = first;
      if (typeof c.betterDecision === 'string' && c.betterDecision.trim().length > 0) {
        return c.betterDecision.trim();
      }
    }
  }

  return null;
}

/**
 * PR-1894: would this candidate's own prompt entry fit the injection budget if
 * it were the ONLY entry?
 *
 * Uses the production text resolver and the production entry format/escaping
 * (`- [<id>] <text>` via escapeXml, plus the section header `trimToBudget`
 * charges before any entry) so the answer matches what the real selector
 * computes rather than an approximation. An entry that cannot fit alone is
 * "oversized" in the core selector and is skipped in EVERY rotation round, so
 * fair rotation cannot deliver it.
 *
 * Degrades to `false` (do not promise rotation) whenever the real size cannot be
 * determined �?an unknown size must never become a promise (rc-9).
 */
function candidateFitsPromptBudget(artifact: PIArtifactRecord | null): boolean {
  if (!artifact?.contentJson) return false;
  // The pending candidate has no activation row yet, but the resolver only
  // needs the artifact plus an id pair �?this mirrors what approve will do.
  const resolved = resolvePrincipleFromArtifact(
    {
      artifact_id: artifact.artifactId,
      artifact_kind: artifact.artifactKind,
      content_json: artifact.contentJson,
      validation_status: artifact.validationStatus,
    },
    {
      activationId: `pending:${artifact.artifactId}`,
      idempotencyKey: `pending:${artifact.artifactId}::prompt`,
      artifactId: artifact.artifactId,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `pending://${artifact.artifactId}`,
      activatedAt: new Date(0).toISOString(),
      deactivatedAt: null,
    },
  );
  if (!resolved.ok) return false;
  // The real principle id is unknown pre-approval; a UUID allowance is the
  // worst case, and the actual id can only make the entry smaller.
  const entry = `- [${escapeXml('00000000-0000-0000-0000-000000000000')}] ${escapeXml(resolved.principle.text)}`;
  const header = 'Runtime V2 activated principles:';
  return entry.length + 1 + header.length <= RUNTIME_V2_PRINCIPLE_BUDGET;
}

export class ApprovalsGroupedConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getApprovalsGrouped(): Promise<ApprovalsGroupedResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { groups: [], generatedAt: new Date().toISOString(), note: 'state.db not found �?workspace may not be initialized' };
    }

    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteApprovalQueueStore(conn);
      const queue = new ApprovalQueue(store);
      const artifactStore = new SqlitePIArtifactStore(conn);

      let allApprovals: ApprovalRecord[];
      try {
        allApprovals = await queue.listAll();
      } catch (err) {
        if (isMissingTableError(err)) {
          return { groups: [], generatedAt: new Date().toISOString(), note: 'approval table not found �?workspace may not be initialized' };
        }
        throw err;
      }

      // Build artifactId �?sourcePrincipleId map AND artifactId �?candidateDescription map.
      // Wave 7: candidateDescription lets FocusPage show human-readable content
      // instead of a fabricated principleId.
      //
      // PRI-768 v5 follow-up (F3): sourcePrincipleId is null for most scribe
      // artifacts, which used to collapse every group to `unlinked:<id>` and
      // dead-end the owner decision UI. When the column is missing, fall back
      // to the shared lineage resolver (scribe �?dreamer seed �?candidateId �?      // ledger derivedFromPainIds) so groups bind to the REAL ledger id.
      const artifactPrincipleMap = new Map<string, string | null>();
      const artifactDescriptionMap = new Map<string, string | null>();
      // PR-1894: per-artifact "does this entry fit the budget alone" fact, so
      // the pre-approval badge never promises rotation for an entry that is
      // oversized (rotation cannot rescue a per-entry overflow).
      const artifactFitsBudgetMap = new Map<string, boolean>();
      // PRI-940: which approval artifacts are MISSING from the store (superseded
      // or pruned) — those cards have no contentJson, so the UI must degrade
      // visibly instead of rendering the `unlinked:` machine id as a title.
      const artifactUnavailableMap = new Map<string, boolean>();
      const stateDir = path.join(this.workspaceDir, '.state');
      const resolutionDeps = createArtifactPrincipleResolutionDeps(conn, artifactStore, this.workspaceDir);
      for (const approval of allApprovals) {
        if (!artifactPrincipleMap.has(approval.artifactId)) {
          try {
            const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(approval.artifactId);
            const mappedId = artifact ? await resolveArtifactPrincipleId(artifact, resolutionDeps) : null;
            artifactPrincipleMap.set(approval.artifactId, mappedId);
            if (artifact?.contentJson) {
              artifactDescriptionMap.set(approval.artifactId, extractCandidateDescription(artifact.contentJson));
            } else {
              artifactDescriptionMap.set(approval.artifactId, null);
            }
            artifactFitsBudgetMap.set(approval.artifactId, candidateFitsPromptBudget(artifact));
            artifactUnavailableMap.set(approval.artifactId, artifact === null);
          } catch (err) {
            if (isMissingTableError(err)) {
              artifactPrincipleMap.set(approval.artifactId, null);
              artifactDescriptionMap.set(approval.artifactId, null);
              artifactFitsBudgetMap.set(approval.artifactId, false);
              artifactUnavailableMap.set(approval.artifactId, true);
            } else {
              throw err;
            }
          }
        }
      }

      // Load ledger for principle titles
      let principleTitles = new Map<string, string>();
      try {
        const ledger = loadLedger(stateDir);
        for (const [id, principle] of Object.entries(ledger.tree.principles)) {
          principleTitles.set(id, principle.text);
        }
      } catch {
        // Ledger not available �?will fall back to principleId
      }

      // Group by principleId (null �?"unlinked")
      const groupMap = new Map<string, {
        id: string;
        artifactId: string;
        channel: string;
        createdAt: string;
        status: 'pending' | 'approved' | 'rejected';
      }[]>();

      for (const approval of allApprovals) {
        const mappedPrincipleId = artifactPrincipleMap.get(approval.artifactId);
        const principleId = mappedPrincipleId ?? `unlinked:${approval.artifactId}`;

        if (!groupMap.has(principleId)) {
          groupMap.set(principleId, []);
        }
        const records = groupMap.get(principleId);
        if (!records) continue;

        records.push({
          id: approval.approvalId,
          artifactId: approval.artifactId,
          channel: approval.channel,
          createdAt: approval.requestedAt,
          status: approval.status === 'approved' || approval.status === 'rejected'
            ? approval.status
            : 'pending',
        });
      }

      const groups: ApprovalGroup[] = [];
      for (const [principleId, records] of groupMap) {
        const statuses = records.map((r) => r.status);
        let status: 'pending' | 'approved' | 'rejected';
        if (statuses.every((s) => s === 'approved')) {
          status = 'approved';
        } else if (statuses.every((s) => s === 'rejected')) {
          status = 'rejected';
        } else {
          status = 'pending';
        }

        const principleTitle = principleTitles.get(principleId) ?? principleId;
        const firstArtifactId = records[0]?.artifactId;
        const candidateDescription = firstArtifactId
          ? (artifactDescriptionMap.get(firstArtifactId) ?? undefined)
          : undefined;

        groups.push({
          principleId,
          principleTitle,
          candidateDescription,
          status,
          // PR-1894: undefined-safe �?absent when the artifact could not be
          // read, which the UI treats as "do not promise rotation".
          ...(firstArtifactId !== undefined && artifactFitsBudgetMap.has(firstArtifactId)
            ? { fitsPromptBudget: artifactFitsBudgetMap.get(firstArtifactId) === true }
            : {}),
          // PRI-940: absent when the pinned artifact is readable — same
          // spread style as fitsPromptBudget so the wire contract stays
          // unchanged for healthy cards.
          ...(firstArtifactId !== undefined && artifactUnavailableMap.get(firstArtifactId) === true
            ? { artifactUnavailable: true }
            : {}),
          records,
        });
      }

      return {
        groups,
        generatedAt: new Date().toISOString(),
        ...(await this.readPromptInjectionBudgetStatus()),
      };
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * PRI-908: recompute the production prompt injection projection so the
   * focus page can forecast "approved �?effective" BEFORE the Owner decides.
   * PR #1844 follow-up: the forecast follows the workspace's REAL injection
   * route (`buildLivePromptInjectionProjection` �?legacy trimToBudget vs
   * shared render via abstraction_layer_v1), matching the PRI-890 approve-time
   * check. Advisory only: a projection failure omits the field �?the
   * approve-time warning remains the fail-loud exclusion report (rc-9), so
   * this must never fail the grouped read.
   */
  private async readPromptInjectionBudgetStatus(): Promise<{ promptInjection?: PromptInjectionBudgetStatus }> {
    try {
      const projection = await buildLivePromptInjectionProjection({ workspaceDir: this.workspaceDir });
      return {
        promptInjection: {
          budget: projection.budget,
          usedChars: projection.usedChars,
          truncated: projection.truncated,
          // PR-1894: the badge must describe what the PRODUCTION route will do,
          // not which policy this session-less forecast happened to run.
          // Without it the UI can only say "will queue", which under fair
          // rotation reads as permanent starvation and pushes the Owner to
          // deactivate healthy principles.
          productionRotates: projection.productionRotates,
          eligibleCount: projection.eligibleCount,
        },
      };
    } catch (err: unknown) {
      // rc-9: degradation is observable to operators even though it stays
      // invisible in the UI payload (the badge is advisory only).
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pd-console] prompt injection forecast unavailable, omitting promptInjection: ${message}`);
      return {};
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
