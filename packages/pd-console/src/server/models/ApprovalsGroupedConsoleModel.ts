import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  loadLedger,
} from '@principles/core/runtime-v2';
import type { ApprovalRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApprovalGroup {
  principleId: string;
  principleTitle: string;
  /** Human-readable description extracted from the first record's artifact contentJson.
   *  Wave 7: replaces raw fake principleId as card title so Owner can actually
   *  review the candidate content instead of staring at an internal ID. */
  candidateDescription?: string;
  status: 'pending' | 'approved' | 'rejected';
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
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

/**
 * Wave 7: Extract a human-readable description from a PIArtifact's contentJson.
 *
 * The artifact kinds have different contentJson shapes — this function unifies
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
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // rule artifact: extract from implementationCode comments
  if (typeof obj.implementationCode === 'string') {
    const principleMatch = /\/\/\s*Principle:\s*(.+)/.exec(obj.implementationCode);
    const ruleMatch = /\/\/\s*Rule:\s*(.+)/.exec(obj.implementationCode);
    const principleText = principleMatch ? principleMatch[1].trim() : null;
    const ruleText = ruleMatch ? ruleMatch[1].trim() : null;
    if (principleText && ruleText) return `${principleText} — ${ruleText}`;
    if (ruleText) return ruleText;
    if (principleText) return principleText;
  }

  // principle artifact (demo shape): text field
  if (typeof obj.text === 'string' && obj.text.trim().length > 0) return obj.text.trim();

  // scribe artifact: principleDraft.title + .statement
  if (obj.principleDraft && typeof obj.principleDraft === 'object' && obj.principleDraft !== null) {
    const draft = obj.principleDraft as Record<string, unknown>;
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    const statement = typeof draft.statement === 'string' ? draft.statement.trim() : '';
    if (title && statement) return `${title} — ${statement}`;
    if (title) return title;
    if (statement) return statement;
  }

  // philosopher artifact: principleCandidate.title
  if (obj.principleCandidate && typeof obj.principleCandidate === 'object' && obj.principleCandidate !== null) {
    const cand = obj.principleCandidate as Record<string, unknown>;
    if (typeof cand.title === 'string' && cand.title.trim().length > 0) return cand.title.trim();
  }

  // dreamer artifact: candidates[0].betterDecision
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const [first] = obj.candidates;
    if (first && typeof first === 'object' && first !== null) {
      const c = first as Record<string, unknown>;
      if (typeof c.betterDecision === 'string' && c.betterDecision.trim().length > 0) {
        return c.betterDecision.trim();
      }
    }
  }

  return null;
}

export class ApprovalsGroupedConsoleModel {
  private readConnection: SqliteConnection | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getReadConnection(): SqliteConnection {
    if (!this.readConnection) {
      this.readConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    }
    return this.readConnection;
  }

  async getApprovalsGrouped(): Promise<ApprovalsGroupedResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { groups: [], generatedAt: new Date().toISOString(), note: 'state.db not found — workspace may not be initialized' };
    }

    const conn = this.getReadConnection();
    const store = new SqliteApprovalQueueStore(conn);
    const queue = new ApprovalQueue(store);
    const artifactStore = new SqlitePIArtifactStore(conn);

    let allApprovals: ApprovalRecord[];
    try {
      allApprovals = await queue.listAll();
    } catch (err) {
      if (isMissingTableError(err)) {
        return { groups: [], generatedAt: new Date().toISOString(), note: 'approval table not found — workspace may not be initialized' };
      }
      throw err;
    }

    // Build artifactId → sourcePrincipleId map AND artifactId → candidateDescription map.
    // Wave 7: candidateDescription lets FocusPage show human-readable content
    // instead of a fabricated principleId.
    const artifactPrincipleMap = new Map<string, string | null>();
    const artifactDescriptionMap = new Map<string, string | null>();
    for (const approval of allApprovals) {
      if (!artifactPrincipleMap.has(approval.artifactId)) {
        try {
          const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(approval.artifactId);
          artifactPrincipleMap.set(approval.artifactId, artifact?.sourcePrincipleId ?? null);
          if (artifact?.contentJson) {
            artifactDescriptionMap.set(approval.artifactId, extractCandidateDescription(artifact.contentJson));
          } else {
            artifactDescriptionMap.set(approval.artifactId, null);
          }
        } catch (err) {
          if (isMissingTableError(err)) {
            artifactPrincipleMap.set(approval.artifactId, null);
            artifactDescriptionMap.set(approval.artifactId, null);
          } else {
            throw err;
          }
        }
      }
    }

    // Load ledger for principle titles
    const stateDir = path.join(this.workspaceDir, '.state');
    let principleTitles = new Map<string, string>();
    try {
      const ledger = loadLedger(stateDir);
      for (const [id, principle] of Object.entries(ledger.tree.principles)) {
        principleTitles.set(id, principle.text);
      }
    } catch {
      // Ledger not available — will fall back to principleId
    }

    // Group by principleId (null → "unlinked")
    const groupMap = new Map<string, {
      id: string;
      artifactId: string;
      channel: string;
      createdAt: string;
      status: 'pending' | 'approved' | 'rejected';
    }[]>();

    for (const approval of allApprovals) {
      const principleId = artifactPrincipleMap.get(approval.artifactId) ?? 'unlinked';

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
        status: approval.status as 'pending' | 'approved' | 'rejected',
      });
    }

    const groups: ApprovalGroup[] = [];
    for (const [principleId, records] of groupMap) {
      // Determine overall group status
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

      // Wave 7: extract candidate description from the first record's artifact.
      // This is the human-readable content the Owner needs to make a review decision.
      const firstArtifactId = records[0]?.artifactId;
      const candidateDescription = firstArtifactId
        ? (artifactDescriptionMap.get(firstArtifactId) ?? undefined)
        : undefined;

      groups.push({
        principleId,
        principleTitle,
        candidateDescription,
        status,
        records,
      });
    }

    return {
      groups,
      generatedAt: new Date().toISOString(),
    };
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch (err) { console.warn('ApprovalsGroupedConsoleModel.dispose: failed to close connection:', err instanceof Error ? err.message : String(err)); }
      this.readConnection = null;
    }
  }
}
