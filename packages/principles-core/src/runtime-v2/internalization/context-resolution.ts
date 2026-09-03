/**
 * Shared Information Plane — context resolution composition (design §6.4/§6.6).
 *
 * Pure logic only: no I/O, no fs, no DB, no network (Core vs Plugin boundary,
 * AGENTS.md `antipattern-core-io`).
 *
 * This module is the seam that turns three independent fact-acquisition
 * channels into ONE `available` map consumed by `resolveInjection`:
 *
 *   1. predecessor summary envelope → `summary-field-reader` (pure, Layer 1)
 *   2. ancestry content             → `CandidateLineage` nodes (Layer 2; the
 *                                     traversal/I/O is owned by the caller).
 *                                     Serves BOTH `<stage>.raw.*` and
 *                                     `<stage>.summary.*` for any ancestor.
 *   3. related references           → explicit caller-provided sources
 *                                     (e.g. the PR-A replay evidence), which
 *                                     are causal references — NOT ancestry
 *
 * Why three channels stay separate at acquisition but merge at composition
 * (design §33 / INV-LINEAGE-SCOPE): `lineageArtifactIds` expresses *content
 * ancestry*; a repair's `sourceEvaluatorTaskId` expresses *causal reference*.
 * Collapsing them into one data structure would silently redefine what
 * "lineage" means. They are unified at read time, never at write time.
 *
 * rc-1/rc-5: every source `contentJson` stays `unknown`; all reads use
 * `Object.hasOwn` + typeof/Array.isArray guards — no `as` casts.
 */

import type { TruncationRecord } from './prompt-budget-manager.js';
import { readSummaryField } from './summary-field-reader.js';

// ── Path grammar ────────────────────────────────────────────────────────────

/**
 * Context field path grammar (design §6.6, extended for tier2 + related refs):
 *   `<ns>.summary.<key>`            — ArtifactSummary / related summary table
 *   `<ns>.predecessorSummary.<key>` — forwarded predecessor summary
 *   `<ns>.raw.<dotted.path>`        — full contentJson (ancestry) or a related
 *                                     raw table (related refs)
 */
export type ContextPathLayer = 'raw' | 'summary' | 'predecessorSummary';

export interface ParsedContextPath {
  readonly namespace: string;
  readonly layer: ContextPathLayer;
  /** Path segments after the layer marker. Empty is never valid. */
  readonly rest: readonly string[];
}

/**
 * Split a manifest field path into namespace / layer / rest.
 * Returns null for paths that do not follow the grammar (e.g. malformed,
 * too short) so callers can skip them instead of throwing.
 */
export function parseContextPath(fieldPath: string): ParsedContextPath | null {
  const parts = fieldPath.split('.');
  if (parts.length < 3) return null;
  const [namespace, layer] = parts;
  const rest = parts.slice(2);
  if (namespace === undefined || namespace === '') return null;
  if (layer !== 'raw' && layer !== 'summary' && layer !== 'predecessorSummary') return null;
  if (rest.length === 0 || rest.some((segment) => segment === '')) return null;
  return { namespace, layer, rest };
}

// ── Pure raw field reader (design §16–§18) ──────────────────────────────────

/**
 * Keys that must never be traversed: reading them is how prototype pollution
 * enters a context map. Rejected at every segment, not just the first.
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A dotted segment addressing an array element, e.g. `0` in `candidates.0`. */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Read a dotted path out of an untrusted contentJson (rc-1/rc-5).
 *
 * Supports array element addressing via numeric segments
 * (`candidates.0.betterDecision`) because several durable artifacts nest their
 * semantic payload under an array (DreamerOutput.candidates). No I/O, no
 * lineage traversal, no manifest knowledge — it only walks a path.
 *
 * Returns undefined for: non-object intermediates, missing own properties,
 * out-of-range or non-numeric array access, and forbidden keys.
 */
export function readRawField(
  rawPath: readonly string[],
  contentJson: unknown,
): unknown | undefined {
  let current: unknown = contentJson;
  for (const segment of rawPath) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;

    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return undefined;
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }

    if (!isRecord(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

// ── Channel 2: ancestry raw resolution (CandidateLineage) ───────────────────

/**
 * One durable ancestry node exposed to the raw reader. Built by the caller
 * from `CandidateLineage` nodes — this module never performs the traversal.
 *
 * `stage` is the two-hop `sourceTaskId → task.taskKind` value (design §6.4,
 * F1), never `artifactKind`: every internalization artifact is `principle`,
 * so `artifactKind` carries no stage authority.
 */
export interface RawStageSource {
  readonly stage: string;
  /** rc-1: stays `unknown`; narrowed only by `readRawField`. */
  readonly contentJson: unknown;
}

/**
 * Convert CandidateLineage nodes into raw stage sources.
 *
 * Order is preserved, which is what makes stage selection deterministic:
 * `CandidateLineage.resolve` walks BFS from the start artifact, so the FIRST
 * node matching a stage is the NEAREST ancestor (design §20). Later duplicates
 * are ignored — never a positional/arbitrary pick.
 *
 * Nodes whose stage could not be determined (`taskKind === 'unknown'`) carry no
 * stage authority and are dropped.
 */
export function toRawStageSources(
  nodes: readonly { readonly taskKind: string; readonly contentJson: unknown }[],
): readonly RawStageSource[] {
  const sources: RawStageSource[] = [];
  for (const node of nodes) {
    if (node.taskKind === 'unknown' || node.taskKind === '') continue;
    sources.push({ stage: node.taskKind, contentJson: node.contentJson });
  }
  return sources;
}

/**
 * Split a manifest's tier2 into (ancestry raw paths, related raw paths).
 *
 * Related namespaces are excluded from the ancestry walk explicitly: a related
 * reference is a causal pointer supplied by the caller, so it must never be
 * mistaken for an ancestor stage — even if a taskKind happened to share the
 * name. This is the executable form of INV-LINEAGE-SCOPE (design §33).
 */
export function partitionTier2Paths(
  tier2Paths: readonly string[],
  relatedNamespaces: readonly string[],
): { readonly ancestry: readonly string[]; readonly related: readonly string[] } {
  const related = new Set(relatedNamespaces);
  const ancestry: string[] = [];
  const relatedPaths: string[] = [];
  for (const fieldPath of tier2Paths) {
    const parsed = parseContextPath(fieldPath);
    if (parsed !== null && parsed.layer === 'raw' && related.has(parsed.namespace)) {
      relatedPaths.push(fieldPath);
      continue;
    }
    ancestry.push(fieldPath);
  }
  return { ancestry, related: relatedPaths };
}

/**
 * Resolve ancestor-declared paths against ancestry sources — BOTH layers:
 *
 *   `<stage>.raw.<dotted.path>` — full contentJson walk (`readRawField`)
 *   `<stage>.summary.<key>`     — the ancestor's own Layer 0 envelope
 *                                 (`readSummaryField`)
 *
 * Why the summary layer needs the ancestry channel too (PR B, evidence-backed):
 * `readSummaryField` deliberately STRIPS the leading `<stage>.` namespace and
 * reads only its single `predecessorContentJson`. That convention is correct
 * for manifests whose stage namespace is the runner's direct predecessor
 * (dreamer/scribe/artificer), but a manifest that names an ancestor further up
 * the chain (the Evaluator's `scribe.*` / `dreamer.*` / `diagnostician.*`)
 * would otherwise have those paths structurally unreachable — they would land
 * in `absent` forever and force the information-floor fallback on every run.
 * The lineage walk already holds every ancestor's contentJson, so the same
 * traversal that serves `raw` also serves `summary`, with no extra store read.
 *
 * First (nearest) matching stage wins; unresolvable paths are omitted so the
 * caller's information-floor logic records them in `absent`.
 *
 * `predecessorSummary` is intentionally NOT answered here: it is the
 * direct-predecessor forwarding concept owned by Channel 1.
 */
export function resolveAncestryPaths(
  fieldPaths: readonly string[],
  sources: readonly RawStageSource[],
): ReadonlyMap<string, unknown> {
  const resolved = new Map<string, unknown>();
  for (const fieldPath of fieldPaths) {
    const parsed = parseContextPath(fieldPath);
    if (parsed === null) continue;
    if (parsed.layer === 'predecessorSummary') continue;
    const source = sources.find((candidate) => candidate.stage === parsed.namespace);
    if (source === undefined) continue;
    const value = parsed.layer === 'raw'
      ? readRawField(parsed.rest, source.contentJson)
      : readSummaryField(fieldPath, source.contentJson);
    if (value !== undefined) resolved.set(fieldPath, value);
  }
  return resolved;
}

// ── Channel 3: related (causal) references ──────────────────────────────────

/**
 * A related — NOT ancestral — fact source, exposed under its own namespace.
 *
 * Deliberately narrow: a flat namespace with two flat lookup tables. It is not
 * a relation graph and cannot express arbitrary edges. Each source is supplied
 * explicitly by the caller, so nothing is discovered or inferred at read time.
 *
 * Values are already-bounded objects: this seam never re-expands a durable
 * artifact. For replay evidence the caller passes the PR-A
 * `RepairReplayContext`, whose ≤16 bound (MAX_REPLAY_FAILURES_IN_REPAIR) is
 * therefore preserved through the information plane (design §43).
 */
export interface RelatedContextSource {
  /** Manifest namespace this source answers, e.g. `replay`. */
  readonly namespace: string;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * Resolve `<ns>.summary.<key>` / `<ns>.raw.<key>` against related sources.
 * Related refs expose flat keys only — a multi-segment rest path is not a
 * related reference and is skipped (it belongs to the ancestry reader).
 */
export function resolveRelatedPaths(
  fieldPaths: readonly string[],
  sources: readonly RelatedContextSource[],
): ReadonlyMap<string, unknown> {
  const resolved = new Map<string, unknown>();
  for (const fieldPath of fieldPaths) {
    const parsed = parseContextPath(fieldPath);
    if (parsed === null) continue;
    if (parsed.rest.length !== 1) continue;
    if (parsed.layer === 'predecessorSummary') continue;
    const source = sources.find((candidate) => candidate.namespace === parsed.namespace);
    if (source === undefined) continue;
    const table = parsed.layer === 'raw' ? source.raw : source.summary;
    if (table === undefined) continue;
    const [key] = parsed.rest;
    if (key === undefined || FORBIDDEN_SEGMENTS.has(key)) continue;
    if (!Object.hasOwn(table, key)) continue;
    const value = table[key];
    if (value !== undefined) resolved.set(fieldPath, value);
  }
  return resolved;
}

// ── Composition ─────────────────────────────────────────────────────────────

/**
 * Merge the channel maps into one `available` map. FIRST WRITER WINS: the
 * predecessor summary envelope is the highest-authority local source, then
 * ancestry raw, then related. Channel namespaces are disjoint by construction
 * (a path is either a summary path, an ancestry raw path, or a related path),
 * so the rule only matters defensively — but it keeps the result deterministic.
 */
export function mergeContextFields(
  base: ReadonlyMap<string, unknown>,
  extras: readonly ReadonlyMap<string, unknown>[],
): ReadonlyMap<string, unknown> {
  const merged = new Map<string, unknown>(base);
  for (const extra of extras) {
    for (const [fieldPath, value] of extra) {
      if (!merged.has(fieldPath)) merged.set(fieldPath, value);
    }
  }
  return merged;
}

// ── Information floor: required-evidence gate (design §33–§37) ──────────────

/**
 * Required paths that did NOT reach the prompt — either absent from the
 * available map or dropped/truncated by the budget.
 *
 * This is the regression guard for "Stage2 enabled + raw fields silently
 * absent": a required field that was truncated by `PromptBudgetManager` counts
 * as unresolved just like an absent one, because the runner's semantic
 * requirement was still not met.
 */
export function findUnresolvedRequiredPaths(params: {
  readonly required: readonly string[];
  readonly absent: readonly string[];
  readonly truncated: readonly TruncationRecord[];
}): readonly string[] {
  const absentPaths = new Set(params.absent);
  const truncatedPaths = new Set(params.truncated.map((record) => record.fieldPath));
  return params.required.filter(
    (path) => absentPaths.has(path) || truncatedPaths.has(path),
  );
}
