/**
 * Pain Recall read model — SPEC-PD-PAIN-RECALL-CLI-001.
 *
 * Resolves a canonical ledger principle to its verifiably-associated
 * historical pains through the two authoritative edges only:
 *
 *   1. `Principle.reuseEvidence[]` — carries a REAL `painId` (validated at
 *      the ledger write boundary, appendReuseEvidence);
 *   2. `Principle.derivedFromPainIds[]` — stores CANDIDATE ids despite its
 *      legacy pain-oriented name (see PainChainReadModel's linkage note);
 *      the pain resolves through candidate → task → `tasks.input_ref`
 *      (fallback: the `diagnosis_<painId>` task-id spelling).
 *
 * Anything not reachable through those edges is excluded and REPORTED
 * (unresolvedAssociations) — never guessed from text similarity, never
 * resolved through candidateId/taskId/artifactId masquerading as pain ids.
 *
 * Strictly read-only: the ledger through readLedgerFileState, trajectory.db
 * through openTrajectoryDbReadonly, state.db through RuntimeStateManager with
 * readonly:true + bootstrapIfMissing:false. Missing stays missing; unreadable
 * stays unreadable; neither is ever reported as an empty result.
 *
 * WAL safety (SPEC §6.1/§9.2; SPEC-PD-AGENT-CAPABILITY-API-001 v0.3 §10.3.1):
 * both production databases are persisted in WAL journal mode. Any readonly
 * open of a WAL database can touch workspace files — a quiet WAL gains
 * `-wal`/`-shm` sidecars, a missing `-shm` gets created, and an existing
 * `-shm` can be rewritten by WAL-index recovery (all reproduced 2026-10-28 on
 * better-sqlite3 13.0.3, which cannot open `file:` URIs, so SQLite's
 * immutable=1 zero-side-effect mode is unavailable). Therefore EVERY WAL-mode
 * database is read through a staged, fingerprint-verified snapshot in a
 * private temp directory; only rollback-journal databases keep the direct
 * readonly open, which creates nothing. The snapshot copies the main file
 * plus a non-empty `-wal` (the pair SQLite needs to recover un-checkpointed
 * commits; `-shm` is an index cache and is deliberately never copied — the
 * staged open regenerates it beside the copy).
 *
 * Snapshot acceptance contract (proved in stageWalSnapshot): accept only when
 * the staged copies byte-equal the source pair fingerprinted at T0 AND the
 * source pair re-fingerprinted at T1 still byte-equals it — i.e. the staged
 * bytes ARE the endpoint (T1) sample of the source. An ABA rewrite (writer
 * commits, checkpoints, deletes the WAL, and the main file's bytes end up
 * equal to T0) therefore cannot produce a stale acceptance: either a real
 * SQLite commit survived to the endpoint — in which case the file change
 * counter (header offset 24, monotonic under SQLite's own write path) and
 * the checkpointed pages force the endpoint bytes to differ from T0 and the
 * snapshot is rejected — or the bytes genuinely end at the T0 state, in
 * which case the staged copy IS the current database state and returning it
 * is fresh and correct, not stale. Remaining bounds are inherent to
 * uncoordinated cross-file reads, not to this protocol: (a) each (main, wal)
 * sample is two non-atomic reads, so a writer interleaving state-segment
 * switches across both sampling rounds could in principle pair bytes from
 * different moments (a surviving commit moves the main bytes, so such an
 * interleaving must recur across T0 and T1); (b) writes landing after the
 * T1 re-check are not reflected — an "always latest" contract requires
 * writer coordination, which no available mechanism provides honestly (see
 * the implementation report's option analysis for rejected alternatives A-C).
 * Both bounds are disclosed rather than silently assumed away.
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { readLedgerFileState } from '@principles/core/principle-tree-ledger';
import { openTrajectoryDbReadonly } from '@principles/core/trajectory-store';
import { RuntimeStateManager } from '@principles/core/runtime-v2';

export const PAIN_RECALL_SCHEMA_VERSION = 'pd.pain-recall.v1';

export const PAIN_RECALL_DEFAULT_LIMIT = 3;
export const PAIN_RECALL_MIN_LIMIT = 1;
export const PAIN_RECALL_MAX_LIMIT = 10;

export type PainRecallStatus =
  | 'ok'
  | 'no_matches'
  | 'principle_not_found'
  | 'ambiguous_principle'
  | 'pain_not_found'
  | 'source_missing'
  | 'source_unreadable'
  | 'partial';

export type SourceAvailability = 'ok' | 'missing' | 'unreadable' | 'not_checked';

export type AssociationType = 'explicit_reuse' | 'derived_from' | 'multiple_paths';

export interface RecallEvidenceRef {
  kind: 'reuse_evidence' | 'candidate_lineage';
  candidateId: string;
  taskId?: string;
  decidedAt?: string;
  decisionId?: string;
}

export interface RecallAssociation {
  type: AssociationType;
  confidence: 'explicit' | 'lineage_verified';
  evidenceRefs: RecallEvidenceRef[];
}

export interface PainEventView {
  occurredAt: string | null;
  source: string | null;
  host: string;
  score: number | null;
  severity: string | null;
  reason: string | null;
  text: string | null;
  /** A verbatim owner statement is only reported via correctionEvidence; the
   * pain row itself never carries one, so this is structurally null. */
  rawStatement: null;
}

export interface DiagnosisView {
  diagnosisId: string;
  taskId: string;
  category: string;
  rootCause: string;
  supportingEvidence: readonly { sourceRef: string; note: string }[];
  confidence: number | null;
  isOriginalOwnerStatement: false;
}

export interface CorrectionEvidenceView {
  text: string;
  classification?: string;
  channel?: string;
  sessionId?: string;
  occurredAt?: string;
}

export type ItemAvailability = 'available' | 'not_recorded' | 'unreadable';

export interface RecallLineageHop {
  from: string;
  to: string;
  relation: string;
}

export interface PainRecallEntry {
  painId: string;
  association: RecallAssociation;
  pain: PainEventView;
  diagnoses: DiagnosisView[];
  correctionEvidence: CorrectionEvidenceView | null;
  availability: { painEvent: 'available'; diagnoses: ItemAvailability; correctionEvidence: ItemAvailability };
  lineage: RecallLineageHop[];
}

export interface PainRecallQuery {
  requestedPrincipleId: string;
  painId?: string;
  context?: string;
  /** Validated upstream: integer within [1, 10]. */
  limit: number;
}

export interface UnresolvedAssociation {
  painId?: string;
  candidateId?: string;
  reason: string;
}

export interface PainRecallResult {
  schemaVersion: string;
  status: PainRecallStatus;
  /** Sub-reason for pain_not_found: not_associated | pain_event_not_found. */
  statusDetail?: string;
  principle: {
    requestedId: string;
    canonicalId: string | null;
    identityStatus: 'resolved' | 'not_found' | 'ambiguous';
    text?: string;
  };
  query: { limit: number; painId?: string; contextUsedForRanking: boolean; truncated: boolean };
  results: PainRecallEntry[];
  summary: { returned: number; availableCandidates: number; truncated: boolean };
  sources: { ledger: SourceAvailability; trajectoryDb: SourceAvailability; stateDb: SourceAvailability };
  unresolvedAssociations: UnresolvedAssociation[];
}

// ── Internal edge model ──────────────────────────────────────────────────────

interface RawEdge {
  painId: string;
  explicit: boolean;
  ref: RecallEvidenceRef;
}

interface MergedEdge {
  painId: string;
  refs: RecallEvidenceRef[];
  explicit: boolean;
}

function emptyResult(input: {
  query: PainRecallQuery;
  status: PainRecallStatus;
  sources: PainRecallResult['sources'];
  overwrites?: Partial<PainRecallResult>;
}): PainRecallResult {
  const { query, status } = input;
  return {
    schemaVersion: PAIN_RECALL_SCHEMA_VERSION,
    status,
    principle: { requestedId: query.requestedPrincipleId, canonicalId: null, identityStatus: 'not_found' },
    query: {
      limit: query.limit,
      ...(query.painId !== undefined ? { painId: query.painId } : {}),
      contextUsedForRanking: false,
      truncated: false,
    },
    results: [],
    summary: { returned: 0, availableCandidates: 0, truncated: false },
    sources: input.sources,
    unresolvedAssociations: [],
    ...input.overwrites,
  };
}

// ── Deterministic local ranking (no model, no network) ───────────────────────

/** Latin/digit runs plus individual Han characters — deterministic, locale-free. */
function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const han = text.match(/\p{Script=Han}/gu) ?? [];
  return [...tokens, ...han];
}

function contextOverlapScore(contextTokens: ReadonlySet<string>, doc: string): number {
  if (contextTokens.size === 0) return 0;
  const docTokens = new Set(tokenize(doc));
  let score = 0;
  for (const token of contextTokens) {
    if (docTokens.has(token)) score += 1;
  }
  return score;
}

// ── Row guards (rc-1/rc-4: every DB/ledger value is guarded before use) ──────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeParseRecord(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── WAL-aware readonly open planning (strict read-only contract) ────────────

type ReadonlyOpenPlan = 'direct' | 'stage' | 'unverifiable';

/**
 * Deterministic fault-injection seam for snapshot-race tests — the same
 * pattern as the runtime's databaseFactory seam (PR #2192). Every field is
 * undefined in production; tests assign, then clear in a finally block.
 */
export const painRecallSnapshotTestHooks: {
  /** Replaces statSync for fingerprinting/classification (throw to simulate EACCES/EIO). */
  statSync?: (path: string) => fs.Stats;
  /** Replaces mkdtempSync for staging-root creation (throw to simulate failure). */
  mkdtempSync?: (prefix: string) => string;
  /** Called after each source→staging copyFileSync with (source, staged). */
  afterCopyFile?: (source: string, stagedPath: string) => void;
} = {};

function isEnoent(err: unknown): boolean {
  if (!isRecord(err)) return false;
  return Object.hasOwn(err, 'code') && err.code === 'ENOENT';
}

/**
 * Three-state sidecar classification for one file: absent (ENOENT), present
 * (with size + content hash for fingerprinting), or unverifiable (any other
 * stat/hash failure — EACCES, EIO, …). Unverifiable is NEVER interpreted as
 * absent: an undecidable file state fails closed at the caller.
 */
type FileFingerprint =
  | { state: 'absent' }
  | { state: 'present'; size: number; hash: string }
  | { state: 'unverifiable' };

function hashFileStreaming(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(128 * 1024);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(read === chunk.length ? chunk : chunk.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* fd already closed */ }
  }
}

function fingerprintFile(filePath: string): FileFingerprint {
  let stats: fs.Stats;
  try {
    stats = (painRecallSnapshotTestHooks.statSync ?? fs.statSync)(filePath);
  } catch (err: unknown) {
    return isEnoent(err) ? { state: 'absent' } : { state: 'unverifiable' };
  }
  if (!stats.isFile()) return { state: 'unverifiable' };
  const hash = hashFileStreaming(filePath);
  return hash === null ? { state: 'unverifiable' } : { state: 'present', size: stats.size, hash };
}

function fingerprintsMatch(a: FileFingerprint, b: FileFingerprint): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'present' && b.state === 'present') {
    return a.size === b.size && a.hash === b.hash;
  }
  return true; // same non-present state (both absent, or both unverifiable)
}

/** Four-valued WAL sidecar classification (P2-1): absent / quiet (size 0) /
 * active (non-empty — live writer or crash residue) / unverifiable (any
 * stat/hash failure). Unverifiable is never silently "quiet"; the snapshot
 * fails closed on it. */
type WalSidecarState = 'absent' | 'quiet' | 'active' | 'unverifiable';

function classifyWalSidecar(walFingerprint: FileFingerprint): WalSidecarState {
  switch (walFingerprint.state) {
    case 'absent': return 'absent';
    case 'unverifiable': return 'unverifiable';
    case 'present': return walFingerprint.size === 0 ? 'quiet' : 'active';
  }
}

/**
 * Decide how a database may be opened without violating the strict read-only
 * contract. Classification is a plain 100-byte file-header read — no SQLite
 * involvement, no side effects. Any WAL-mode header routes to 'stage': a
 * readonly open of a WAL database can create or rewrite workspace sidecars
 * (missing `-shm`, quiet `-wal`, WAL-index recovery), so the workspace
 * original is never opened directly. A file whose header cannot be read is
 * 'unverifiable' (fail closed); a non-SQLite file is 'direct' so the real
 * open fails exactly as before.
 */
function planReadonlyOpen(dbPath: string): ReadonlyOpenPlan {
  let header: Buffer;
  try {
    const fd = fs.openSync(dbPath, 'r');
    try {
      header = Buffer.alloc(100);
      if (fs.readSync(fd, header, 0, 100, 0) < 100) return 'unverifiable';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'unverifiable';
  }
  if (header.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    return 'direct'; // not a SQLite file: let the real open fail exactly as before
  }
  // Header bytes 18/19 (file format write/read version): 2 = WAL, 1 = rollback journal.
  const walMode = header[18] === 2 || header[19] === 2;
  return walMode ? 'stage' : 'direct';
}

function removeStagingRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Best effort only: a leftover temp dir never affects correctness, and a
    // cleanup failure must not mask the outcome already decided here.
  }
}

type StagedSnapshotOutcome = { ok: true; root: string } | { ok: false };

/**
 * Stage a fingerprint-verified point-in-time snapshot of a WAL-mode database
 * for reading. The workspace original is never opened: everything happens on
 * copies under a private temp root laid out like the workspace (the caller's
 * readonly entry points then read `<root>/<relSegments>`).
 *
 * Consistency contract per snapshot:
 *   1. fingerprint (main, wal) at T0 — existence, size, SHA-256;
 *   2. copy main, plus the `-wal` when it is present and non-empty (the pair
 *      SQLite needs to recover un-checkpointed commits; `-shm` is never
 *      copied — the staged open regenerates it beside the copy);
 *   3. verify the staged copies hash-match the T0 fingerprints;
 *   4. re-fingerprint the source pair at T1 — any drift (file changed,
 *      WAL created/deleted, sizes moved) rejects the snapshot.
 *
 * Acceptance ⇒ staged bytes == the endpoint (T1) sample of the source: the
 * re-check reads the source AT T1, so a matching fingerprint makes the copy
 * byte-identical to the current state, never older. An ABA sequence (commit
 * → checkpoint → wal delete → endpoint bytes back at T0) resolves safely on
 * both branches: a commit that survived to the endpoint moved the main bytes
 * (monotonic file change counter + checkpointed pages) and is rejected; a
 * sequence whose bytes genuinely end at T0 leaves the copy equal to the
 * current state, so returning it is correct. Failure modes — mkdtemp
 * failure, copy failure, fingerprint drift, undecidable file states — all
 * return `{ ok: false }`; the caller reports the source `unreadable`. No
 * sleep, no timing assumptions: tests inject deterministic races through
 * `painRecallSnapshotTestHooks`.
 */
function stageWalSnapshot(sourceDbPath: string, relSegments: readonly string[]): StagedSnapshotOutcome {
  let root: string | null = null;
  let verified = false;
  try {
    const mainFingerprint = fingerprintFile(sourceDbPath);
    const walPath = `${sourceDbPath}-wal`;
    const walFingerprint = fingerprintFile(walPath);
    const walState = classifyWalSidecar(walFingerprint);
    if (mainFingerprint.state !== 'present') return { ok: false }; // missing/unreadable main
    if (walState === 'unverifiable') return { ok: false }; // undecidable wal state (P2-1: fail closed)
    const copyWal = walState === 'active'; // quiet/absent: main alone is complete

    const mkdtemp = painRecallSnapshotTestHooks.mkdtempSync ?? fs.mkdtempSync;
    root = mkdtemp(path.join(os.tmpdir(), 'pd-pain-recall-stage-'));
    const stagedMain = path.join(root, ...relSegments);
    fs.mkdirSync(path.dirname(stagedMain), { recursive: true });
    fs.copyFileSync(sourceDbPath, stagedMain);
    painRecallSnapshotTestHooks.afterCopyFile?.(sourceDbPath, stagedMain);
    if (copyWal) {
      fs.copyFileSync(walPath, `${stagedMain}-wal`);
      painRecallSnapshotTestHooks.afterCopyFile?.(walPath, `${stagedMain}-wal`);
    }

    // The staged bytes must equal what we fingerprinted — a torn or tampered
    // copy is rejected before it can look like a successful read.
    if (!fingerprintsMatch(fingerprintFile(stagedMain), mainFingerprint)) return { ok: false };
    if (copyWal && !fingerprintsMatch(fingerprintFile(`${stagedMain}-wal`), walFingerprint)) {
      return { ok: false };
    }

    // The source pair must still be the fingerprinted pair — a writer that
    // raced the snapshot invalidates it (rc-7: no stale state reuse).
    if (!fingerprintsMatch(fingerprintFile(sourceDbPath), mainFingerprint)) return { ok: false };
    if (!fingerprintsMatch(fingerprintFile(walPath), walFingerprint)) return { ok: false };

    verified = true;
    return { ok: true, root };
  } catch {
    return { ok: false };
  } finally {
    if (root !== null && !verified) removeStagingRoot(root);
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function recallPains(workspaceDir: string, query: PainRecallQuery): Promise<PainRecallResult> {
  // 1. Ledger — the identity authority. Missing/unreadable is a source-level
  //    failure, never a silent empty ledger.
  const ledgerState = readLedgerFileState(path.join(workspaceDir, '.state'));
  const ledgerAvailability: SourceAvailability =
    ledgerState.availability.status === 'ok'
      ? 'ok'
      : ledgerState.availability.status === 'empty'
        ? 'missing'
        : 'unreadable';
  if (ledgerAvailability !== 'ok') {
    return emptyResult({
      query,
      status: ledgerAvailability === 'missing' ? 'source_missing' : 'source_unreadable',
      sources: { ledger: ledgerAvailability, trajectoryDb: 'not_checked', stateDb: 'not_checked' },
    });
  }

  // 2. Canonical identity: exact ledger-key match only. Display titles and
  //    draft ids never resolve (there is no title lookup at all).
  const principleEntry = ledgerState.ledger.tree.principles[query.requestedPrincipleId];
  if (!isRecord(principleEntry) || ownString(principleEntry, 'id') === null) {
    return emptyResult({
      query,
      status: 'principle_not_found',
      sources: { ledger: 'ok', trajectoryDb: 'not_checked', stateDb: 'not_checked' },
    });
  }
  const canonicalId = query.requestedPrincipleId;
  const principleText = ownString(principleEntry, 'text');

  // 3. state.db — strict readonly, no bootstrap. Missing/unreadable keeps the
  //    reuse-evidence edges alive and only degrades lineage + diagnoses.
  //    WAL-mode databases are read through a fingerprint-verified staged
  //    snapshot so nothing in the workspace is opened, created, or modified
  //    (see WAL safety note atop this module).
  const stagedRoots: string[] = [];
  const stateDbPath = path.join(workspaceDir, '.pd', 'state.db');
  let stateDb: SourceAvailability = 'ok';
  let manager: RuntimeStateManager | null = null;
  if (!fs.existsSync(stateDbPath)) {
    stateDb = 'missing';
  } else {
    const plan = planReadonlyOpen(stateDbPath);
    let stateDbAccessRoot = workspaceDir;
    if (plan === 'unverifiable') {
      stateDb = 'unreadable';
    } else if (plan === 'stage') {
      const staged = stageWalSnapshot(stateDbPath, ['.pd', 'state.db']);
      if (!staged.ok) {
        stateDb = 'unreadable';
      } else {
        stagedRoots.push(staged.root);
        stateDbAccessRoot = staged.root;
      }
    }
    if (stateDb === 'ok') {
      try {
        manager = new RuntimeStateManager({ workspaceDir: stateDbAccessRoot, readonly: true, bootstrapIfMissing: false });
        await manager.initialize();
        // getDb() is lazy — force the readonly open NOW so a present-but-corrupt
        // file is classified unreadable instead of surfacing per-query later.
        // SQLite defers the header check to the first statement, hence the
        // read-only liveness probe (SELECT 1 writes nothing).
        manager.connection.getDb().prepare('SELECT 1 AS probe').get();
      } catch {
        manager = null;
        stateDb = 'unreadable';
      }
    }
  }

  try {
    // 4. trajectory.db — the pain-event authority. Missing/unreadable is a
    //    source-level failure (recall's subject is the pain history itself).
    //    Same WAL staging rule as state.db: the workspace original is opened
    //    directly only in rollback-journal mode; any snapshot failure fails
    //    the source as unreadable — never an empty result.
    let trajectoryDb: DatabaseLike;
    try {
      const trajectoryDbPath = path.join(workspaceDir, '.state', 'trajectory.db');
      let trajectoryAccessRoot = workspaceDir;
      if (fs.existsSync(trajectoryDbPath)) {
        const plan = planReadonlyOpen(trajectoryDbPath);
        if (plan === 'unverifiable') {
          throw new Error('readonly_precondition_failed: trajectory.db header state unverifiable');
        }
        if (plan === 'stage') {
          const staged = stageWalSnapshot(trajectoryDbPath, ['.state', 'trajectory.db']);
          if (!staged.ok) {
            throw new Error('readonly_precondition_failed: trajectory.db snapshot could not be verified');
          }
          stagedRoots.push(staged.root);
          trajectoryAccessRoot = staged.root;
        }
      }
      trajectoryDb = openTrajectoryDbReadonly(trajectoryAccessRoot);
      // SQLite defers the file-header check to the first statement (same as
      // state.db above): probe pain_events NOW so a corrupt file or a
      // schema-less database falls into the source_unreadable classification
      // instead of escaping as a raw query error. Close before rethrowing so
      // no handle leaks into the failure path.
      try {
        trajectoryDb.prepare('SELECT 1 FROM pain_events LIMIT 1').get();
      } catch (probeErr: unknown) {
        trajectoryDb.close();
        throw probeErr;
      }
    } catch {
      const missing = !fs.existsSync(path.join(workspaceDir, '.state', 'trajectory.db'));
      return emptyResult({
        query,
        status: missing ? 'source_missing' : 'source_unreadable',
        sources: { ledger: 'ok', trajectoryDb: missing ? 'missing' : 'unreadable', stateDb },
      });
    }

    try {
      // 5. Association edges from the two authoritative sources.
      const unresolved: UnresolvedAssociation[] = [];
      const edges: RawEdge[] = [];

      const {reuseEvidence} = principleEntry;
      if (Array.isArray(reuseEvidence)) {
        for (const entry of reuseEvidence) {
          if (!isRecord(entry)) continue;
          const painId = ownString(entry, 'painId');
          const candidateId = ownString(entry, 'candidateId');
          if (painId === null || candidateId === null) continue; // malformed row: not a verifiable edge
          edges.push({
            painId,
            explicit: true,
            ref: {
              kind: 'reuse_evidence',
              candidateId,
              ...(ownString(entry, 'decidedAt') !== null ? { decidedAt: ownString(entry, 'decidedAt') ?? undefined } : {}),
              ...(ownString(entry, 'decisionId') !== null ? { decisionId: ownString(entry, 'decisionId') ?? undefined } : {}),
            },
          });
        }
      }

      const derivedIds = principleEntry.derivedFromPainIds;
      if (Array.isArray(derivedIds)) {
        for (const value of derivedIds) {
          if (typeof value !== 'string' || value.length === 0) continue;
          const candidateId = value; // candidate id by production contract, despite the field name
          if (manager === null) {
            unresolved.push({ candidateId, reason: 'state_db_unavailable' });
            continue;
          }
          let candidateTaskId: string | null = null;
          try {
            const candidate = await manager.getCandidate(candidateId);
            candidateTaskId = candidate !== null && typeof candidate.taskId === 'string' && candidate.taskId.length > 0
              ? candidate.taskId
              : null;
          } catch {
            unresolved.push({ candidateId, reason: 'candidate_query_failed' });
            continue;
          }
          if (candidateTaskId === null) {
            unresolved.push({ candidateId, reason: 'candidate_not_found' });
            continue;
          }
          let painId: string | null = null;
          try {
            const task = await manager.getTask(candidateTaskId);
            const inputRef = task !== null && typeof task.inputRef === 'string' && task.inputRef.length > 0
              ? task.inputRef
              : null;
            painId = inputRef;
          } catch {
            painId = null;
          }
          if (painId === null && candidateTaskId.startsWith('diagnosis_') && candidateTaskId.length > 'diagnosis_'.length) {
            painId = candidateTaskId.slice('diagnosis_'.length); // authoritative task-id spelling fallback
          }
          if (painId === null) {
            unresolved.push({ candidateId, reason: 'pain_unresolvable_from_candidate' });
            continue;
          }
          edges.push({
            painId,
            explicit: false,
            ref: { kind: 'candidate_lineage', candidateId, taskId: candidateTaskId },
          });
        }
      }

      // 6. Merge by real pain id — all evidence refs survive the merge.
      const merged = new Map<string, MergedEdge>();
      for (const edge of edges) {
        const existing = merged.get(edge.painId);
        if (existing) {
          existing.refs.push(edge.ref);
          existing.explicit = existing.explicit || edge.explicit;
        } else {
          merged.set(edge.painId, { painId: edge.painId, refs: [edge.ref], explicit: edge.explicit });
        }
      }

      // 7. Pain events: an edge whose pain has no persisted event is reported,
      //    not returned, and not silently dropped.
      const painRows = new Map<string, Record<string, unknown>>();
      const selectPain = trajectoryDb.prepare(
        'SELECT id, source, score, severity, text, reason, canonical_pain_id, runtime_task_id, host_kind, created_at FROM pain_events WHERE canonical_pain_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      );
      for (const painId of [...merged.keys()]) {
        const row = selectPain.get(painId);
        if (!isRecord(row)) {
          unresolved.push({ painId, reason: 'pain_event_not_found' });
          merged.delete(painId);
        } else {
          painRows.set(painId, row);
        }
      }

      // 8. --pain-id: filters WITHIN the verified association set only.
      if (query.painId !== undefined) {
        if (!merged.has(query.painId)) {
          const exists = isRecord(selectPain.get(query.painId) ?? null);
          return emptyResult({
            query,
            status: 'pain_not_found',
            sources: { ledger: 'ok', trajectoryDb: 'ok', stateDb },
            overwrites: { statusDetail: exists ? 'not_associated' : 'pain_event_not_found' },
          });
        }
        for (const painId of [...merged.keys()]) {
          if (painId !== query.painId) merged.delete(painId);
        }
      }

      // 9. Per-pain enrichment (diagnoses + persisted correction evidence).
      const entries: PainRecallEntry[] = [];
      for (const [painId, edge] of merged) {
        const row = painRows.get(painId);
        if (!isRecord(row)) continue; // step 7 guaranteed presence; guard anyway (rc-1)
        const pain: PainEventView = {
          occurredAt: ownString(row, 'created_at'),
          source: ownString(row, 'source'),
          host: ownString(row, 'host_kind') ?? 'unknown',
          score: typeof row.score === 'number' ? row.score : null,
          severity: ownString(row, 'severity'),
          reason: ownString(row, 'reason'),
          text: ownString(row, 'text'),
          rawStatement: null,
        };

        let diagnoses: DiagnosisView[] = [];
        // Every branch below assigns this before use (CodeQL useless-init).
        let diagnosesAvailability: ItemAvailability;
        let correction: CorrectionEvidenceView | null = null;
        // Initializer is meaningful: a successful read with no persisted
        // correction evidence keeps this 'not_recorded'.
        let correctionAvailability: ItemAvailability = 'not_recorded';
        if (manager === null) {
          diagnosesAvailability = 'unreadable';
          correctionAvailability = 'unreadable';
        } else {
          try {
            const records = await manager.getDiagnosesByPainId(painId);
            diagnoses = records.map((record) => ({
              diagnosisId: record.diagnosisId,
              taskId: record.taskId,
              category: record.category,
              rootCause: record.rootCause,
              supportingEvidence: record.evidence.map((e) => ({ sourceRef: e.sourceRef, note: e.note })),
              confidence: record.confidence,
              isOriginalOwnerStatement: false as const,
            }));
            diagnosesAvailability = diagnoses.length > 0 ? 'available' : 'not_recorded';
          } catch {
            diagnosesAvailability = 'unreadable';
          }
          try {
            const diagnosisTask = await manager.getTask(`diagnosis_${painId}`);
            const payload = diagnosisTask !== null && typeof diagnosisTask.diagnosticJson === 'string'
              ? safeParseRecord(diagnosisTask.diagnosticJson)
              : null;
            const persisted = payload !== null ? payload.correctionEvidence : undefined;
            if (isRecord(persisted) && typeof persisted.text === 'string' && persisted.text.length > 0) {
              correction = {
                text: persisted.text,
                ...(ownString(persisted, 'classification') !== null ? { classification: ownString(persisted, 'classification') ?? undefined } : {}),
                ...(ownString(persisted, 'channel') !== null ? { channel: ownString(persisted, 'channel') ?? undefined } : {}),
                ...(ownString(persisted, 'sessionId') !== null ? { sessionId: ownString(persisted, 'sessionId') ?? undefined } : {}),
                ...(ownString(persisted, 'occurredAt') !== null ? { occurredAt: ownString(persisted, 'occurredAt') ?? undefined } : {}),
              };
              correctionAvailability = 'available';
            }
          } catch {
            correctionAvailability = 'unreadable';
          }
        }

        const type: AssociationType = edge.refs.length > 1
          ? 'multiple_paths'
          : edge.explicit
            ? 'explicit_reuse'
            : 'derived_from';
        const lineage: RecallLineageHop[] = [];
        for (const ref of edge.refs) {
          if (ref.kind === 'candidate_lineage') {
            lineage.push({ from: `principle:${canonicalId}`, to: ref.candidateId, relation: 'derived_from_pain_ids' });
            lineage.push({ from: ref.candidateId, to: painId, relation: 'task_input_ref' });
          } else {
            lineage.push({ from: `principle:${canonicalId}`, to: painId, relation: 'reuse_evidence_pain_id' });
          }
        }

        entries.push({
          painId,
          association: {
            type,
            confidence: edge.explicit ? 'explicit' : 'lineage_verified',
            evidenceRefs: edge.refs,
          },
          pain,
          diagnoses,
          correctionEvidence: correction,
          availability: { painEvent: 'available', diagnoses: diagnosesAvailability, correctionEvidence: correctionAvailability },
          lineage,
        });
      }

      // 10. Deterministic ranking. Default: explicit evidence first, then
      //     newest pain first, then pain id. --context only re-orders this
      //     list by local token overlap — it never adds associations.
      const contextTokens = new Set(typeof query.context === 'string' ? tokenize(query.context) : []);
      const contextUsed = contextTokens.size > 0;
      const rankOf = (entry: PainRecallEntry): number => (entry.association.confidence === 'explicit' ? 0 : 1);
      const scored = entries.map((entry) => ({
        entry,
        score: contextUsed
          ? contextOverlapScore(
              contextTokens,
              [entry.pain.reason ?? '', entry.pain.text ?? '', ...entry.diagnoses.map((d) => d.rootCause)].join(' '),
            )
          : 0,
      }));
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const rankDelta = rankOf(a.entry) - rankOf(b.entry);
        if (rankDelta !== 0) return rankDelta;
        const aTime = a.entry.pain.occurredAt ?? '';
        const bTime = b.entry.pain.occurredAt ?? '';
        if (aTime !== bTime) return aTime < bTime ? 1 : -1; // newest first
        return a.entry.painId < b.entry.painId ? -1 : 1;
      });
      const ranked = scored.map((s) => s.entry);

      // 11. Limit + truncation.
      const truncated = ranked.length > query.limit;
      const results = ranked.slice(0, query.limit);

      // 12. Top-level status: distinguish "nothing recorded" from "cannot read".
      let status: PainRecallStatus;
      if (results.length === 0) {
        status = unresolved.length > 0 ? 'partial' : 'no_matches';
      } else {
        const degraded = results.some(
          (r) => r.availability.diagnoses === 'unreadable' || r.availability.correctionEvidence === 'unreadable',
        );
        status = degraded ? 'partial' : 'ok';
      }

      return {
        schemaVersion: PAIN_RECALL_SCHEMA_VERSION,
        status,
        principle: {
          requestedId: query.requestedPrincipleId,
          canonicalId,
          identityStatus: 'resolved',
          ...(principleText !== null ? { text: principleText } : {}),
        },
        query: {
          limit: query.limit,
          ...(query.painId !== undefined ? { painId: query.painId } : {}),
          contextUsedForRanking: contextUsed,
          truncated,
        },
        results,
        summary: { returned: results.length, availableCandidates: ranked.length, truncated },
        sources: { ledger: 'ok', trajectoryDb: 'ok', stateDb },
        unresolvedAssociations: unresolved,
      };
    } finally {
      trajectoryDb.close();
    }
  } finally {
    if (manager !== null) {
      await manager.close().catch(() => undefined);
    }
    for (const root of stagedRoots) {
      removeStagingRoot(root);
    }
  }
}

/** Minimal structural type for the readonly trajectory connection. */
interface DatabaseLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}
