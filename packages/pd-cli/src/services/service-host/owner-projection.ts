/**
 * Read-only owner projection (SPEC-PD-SERVICE-HOST-001 §8.4).
 *
 * Phase 1 NEVER writes: no owner marker, no generation increment, no CAS
 * transition, no handover, no rollback, no consumer switch. The ONLY facts
 * reported here come from the parsed install manifest's per-Workspace
 * `backgroundExecutions` map, whose fail-closed parser (illegal state /
 * owner / generation combinations are refused at parse time) already ran.
 * A Workspace with no record is the legacy default (§8.4 contract 1);
 * `effectiveOwner=legacy` is reported WITHOUT any claim that a legacy Worker
 * could or should start — Phase 1 starts no Worker (§11 Phase 1 admission
 * boundary).
 */
import * as path from 'node:path';
import type { BackgroundExecutionRecord, InstallManifest } from '@principles/install-layout';

export interface OwnerProjection {
  /**
   * `default_legacy` = no record on ANY alias → the §8.4 legacy default;
   * `record` = exactly one semantically distinct persisted record;
   * `conflicting` = two aliases of the same real Workspace disagree — an
   * explicit invalid state (P1-6), never a silently-picked winner.
   */
  readonly source: 'default_legacy' | 'record' | 'conflicting';
  readonly state: BackgroundExecutionRecord['state'] | 'owner_alias_conflict';
  readonly effectiveOwner: BackgroundExecutionRecord['effectiveOwner'] | 'conflict';
  readonly generation: number;
  readonly operationId: string | null;
  readonly previousOwner: BackgroundExecutionRecord['previousOwner'];
  readonly targetOwner: BackgroundExecutionRecord['targetOwner'];
  readonly updatedAt: string | null;
  /** When `source === 'conflicting'`: the fields that disagree between aliases. */
  readonly conflictDetail?: string;
}

const OWNER_RECORD_FIELDS = [
  'state',
  'effectiveOwner',
  'generation',
  'operationId',
  'previousOwner',
  'targetOwner',
  'updatedAt',
] as const satisfies readonly (keyof BackgroundExecutionRecord)[];

function defaultLegacyProjection(): OwnerProjection {
  return {
    source: 'default_legacy',
    state: 'legacy_owned',
    effectiveOwner: 'legacy',
    generation: 0,
    operationId: null,
    previousOwner: null,
    targetOwner: null,
    updatedAt: null,
  };
}

function recordProjection(record: BackgroundExecutionRecord): OwnerProjection {
  return {
    source: 'record',
    state: record.state,
    effectiveOwner: record.effectiveOwner,
    generation: record.generation,
    operationId: record.operationId,
    previousOwner: record.previousOwner,
    targetOwner: record.targetOwner,
    updatedAt: record.updatedAt,
  };
}

/**
 * Project ownership for ONE real Workspace that the manifest lists under
 * possibly several path aliases (P1-6). `parseWorkspaceList` dedupes only
 * lexically, so two `workspaces[]` entries (a symlink and its target, or two
 * spellings that differ only in Windows case) can name the same real
 * directory, and a `backgroundExecutions` record may be keyed under EITHER
 * alias. Rules:
 *
 *   - no record under any alias → `default_legacy` (the ONLY legacy path);
 *   - one record → that record;
 *   - several aliases all carrying semantically identical records → merged
 *     (they describe one fact);
 *   - two or more DISTINCT records (any of generation / effectiveOwner /
 *     state / operationId / previousOwner / targetOwner / updatedAt differs)
 *     → `conflicting` — an explicit invalid state, NEVER a silent pick of
 *     the first alias. `install.json` itself is never modified.
 */
export function projectWorkspaceOwnerAliases(
  manifest: InstallManifest,
  aliasDirs: readonly string[],
  platform: string = process.platform,
): OwnerProjection {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set<string>();
  const found: { alias: string; record: BackgroundExecutionRecord }[] = [];
  for (const dir of aliasDirs) {
    const key = api.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = manifest.backgroundExecutions?.[key];
    if (record !== undefined) found.push({ alias: key, record });
  }
  if (found.length === 0) return defaultLegacyProjection();
  const [first, ...rest] = found;
  const firstRecord = first?.record;
  if (firstRecord === undefined) return defaultLegacyProjection();
  const differing = new Set<string>();
  for (const other of rest) {
    for (const field of OWNER_RECORD_FIELDS) {
      if (other.record[field] !== firstRecord[field]) differing.add(field);
    }
  }
  if (differing.size === 0) return recordProjection(firstRecord);
  // A Workspace with two disagreeing owner records must surface as
  // conflicting — picking either silently could hide a real service_host
  // assignment behind a legacy alias.
  const fields = [...differing].sort();
  const aliases = found.map((entry) => entry.alias).join('|');
  return {
    source: 'conflicting',
    state: 'owner_alias_conflict',
    effectiveOwner: 'conflict',
    generation: 0,
    operationId: null,
    previousOwner: null,
    targetOwner: null,
    updatedAt: null,
    conflictDetail: `fields[${fields.join(',')}] aliases[${aliases.slice(0, 240)}]`,
  };
}

/**
 * Project the ownership facts for one Workspace by the SAME canonical rule
 * the manifest parser uses (`api.resolve` with the manifest's platform
 * rules). A Workspace absent from the map is the legacy default; a record
 * present in the map is already semantically validated (illegal combinations
 * never parse), so this projection is a plain field copy — no inference, no
 * reinterpretation.
 */
export function projectWorkspaceOwner(
  manifest: InstallManifest,
  workspaceDir: string,
  platform: string = process.platform,
): OwnerProjection {
  return projectWorkspaceOwnerAliases(manifest, [workspaceDir], platform);
}
