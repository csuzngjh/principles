/**
 * Types for scripts/check-core-export-surface.mjs.
 *
 * The guard test lives in packages/principles-core (it must run inside the
 * existing `Test principles-core` job), so it imports the gate as a library.
 * Failure paths are exercised in-process with constructed objects; the CLI is
 * exercised only for the end-to-end clean run and for its own argument rules.
 */

export interface EntrySurface {
  source: string;
  symbols: string[];
}

export interface Surface {
  subpaths: string[];
  entries: Record<string, EntrySurface>;
}

export interface BaselineEntry {
  entry: string;
  source: string;
  count: number;
  symbols: string[];
}

export interface Baseline {
  schemaVersion: number;
  generatedBy?: string;
  subpaths: string[];
  entries: BaselineEntry[];
}

export interface AdmissionException {
  approvedBy?: string;
  reason?: string;
  ticket?: string;
  expiresAt?: string;
}

export interface AdmissionRecord {
  entry: string;
  symbol: string;
  kind: string;
  addedIn: string;
  expiresAt?: string;
  consumers: string[];
  whyNotInternal: string;
  alternativeConsidered: string;
  exception?: AdmissionException;
}

export interface RemovalRecord {
  entry: string;
  symbol: string;
  removedIn: string;
  changeset: string;
}

export interface Admissions {
  schemaVersion: number;
  admissions: AdmissionRecord[];
  removals: RemovalRecord[];
}

export interface EvaluateInput {
  surface: Surface;
  baseline: Baseline;
  anchor: Baseline;
  admissions: Admissions;
  anchorAdmissions?: { admissions?: AdmissionRecord[]; removals?: RemovalRecord[] };
  anchorLabel: string;
  baseChangesets: Set<string>;
  repoRoot?: string;
  today?: string;
}

export interface EvaluationResult {
  ok: boolean;
  errors: string[];
  admitted: { entry: string; symbol: string; record: AdmissionRecord }[];
  removed: { entry: string; symbol: string; record: RemovalRecord }[];
  delta: { added: number; removed: number };
}

export interface AnchorResolution {
  ref?: string;
  commit?: string;
  onBaseBranch?: boolean;
  error?: string;
}

export interface SurfaceDelta {
  added: { entry: string; symbol: string }[];
  removed: { entry: string; symbol: string }[];
}

export interface LoadedReference {
  anchor?: Baseline;
  anchorAdmissions?: { admissions?: AdmissionRecord[]; removals?: RemovalRecord[] };
  error?: string;
}

export function extractEntrySymbols(filePath: string, sourceText: string): string[];
export function collectSurface(repoRoot?: string): Surface;
export function evaluateSurface(input: EvaluateInput): EvaluationResult;
export function buildBaseline(surface: Surface): Baseline;
export function entrySpecifier(entry: string): string;
export function resolveAnchor(repoRoot: string, explicitRef?: string): AnchorResolution;
export function surfaceAtCommit(repoRoot: string, commit: string): Baseline | null;
export function loadReference(repoRoot: string, commit: string): LoadedReference;
export function surfaceDelta(anchor: Baseline, surface: Surface): SurfaceDelta;
export function isCi(env?: Record<string, string | undefined>): boolean;
export function main(
  argv?: string[],
  env?: Record<string, string | undefined>,
  repoRoot?: string,
): number;
