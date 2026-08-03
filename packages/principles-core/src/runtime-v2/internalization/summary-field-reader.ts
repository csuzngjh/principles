/**
 * Layer 1 — summary field reader (design §6.6 read-side convention).
 *
 * Pure logic only (Core vs Plugin boundary). Builds the `available` map that
 * `allocateContext` / `resolveInjection` consume, from a runner's loaded
 * predecessor contentJson (which carries the Layer 0 `summary` /
 * `predecessorSummary` envelope).
 *
 * Path convention (design §6.6):
 *   `<stage>.summary.headline`        → contentJson.summary.headline
 *   `<stage>.summary.<key>`           → contentJson.summary.fields[key]
 *   `<stage>.predecessorSummary.headline` → contentJson.predecessorSummary.summary.headline
 *   `<stage>.predecessorSummary.<key>`    → contentJson.predecessorSummary.summary.fields[key]
 *
 * The leading `<stage>.` segment is a logical namespace (pain / dreamer /
 * philosopher / scribe / artificer / diagnosis); the reader does NOT look up
 * the stage by name — it resolves `summary.*` / `predecessorSummary.*` against
 * whatever predecessor contentJson the caller loaded. This is correct because
 * each runner's manifest only references paths whose stage maps to that
 * runner's actual loaded predecessor (e.g. dreamer's manifest references
 * pain.summary.* / diagnosis.summary.* which arrive via the diag_router
 * predecessor's summary + its forwarded predecessorSummary).
 *
 * rc-1 / rc-5: contentJson is `unknown`; all reads use `Object.hasOwn` and
 * typeof guards, never `as` casts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read `headline` or `<key>` from contentJson.summary. */
function readFromSummary(contentJson: unknown, subPath: string): unknown | undefined {
  if (!isRecord(contentJson) || !Object.hasOwn(contentJson, 'summary')) return undefined;
  const { summary } = contentJson;
  if (!isRecord(summary)) return undefined;

  // subPath is a bare field key (e.g. 'riskLevel') or 'headline'. The summary
  // envelope (Layer 0 ArtifactSummary) stores structured fields on `summary.fields`
  // and headline on `summary.headline`. Manifest paths use `<stage>.summary.<key>`
  // WITHOUT a `fields.` prefix (design §6.6), so read `fields.<subPath>` first,
  // then fall back to `summary.<subPath>` (covers headline + any flat values).
  if (subPath === 'headline') {
    return Object.hasOwn(summary, 'headline') ? summary.headline : undefined;
  }
  const fields = Object.hasOwn(summary, 'fields') ? summary.fields : undefined;
  if (isRecord(fields) && Object.hasOwn(fields, subPath)) {
    return fields[subPath];
  }
  if (Object.hasOwn(summary, subPath)) {
    return summary[subPath];
  }
  return undefined;
}

/** Read `headline` or `<key>` from contentJson.predecessorSummary.summary. */
function readFromPredecessorSummary(contentJson: unknown, subPath: string): unknown | undefined {
  if (!isRecord(contentJson) || !Object.hasOwn(contentJson, 'predecessorSummary')) return undefined;
  const { predecessorSummary: pred } = contentJson;
  if (!isRecord(pred) || !Object.hasOwn(pred, 'summary')) return undefined;
  // Delegate to readFromSummary on the predecessorSummary's own summary.
  return readFromSummary(pred, subPath);
}

/** Read a value nested under `summary` or `predecessorSummary` from contentJson. */
export function readSummaryField(
  fieldPath: string,
  predecessorContentJson: unknown,
): unknown | undefined {
  // Strip the leading `<stage>.` namespace segment(s). A path like
  // `pain.summary.rootSymptom` becomes `summary.rootSymptom`; a path like
  // `philosopher.predecessorSummary.betterDecision` becomes
  // `predecessorSummary.betterDecision`. The namespace can be multi-segment
  // (e.g. `dreamer.raw.candidates`), so strip everything up to and including
  // the first occurrence of `summary.` or `predecessorSummary.` or `raw.`.
  const summaryIdx = fieldPath.indexOf('summary.');
  const predIdx = fieldPath.indexOf('predecessorSummary.');
  const rawIdx = fieldPath.indexOf('raw.');

  // tier2 raw.* paths are NOT resolvable at Layer 1 (they need Layer 2
  // CandidateLineage). Return undefined → the path enters `absent`.
  if (rawIdx >= 0 && (summaryIdx < 0 || rawIdx < summaryIdx) && (predIdx < 0 || rawIdx < predIdx)) {
    return undefined;
  }

  if (predIdx >= 0 && (summaryIdx < 0 || predIdx < summaryIdx)) {
    const subPath = fieldPath.slice(predIdx + 'predecessorSummary.'.length);
    return readFromPredecessorSummary(predecessorContentJson, subPath);
  }
  if (summaryIdx >= 0) {
    const subPath = fieldPath.slice(summaryIdx + 'summary.'.length);
    return readFromSummary(predecessorContentJson, subPath);
  }
  return undefined;
}

/**
 * Build the `available` map for allocateContext/resolveInjection from the
 * manifest's declared paths and a single loaded predecessor contentJson.
 *
 * Paths not resolvable from this predecessor (including tier2 `raw.*` and
 * stages not represented in the loaded object) are simply omitted from the
 * map — allocateContext then records them in `absent`.
 */
export function buildAvailableMap(
  manifestPaths: readonly string[],
  predecessorContentJson: unknown,
): ReadonlyMap<string, unknown> {
  const map = new Map<string, unknown>();
  for (const path of manifestPaths) {
    const value = readSummaryField(path, predecessorContentJson);
    if (value !== undefined) {
      map.set(path, value);
    }
  }
  return map;
}
