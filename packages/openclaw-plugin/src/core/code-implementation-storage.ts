/**
 * Code Implementation Asset Storage
 * ================================
 *
 * Manages versioned code implementation assets: manifests, entry files,
 * and metadata pointers for Implementation(type=code) records.
 *
 * DESIGN CONSTRAINTS (per D-09 through D-12):
 *   - Manifest is loading metadata, NOT the source of truth for lifecycle state (D-11)
 *   - The Principle Tree ledger remains canonical for lifecycle and relationships (D-11)
 *   - Asset root follows the PD stateDir convention:
 *     {stateDir}/principles/implementations/{implId}/
 *   - All writes use withLock for atomicity (matching ledger pattern)
 *   - This module does NOT implement replay execution, evaluation report generation,
 *     or promotion logic (D-12)
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Manifest shape for a code implementation's filesystem assets.
 * Subordinate to the ledger per D-11: does NOT store lifecycleState.
 */
export interface CodeImplementationManifest {
  /** Asset version (distinct from Implementation.version in the ledger) */
  version: string;
  /** Relative filename of the entry point (e.g., 'entry.js') */
  entryFile: string;
  /** ISO timestamp of initial creation */
  createdAt: string;
  /** ISO timestamp of last manifest update */
  updatedAt: string;
  /** Fingerprints of samples this implementation was tested against */
  replaySampleRefs: string[];
  /** Relative path to most recent eval report, or null */
  lastEvalReportRef: string | null;
  /** Provenance carried with the generated candidate assets */
  lineage?: CodeImplementationLineageMetadata;
}

export interface CodeImplementationLineageMetadata {
  principleId: string;
  ruleId: string;
  sourceSnapshotRef: string;
  sourcePainIds: string[];
  sourceGateBlockIds: string[];
  sourceSessionId: string;
  artificerArtifactId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_FILENAME = 'manifest.json';
const ENTRY_FILENAME = 'entry.js';
const REPLAYS_DIRNAME = 'replays';

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that an implId contains no path separators.
 * implId comes from ledger record IDs (controlled namespace), but we
 * validate to prevent path traversal (T-12-08).
 */
function validateImplId(implId: string): void {
  if (implId.includes('/') || implId.includes('\\') || implId.includes('..')) {
    throw new Error(`Invalid implementation ID: "${implId}" contains path separators`);
  }
  if (!implId) {
    throw new Error('Implementation ID must not be empty');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the absolute path for an implementation's asset root.
 * Convention: {stateDir}/principles/implementations/{implId}/
 */
export function getImplementationAssetRoot(stateDir: string, implId: string): string {
  validateImplId(implId);
  return path.join(stateDir, 'principles', 'implementations', implId);
}

/**
 * Load manifest from disk. Returns null if not found (does not throw).
 */
export function loadManifest(stateDir: string, implId: string): CodeImplementationManifest | null {
  validateImplId(implId);
  const manifestPath = path.join(getImplementationAssetRoot(stateDir, implId), MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CodeImplementationManifest;
  } catch {
    return null;
  }
}

/**
 * Write manifest atomically using withLock.
 */
export function writeManifest(
  stateDir: string,
  implId: string,
  manifest: CodeImplementationManifest,
): void {
  validateImplId(implId);
  const assetRoot = getImplementationAssetRoot(stateDir, implId);
  const manifestPath = path.join(assetRoot, MANIFEST_FILENAME);
  ensureDir(assetRoot);
  withLock(manifestPath, () => {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  });
}

 
 
export function writeEntrySource(
  stateDir: string,
  implId: string,
  sourceCode: string,
  entryFile = ENTRY_FILENAME,
): void {
  validateImplId(implId);
  const assetRoot = getImplementationAssetRoot(stateDir, implId);
  const entryPath = path.join(assetRoot, entryFile);
  ensureDir(assetRoot);
  withLock(entryPath, () => {
    fs.writeFileSync(entryPath, sourceCode, 'utf-8');
  });
}

export function deleteImplementationAssetDir(stateDir: string, implId: string): void {
  validateImplId(implId);
  const assetRoot = getImplementationAssetRoot(stateDir, implId);
  if (!fs.existsSync(assetRoot)) {
    return;
  }
  withLock(assetRoot, () => {
    fs.rmSync(assetRoot, { recursive: true, force: true });
  });
}

/**
 * Load the entry source code from disk.
 * Returns null if manifest doesn't exist or entry file is missing.
 */
export function loadEntrySource(stateDir: string, implId: string): string | null {
  validateImplId(implId);
  const manifest = loadManifest(stateDir, implId);
  if (!manifest) return null;
  const entryPath = path.join(getImplementationAssetRoot(stateDir, implId), manifest.entryFile);
  if (!fs.existsSync(entryPath)) return null;
  try {
    return fs.readFileSync(entryPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Create the full asset directory structure for a new implementation.
 *
 * Creates:
 *   {implId}/            - asset root
 *   {implId}/entry.js    - placeholder entry point (only if not already present)
 *   {implId}/manifest.json - asset manifest with version and timestamps
 *   {implId}/replays/    - empty directory for future replay reports
 *
 * Idempotent: calling again with the same implId will NOT overwrite an existing entry.js.
 */
 
 
export function createImplementationAssetDir(
  stateDir: string,
  implId: string,
  version: string,
  options: {
    entrySource?: string;
    lineage?: CodeImplementationLineageMetadata;
  } = {},
): CodeImplementationManifest {
  validateImplId(implId);
  const assetRoot = getImplementationAssetRoot(stateDir, implId);
  const replaysDir = path.join(assetRoot, REPLAYS_DIRNAME);
  const entryPath = path.join(assetRoot, ENTRY_FILENAME);
  const entrySource =
    options.entrySource ??
    [
      '// Code implementation entry point',
      '// Exports: meta (RuleHostMeta), evaluate (input: RuleHostInput) => RuleHostResult',
      '// This file will be replaced by nocturnal candidate generation (Phase 14)',
      'export const meta = { name: "placeholder", version: "0.0.1", ruleId: "", coversCondition: "" };',
      'export function evaluate(input) { return { decision: "allow", matched: false, reason: "placeholder" }; }',
    ].join('\n');

  withLock(assetRoot, () => {
    ensureDir(assetRoot);
    ensureDir(replaysDir);
    if (!fs.existsSync(entryPath)) {
      fs.writeFileSync(entryPath, entrySource, 'utf-8');
    }
  });

  if (fs.existsSync(entryPath) && options.entrySource) {
    writeEntrySource(stateDir, implId, options.entrySource);
  }

  const now = new Date().toISOString();
  const manifest: CodeImplementationManifest = {
    version,
    entryFile: ENTRY_FILENAME,
    createdAt: now,
    updatedAt: now,
    replaySampleRefs: [],
    lastEvalReportRef: null,
    ...(options.lineage ? { lineage: options.lineage } : {}),
  };

  writeManifest(stateDir, implId, manifest);
  return manifest;
}
