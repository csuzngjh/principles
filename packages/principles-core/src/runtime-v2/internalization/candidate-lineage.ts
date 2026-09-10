/**
 * Layer 2 — CandidateLineage: on-demand ancestry traversal (design §6.4).
 *
 * Pure logic with **injected** I/O (artifact store + task reader). Walks an
 * artifact's ancestry via `lineageArtifactIds`, determining each node's stage
 * by the two-hop `artifact.sourceTaskId → task.taskKind` (F1 — never by
 * `artifactKind`, which is ambiguous: all internalization artifacts are
 * `principle`).
 *
 * Result contract (rc-9, design §6.4 error table):
 *   - data corruption (unparseable / shape-invalid / store-throw) → `ok: false`
 *     + a `LineageError`; the caller MUST surface it as an explicit failure or
 *     structured degradation — never silently fall through.
 *   - expected absence (no lineage ids / ancestor pruned / task missing / depth
 *     limit / cycle) → `ok: true` with a partial chain + notes; `complete` is
 *     false and `notes` is non-empty.
 *
 * Stale-instance rebind (PRI-717): a lineage edge whose artifact id no longer
 * resolves is first checked against the producer-task convention
 * (`pi-art-<taskId>-run_<taskId>_<seq>`); when the producing task still has a
 * current durable artifact, the edge resolves to it and a
 * `lineage_edge_rebound` event is emitted. Everything else stays fail-closed
 * `ancestor_pruned`.
 *
 * Request-scoped cache: a single `CandidateLineage` instance lives for one
 * `buildContext`; repeated `getArtifactById` calls for the same id hit the
 * cache, not the store (CP-18).
 *
 * rc-1: every `contentJson` stays `unknown` — it is never narrowed or cast.
 */

import type { PIArtifactRecord, PIArtifactStore } from './pi-artifact.js';
import type { ArtifactSummary, SummaryRunnerKind } from './artifact-summary.js';
import { SUMMARY_RUNNER_KINDS } from './artifact-summary.js';

// ── Types (design §6.4) ──────────────────────────────────────────────────────

export interface LineageNode {
  readonly artifactId: string;
  readonly taskId: string;
  /** Stage determined by the two-hop sourceTaskId → task.taskKind (F1). */
  readonly taskKind: string;
  readonly runnerKind: SummaryRunnerKind | 'unknown';
  /** rc-1: remains `unknown`; the caller narrows it. */
  readonly contentJson: unknown;
  readonly summary?: ArtifactSummary;
}

export type LineageNoteCode =
  | 'source_trace_missing'
  | 'ancestor_pruned'
  | 'task_missing'
  | 'depth_limit_reached'
  | 'cycle_detected';

export interface LineageNote {
  readonly code: LineageNoteCode;
  readonly artifactId: string;
  readonly detail: string;
}

export interface LineageChain {
  /** From start node upstream, in traversal order. */
  readonly nodes: readonly LineageNode[];
  /** false when notes is non-empty (partial chain). */
  readonly complete: boolean;
  readonly notes: readonly LineageNote[];
}

export type LineageError =
  | { readonly kind: 'content_json_unparseable'; readonly artifactId: string; readonly detail: string }
  | { readonly kind: 'artifact_shape_invalid'; readonly artifactId: string; readonly detail: string }
  | { readonly kind: 'store_failure'; readonly detail: string };

export type LineageResult =
  | { readonly ok: true; readonly value: LineageChain }
  | { readonly ok: false; readonly error: LineageError };

/** Lineage telemetry event (forwarded to the caller's emit, if provided). */
export type LineageEvent =
  | { readonly type: 'lineage_data_corrupt'; readonly artifactId: string; readonly detail: string; readonly errorKind: LineageError['kind'] }
  | { readonly type: 'lineage_store_failure'; readonly detail: string }
  | { readonly type: 'lineage_partial'; readonly artifactId: string; readonly noteCode: LineageNoteCode; readonly detail: string }
  /**
   * A lineage edge referenced a superseded artifact INSTANCE id and was
   * resolved to the producer task's CURRENT artifact (PRI-717). Durable
   * artifact ids embed the producing run (`pi-art-<taskId>-run_<taskId>_<seq>`)
   * and the upsert rewrites the id on every re-run of the same task, so edges
   * captured before an upstream revision dangle even though the logical
   * artifact (UNIQUE(source_task_id, artifact_kind)) still exists. Emitted so
   * the rebind stays observable (rc-9) — it is not a partial-chain note.
   */
  | { readonly type: 'lineage_edge_rebound'; readonly staleArtifactId: string; readonly resolvedArtifactId: string; readonly taskId: string };

/** Two-hop task reader (F1) — resolves taskKind from a taskId. */
export interface LineageTaskReader {
  getTaskById(taskId: string): Promise<{ readonly taskId: string; readonly taskKind: string } | null>;
}

export interface CandidateLineageDeps {
  readonly artifacts: Pick<PIArtifactStore, 'getArtifactById' | 'listBySourceTaskId'>;
  readonly tasks: LineageTaskReader;
  /** Default 6 (longest pipeline chain + 1). */
  readonly maxDepth?: number;
  readonly emit?: (event: LineageEvent) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 6;

const ARTIFACT_ID_PREFIX = 'pi-art-';
const RUN_MARKER = '-run_';

/**
 * Recover the producing task id from a durable artifact INSTANCE id
 * (`pi-art-<taskId>-run_<taskId>_<seq>` — the run id embeds its own task id).
 *
 * Returns null when the id does not follow the producer convention (foreign
 * shape, mismatched run segment, non-numeric sequence); the caller then keeps
 * the fail-closed `ancestor_pruned` path — a non-parseable edge is never
 * silently rebound to a guessed task.
 */
function parseArtifactInstanceTaskId(artifactId: string): string | null {
  if (!artifactId.startsWith(ARTIFACT_ID_PREFIX)) return null;
  const markerIdx = artifactId.lastIndexOf(RUN_MARKER);
  if (markerIdx <= ARTIFACT_ID_PREFIX.length) return null;
  const taskId = artifactId.slice(ARTIFACT_ID_PREFIX.length, markerIdx);
  if (taskId === '') return null;
  // The run segment after the marker must be `run_<taskId>_<digits>` for the
  // same taskId — a mismatch means the id is not a producer-convention id.
  const runSegment = artifactId.slice(markerIdx + 1 + 'run_'.length);
  const expectedRunPrefix = `${taskId}_`;
  if (!runSegment.startsWith(expectedRunPrefix)) return null;
  const seq = runSegment.slice(expectedRunPrefix.length);
  return /^(0|[1-9][0-9]*)$/.test(seq) ? taskId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read an existing ArtifactSummary off a contentJson (Layer 0 envelope), with
 * full value-type validation (rc-2). Returns null when absent or malformed —
 * the node simply carries no `summary`, which is a valid partial state.
 */
function readSummary(contentJson: unknown): ArtifactSummary | undefined {
  if (!isRecord(contentJson) || !Object.hasOwn(contentJson, 'summary')) return undefined;
  const { summary } = contentJson;
  if (!isRecord(summary)) return undefined;
  // rc-2: full value-type validation, then construct a typed object (no as cast).
  if (
    Object.hasOwn(summary, 'schemaVersion') && summary.schemaVersion === 1
    && Object.hasOwn(summary, 'runnerKind') && typeof summary.runnerKind === 'string'
    && (SUMMARY_RUNNER_KINDS as readonly string[]).includes(summary.runnerKind)
    && Object.hasOwn(summary, 'headline') && typeof summary.headline === 'string'
    && Object.hasOwn(summary, 'fields') && isRecord(summary.fields)
    && Object.values(summary.fields).every((v) => typeof v === 'string')
    && Object.hasOwn(summary, 'derivedFrom') && summary.derivedFrom === 'structured_output'
    && Object.hasOwn(summary, 'omittedFields') && Array.isArray(summary.omittedFields)
    && (summary.omittedFields as readonly unknown[]).every((v) => typeof v === 'string')
  ) {
    // runtime-contract-exempt: ERR-001 narrowing after full value-type validation: runnerKind checked against SUMMARY_RUNNER_KINDS, fields checked via Object.values().every(typeof string), omittedFields checked via Array.isArray + every. The casts are type-only — the values are already validated at runtime above.
    return {
      schemaVersion: 1,
      runnerKind: summary.runnerKind as SummaryRunnerKind, // runtime-contract-exempt: ERR-001 validated via SUMMARY_RUNNER_KINDS.includes above
      headline: summary.headline,
      fields: summary.fields as Record<string, string>, // runtime-contract-exempt: ERR-001 validated via Object.values().every(typeof===string) above
      derivedFrom: 'structured_output',
      omittedFields: summary.omittedFields as readonly string[], // runtime-contract-exempt: ERR-001 validated via Array.isArray + every(typeof===string) above
    };
  }
  return undefined;
}

// ── CandidateLineage ─────────────────────────────────────────────────────────

export class CandidateLineage {
  private readonly artifacts: CandidateLineageDeps['artifacts'];
  private readonly tasks: LineageTaskReader;
  private readonly maxDepth: number;
  private readonly emit: (event: LineageEvent) => void;
  /** request-scoped: artifactId → resolved record (or null if known-absent). */
  private readonly cache: Map<string, PIArtifactRecord | null> = new Map();
  /** request-scoped: taskId → resolved taskKind (or null). */
  private readonly taskCache: Map<string, { readonly taskId: string; readonly taskKind: string } | null> = new Map();

  constructor(deps: CandidateLineageDeps) {
    this.artifacts = deps.artifacts;
    this.tasks = deps.tasks;
    this.maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.emit = deps.emit ?? (() => undefined);
  }

  /**
   * Resolve the full ancestry chain starting from `startArtifactId`.
   * Walks `lineageArtifactIds` upstream, building an ordered node list.
   */
  async resolve(startArtifactId: string): Promise<LineageResult> {
    return this.resolveChain(startArtifactId, new Set<string>());
  }

  /**
   * Find the nearest ancestor node with a given `taskKind` (F1 — never by
   * `artifactKind`). Returns `{ ok: true, node: null }` when no ancestor
   * matches (a valid result, not an error).
   */
  async findAncestorByTaskKind(
    startArtifactId: string,
    taskKind: string,
  ): Promise<
    | { readonly ok: true; readonly node: LineageNode | null; readonly notes: readonly LineageNote[] }
    | { readonly ok: false; readonly error: LineageError }
  > {
    const result = await this.resolve(startArtifactId);
    if (!result.ok) return { ok: false, error: result.error };
    const node = result.value.nodes.find((n) => n.taskKind === taskKind) ?? null;
    return { ok: true, node, notes: result.value.notes };
  }

  // ── Internal traversal ─────────────────────────────────────────────────────

  /**
   * Iterative BFS resolution with cycle detection (via `visited`) and depth
   * limiting. `visited` carries artifactIds already resolved (prevents cycles
   * and redundant fetches across the whole traversal, not just one path).
   *
   * Depth counts BFS LEVELS (start = level 0), matching the documented
   * `maxDepth = longest pipeline chain + 1` invariant — not the number of
   * nodes processed. A node-counting loop would stop mid-level on wide chains
   * (the split-diagnostician router fans out to two artifacts per level) and
   * starve deep ancestors of resolution (PRI-717).
   */
  private async resolveChain(
    startArtifactId: string,
    visited: Set<string>,
  ): Promise<LineageResult> {
    const nodes: LineageNode[] = [];
    const notes: LineageNote[] = [];
    // Resolved (post-rebind) artifact ids already emitted as nodes. Distinct
    // edge ids — one stale instance, one current — can resolve to the SAME
    // logical artifact when siblings were written across an upstream
    // revision; the second resolution must be a silent skip, not a duplicate
    // node or a spurious cycle note.
    const seenResolvedIds = new Set<string>();

    // BFS-style frontier of artifact ids to resolve, seeded with the start.
    // Each iteration drains one full LEVEL, then the frontier's next level is
    // the artifacts discovered by that drain.
    const queue: string[] = [startArtifactId];
    let level = 0;

    while (queue.length > 0) {
      // NOTE: a re-queued already-visited id (fan-in diamond — the EP002
      // router topology) is diagnosed as `cycle_detected` when popped. That
      // is the pre-existing diagnostic contract (a true lineage cycle is
      // indistinguishable from a diamond without creation-time ordering);
      // `complete` is advisory only — production consumers gate on `ok` and
      // node reachability, not on `complete`.
      if (level >= this.maxDepth) {
        const [last] = queue;
        notes.push({ code: 'depth_limit_reached', artifactId: last ?? startArtifactId, detail: `maxDepth (${this.maxDepth}) reached; remaining ${queue.length} ancestor(s) not traversed` });
        this.emit({ type: 'lineage_partial', artifactId: last ?? startArtifactId, noteCode: 'depth_limit_reached', detail: `maxDepth ${this.maxDepth}` });
        break;
      }
      const levelSize = queue.length;

      for (let i = 0; i < levelSize; i++) {
        const artifactId = queue.shift();
        if (artifactId === undefined) break;

        // Cycle detection.
        if (visited.has(artifactId)) {
          notes.push({ code: 'cycle_detected', artifactId, detail: `artifact ${artifactId} already on the resolution path` });
          this.emit({ type: 'lineage_partial', artifactId, noteCode: 'cycle_detected', detail: 'cycle detected' });
          continue;
        }
        visited.add(artifactId);

        // Fetch artifact (cached).
        const artifactResult = await this.getArtifactCached(artifactId);
        if (!artifactResult.ok) return artifactResult; // propagate corruption / store failure
        let artifact = artifactResult.value;
        if (artifact === null) {
          // Ancestor referenced but pruned — expected, partial. PRI-717: the
          // edge may reference a superseded INSTANCE id of a task whose
          // logical artifact still exists (id embeds the run; upsert rewrites
          // it on re-run). Attempt one observable rebind before giving up.
          const rebound = await this.tryReboundInstance(artifactId);
          if (!rebound.ok) return rebound;
          artifact = rebound.value;
          if (artifact === null) {
            notes.push({
              code: 'ancestor_pruned',
              artifactId,
              detail: rebound.ambiguousCandidates !== undefined
                ? `ancestor artifact ${artifactId} not rebound: ambiguous current artifacts for source task (${rebound.ambiguousCandidates} same-family candidates) — refusing to pick by array order`
                : `ancestor artifact ${artifactId} not found (pruned)`,
            });
            this.emit({ type: 'lineage_partial', artifactId, noteCode: 'ancestor_pruned', detail: 'artifact not found' });
            continue;
          }
        }
        if (seenResolvedIds.has(artifact.artifactId)) continue;
        seenResolvedIds.add(artifact.artifactId);

        // Parse contentJson (rc-1: stays unknown on success; unparseable = corruption).
        let contentJson: unknown;
        try {
          contentJson = JSON.parse(artifact.contentJson);
        } catch {
          const err: LineageError = { kind: 'content_json_unparseable', artifactId, detail: `contentJson of ${artifactId} is not valid JSON` };
          this.emit({ type: 'lineage_data_corrupt', artifactId, detail: err.detail, errorKind: 'content_json_unparseable' });
          return { ok: false, error: err };
        }

        // Shape check: must have sourceTaskId (rc-3 fail loud on corruption).
        if (typeof artifact.sourceTaskId !== 'string' || artifact.sourceTaskId === '') {
          const err: LineageError = { kind: 'artifact_shape_invalid', artifactId, detail: `artifact ${artifactId} missing required sourceTaskId` };
          this.emit({ type: 'lineage_data_corrupt', artifactId, detail: err.detail, errorKind: 'artifact_shape_invalid' });
          return { ok: false, error: err };
        }

        // Two-hop: sourceTaskId → task.taskKind (F1).
        const taskResult = await this.getTaskCached(artifact.sourceTaskId);
        if (!taskResult.ok) return taskResult;
        const task = taskResult.value;
        let taskKind: string;
        let runnerKind: SummaryRunnerKind | 'unknown';
        if (task === null) {
          taskKind = 'unknown';
          runnerKind = 'unknown';
          notes.push({ code: 'task_missing', artifactId, detail: `task ${artifact.sourceTaskId} not found; cannot determine stage via two-hop` });
          this.emit({ type: 'lineage_partial', artifactId, noteCode: 'task_missing', detail: `task ${artifact.sourceTaskId} missing` });
        } else {
          ({ taskKind } = task);
          runnerKind = (SUMMARY_RUNNER_KINDS as readonly string[]).includes(taskKind)
            ? (taskKind as SummaryRunnerKind)
            : 'unknown';
        }

        const node: LineageNode = {
          // On a rebind the node carries the RESOLVED artifact's identity, not
          // the superseded edge id — downstream stage attribution reads these.
          artifactId: artifact.artifactId,
          taskId: artifact.sourceTaskId,
          taskKind,
          runnerKind,
          contentJson,
          summary: readSummary(contentJson),
        };
        nodes.push(node);

        // Extend frontier with lineage ids (ancestry).
        const lineageIds = Array.isArray(artifact.lineageArtifactIds) ? artifact.lineageArtifactIds : [];
        if (lineageIds.length === 0 && nodes.length === 1) {
          // The start node has no ancestry — not an error, just a short chain.
        }
        for (const id of lineageIds) {
          if (typeof id === 'string' && id !== '') {
            queue.push(id);
          }
        }
      }
      level++;
    }

    return { ok: true, value: { nodes, complete: notes.length === 0, notes } };
  }

  /**
   * PRI-717: attempt to resolve a dangling lineage edge to the producer
   * task's CURRENT artifact. Only fires when the edge id follows the
   * producer convention AND that task still has a durable artifact of the
   * SAME id family; any other outcome keeps the fail-closed
   * `ancestor_pruned` handling in the caller.
   *
   * Review fix (rebind identity): the durable logical identity is
   * (sourceTaskId, artifactKind) — an evaluator task may carry BOTH a
   * `pi-art-…` principle row and a `pi-rule-…` rule row. The stale edge
   * names a `pi-art-` instance of the task, so only the CURRENT instance of
   * the SAME id family is a rebound candidate — never another kind's row
   * and never array order. `matches.length !== 1` (0 = no current instance
   * of this family, >1 = data anomaly against UNIQUE(source_task_id,
   * artifact_kind)) stays fail-closed, with the ambiguity reported back so
   * the caller's note says why — never a silent pick.
   *
   * The rebind result is cached under the STALE id so repeated edges to the
   * same superseded instance stay idempotent within one request (CP-18).
   */
  private async tryReboundInstance(
    staleArtifactId: string,
  ): Promise<
    | { ok: true; value: PIArtifactRecord | null; ambiguousCandidates?: number }
    | { ok: false; error: LineageError }
  > {
    const taskId = parseArtifactInstanceTaskId(staleArtifactId);
    if (taskId === null) return { ok: true, value: null };
    try {
      const candidates = await this.artifacts.listBySourceTaskId(taskId);
      const instancePrefix = `${ARTIFACT_ID_PREFIX}${taskId}-run_`;
      const matches = candidates.filter((candidate) => candidate.artifactId.startsWith(instancePrefix));
      if (matches.length !== 1) {
        return { ok: true, value: null, ...(matches.length > 1 ? { ambiguousCandidates: matches.length } : {}) };
      }
      const [resolved] = matches;
      if (resolved === undefined) return { ok: true, value: null };
      this.cache.set(staleArtifactId, resolved);
      this.emit({
        type: 'lineage_edge_rebound',
        staleArtifactId,
        resolvedArtifactId: resolved.artifactId,
        taskId,
      });
      return { ok: true, value: resolved };
    } catch (storeErr) {
      const err: LineageError = { kind: 'store_failure', detail: storeErr instanceof Error ? storeErr.message : String(storeErr) };
      this.emit({ type: 'lineage_store_failure', detail: err.detail });
      return { ok: false, error: err };
    }
  }

  /** Cached artifact fetch. Returns `ok:false` on store failure or corruption. */
  private async getArtifactCached(
    artifactId: string,
  ): Promise<{ ok: true; value: PIArtifactRecord | null } | { ok: false; error: LineageError }> {
    if (this.cache.has(artifactId)) {
      return { ok: true, value: this.cache.get(artifactId) ?? null };
    }
    try {
      const record = await this.artifacts.getArtifactById(artifactId);
      this.cache.set(artifactId, record);
      return { ok: true, value: record };
    } catch (storeErr) {
      const err: LineageError = { kind: 'store_failure', detail: storeErr instanceof Error ? storeErr.message : String(storeErr) };
      this.emit({ type: 'lineage_store_failure', detail: err.detail });
      return { ok: false, error: err };
    }
  }

  /** Cached task fetch (two-hop). Returns `ok:false` only on reader failure (treated as store_failure). */
  private async getTaskCached(
    taskId: string,
  ): Promise<{ ok: true; value: { readonly taskId: string; readonly taskKind: string } | null } | { ok: false; error: LineageError }> {
    if (this.taskCache.has(taskId)) {
      return { ok: true, value: this.taskCache.get(taskId) ?? null };
    }
    try {
      const task = await this.tasks.getTaskById(taskId);
      this.taskCache.set(taskId, task);
      return { ok: true, value: task };
    } catch (readerErr) {
      const err: LineageError = { kind: 'store_failure', detail: readerErr instanceof Error ? readerErr.message : String(readerErr) };
      this.emit({ type: 'lineage_store_failure', detail: err.detail });
      return { ok: false, error: err };
    }
  }
}
