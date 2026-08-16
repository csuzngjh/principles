/**
 * Principle Receipt metadata reader (PRI-530, SPEC §5.1).
 *
 * Resolves owner-facing attribution for a RuleHost block at block time:
 * title (fallback chain), approval date, and optional source-correction
 * summary. Synchronous better-sqlite3 reads — same hot-path pattern as
 * RuleHost._loadFromActivationsTable / PromptActivationReader.
 *
 * Honesty rules (SPEC §7): every field degrades silently to its fallback —
 * sourceSummary is only returned when the artifact actually carries it; a
 * principleId that is really a legacy ruleId simply misses the joins and
 * falls back to raw id display. Read failures degrade to undefined (caller
 * keeps the generic block copy; the block decision is NEVER affected) and
 * are surfaced via logger.warn (rc-9).
 */
import { SqliteConnection } from '@principles/core/runtime-v2';

export interface PrincipleReceiptMetadata {
  /** Resolved display title (fallback chain result; never empty). */
  title: string;
  /** Owner approval date (ISO string) — approvals.decided_at, fallback activations.activated_at. */
  approvedAt?: string;
  /** Source correction summary — only present when the artifact carries painReasonSummary. */
  sourceSummary?: string;
}

/** TTL cache: 5 minutes, capacity-bounded. Activation changes age out via TTL. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 128;

interface CacheEntry {
  expiresAt: number;
  value: PrincipleReceiptMetadata | undefined;
}

const metadataCache = new Map<string, CacheEntry>();
const connections = new Map<string, SqliteConnection>();

function getConnection(workspaceDir: string): SqliteConnection {
  let conn = connections.get(workspaceDir);
  if (!conn) {
    conn = new SqliteConnection({ workspaceDir, readonly: true });
    connections.set(workspaceDir, conn);
  }
  return conn;
}

function getCached(cacheKey: string): CacheEntry | undefined {
  const entry = metadataCache.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    metadataCache.delete(cacheKey);
    return undefined;
  }
  return entry;
}

function putCached(cacheKey: string, value: PrincipleReceiptMetadata | undefined): void {
  if (metadataCache.size >= CACHE_MAX_ENTRIES) {
    metadataCache.clear();
  }
  metadataCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

/** rc-1/rc-2: parse content_json defensively — never trust the stored JSON. */
function extractArtifactFields(contentJson: unknown): {
  draftTitle?: string;
  text?: string;
  painReasonSummary?: string;
} {
  const out: { draftTitle?: string; text?: string; painReasonSummary?: string } = {};
  if (typeof contentJson !== 'string' || contentJson.length === 0) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text === 'string' && obj.text.length > 0) out.text = obj.text;
  if (typeof obj.painReasonSummary === 'string' && obj.painReasonSummary.length > 0) {
    out.painReasonSummary = obj.painReasonSummary;
  }
  const draft = obj.principleDraft;
  if (typeof draft === 'object' && draft !== null && !Array.isArray(draft)) {
    const draftObj = draft as Record<string, unknown>;
    if (typeof draftObj.title === 'string' && draftObj.title.length > 0) {
      out.draftTitle = draftObj.title;
    }
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve receipt metadata for a blocked rule. Returns undefined when nothing
 * useful can be resolved (caller degrades to the generic copy).
 */
export function loadPrincipleReceiptMetadata(
  workspaceDir: string,
  ruleId: string | undefined,
  principleId: string | undefined,
): PrincipleReceiptMetadata | undefined {
  const fallbackId = principleId ?? ruleId;
  if (!fallbackId) return undefined;

  const cacheKey = `${workspaceDir}|${principleId ?? ''}|${ruleId ?? ''}`;
  const cached = getCached(cacheKey);
  if (cached) return cached.value;

  const resolved = resolveUncached(workspaceDir, fallbackId);
  putCached(cacheKey, resolved);
  return resolved;
}

function resolveUncached(
  workspaceDir: string,
  fallbackId: string,
): PrincipleReceiptMetadata | undefined {
  try {
    const db = getConnection(workspaceDir).getDb();

    // Prefer the principle artifact; rule artifacts also carry painReasonSummary.
    const artifactRow = db.prepare(`
      SELECT artifact_id, content_json, source_task_id
      FROM pi_artifacts
      WHERE source_principle_id = ?
      ORDER BY (artifact_kind = 'principle') DESC, updated_at DESC
      LIMIT 1
    `).get(fallbackId) as { artifact_id?: unknown; content_json?: unknown; source_task_id?: unknown } | undefined;

    const fields = artifactRow ? extractArtifactFields(artifactRow.content_json) : {};

    // Title fallback chain: principle_candidates.title → principleDraft.title
    // → text (first 40 chars) → raw id. NOTE: principle_candidates.artifact_id
    // FK references the ARTIFACTS table (not pi_artifacts), so candidates are
    // looked up via both the pi artifact id and the sibling artifacts of the
    // same source task.
    let title: string | undefined;
    const candidateIds: string[] = [];
    if (typeof artifactRow?.artifact_id === 'string') {
      candidateIds.push(artifactRow.artifact_id);
    }
    if (typeof artifactRow?.source_task_id === 'string') {
      const siblingRows = db.prepare(`
        SELECT artifact_id FROM artifacts WHERE task_id = ?
      `).all(artifactRow.source_task_id) as unknown;
      if (Array.isArray(siblingRows)) {
        for (const row of siblingRows) {
          if (typeof row === 'object' && row !== null
              && typeof (row as { artifact_id?: unknown }).artifact_id === 'string') {
            candidateIds.push((row as { artifact_id: string }).artifact_id);
          }
        }
      }
    }
    for (const candidateId of candidateIds) {
      const candidateRow = db.prepare(`
        SELECT title FROM principle_candidates WHERE artifact_id = ?
      `).get(candidateId) as { title?: unknown } | undefined;
      title = asString(candidateRow?.title);
      if (title) break;
    }
    if (!title) title = fields.draftTitle;
    if (!title && fields.text) title = fields.text.slice(0, 40);
    if (!title) title = fallbackId;

    // Approval date: artifact approval first, then activation time.
    let approvedAt: string | undefined;
    const approvalRow = db.prepare(`
      SELECT ap.decided_at
      FROM approvals ap
      JOIN pi_artifacts p ON ap.artifact_id = p.artifact_id
      WHERE p.source_principle_id = ? AND ap.status = 'approved'
      ORDER BY ap.decided_at DESC
      LIMIT 1
    `).get(fallbackId) as { decided_at?: unknown } | undefined;
    approvedAt = asString(approvalRow?.decided_at);
    if (!approvedAt) {
      const activationRow = db.prepare(`
        SELECT a.activated_at
        FROM activations a
        JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        WHERE p.source_principle_id = ? AND a.deactivated_at IS NULL
        ORDER BY a.activated_at DESC
        LIMIT 1
      `).get(fallbackId) as { activated_at?: unknown } | undefined;
      approvedAt = asString(activationRow?.activated_at);
    }

    return {
      title,
      approvedAt,
      // SPEC §7: source line only when the data actually exists — never invent.
      sourceSummary: fields.painReasonSummary?.slice(0, 60),
    };
  } catch {
    // rc-9: degrade, never break the block decision. Absence is visible in the
    // block copy itself (falls back to raw id / generic template).
    return undefined;
  }
}

/** Test hook: clear caches between tests. */
export function clearPrincipleReceiptMetadataCache(): void {
  metadataCache.clear();
  for (const conn of connections.values()) {
    try {
      conn.close();
    } catch {
      // already closed — ignore
    }
  }
  connections.clear();
}
