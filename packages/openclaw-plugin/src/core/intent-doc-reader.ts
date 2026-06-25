/**
 * PRI-467 — safeReadIntentDoc: plugin I/O wrapper for reading INTENT.md.
 *
 * Reads `.principles/INTENT.md` with:
 * - Feature flag check FIRST (SPEC §12: flag off → flag_disabled without fs)
 * - TTL + mtime cache (60s TTL, mtime check) mirroring prompt.ts cachedReadFile
 * - 32KB size cap (INTENT_MAX_BYTES)
 * - Never throws — all errors return structured `reason` + `nextAction`
 *
 * Trust boundary (SPEC §12.2):
 * - Raw content is returned for the pure builder to escape; this reader does
 *   NOT escape or bound the content for prompt injection. The pure builder
 *   `buildIntentFrictionBlock` handles escaping + bounding.
 *
 * ERR checklist:
 * EP-01 / ERR-001, ERR-005: raw content validated with typeof, never `as`
 * EP-02 / ERR-025, ERR-070: production path; plugin I/O file in the whitelist
 * EP-03 / ERR-002, ERR-014: every degraded path returns structured reason + nextAction
 * EP-09: tests use real fs writes in temp dirs
 *
 * Architecture: this file is I/O (fs, path). It is whitelisted in
 * architecture-regression.test.ts KNOWN_PLUGIN_CORE_FILES.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTENT_MAX_BYTES,
  parseIntentDocSections,
  computeIntentContentHash,
  validateIntentDocSections,
  type IntentDocSections,
  type IntentDocWarning,
} from '@principles/core/runtime-v2';
import { loadFeatureFlagFromConfig } from './pd-config-loader.js';

// ── Constants ────────────────────────────────────────────────────────────────

const INTENT_FILENAME = 'INTENT.md';
const INTENT_DIR = '.principles';
const INTENT_CACHE_TTL_MS = 60_000; // 1 minute (SPEC §12.1)

// ── Types ────────────────────────────────────────────────────────────────────

export type SafeReadIntentDocReason =
  | 'flag_disabled'
  | 'not_found'
  | 'oversized'
  | 'read_error';

export interface IntentDoc {
  /** Raw INTENT.md content (unescaped — caller escapes for prompt injection). */
  raw: string;
  /** Parsed sections from the raw content. */
  sections: IntentDocSections;
  /** SHA-256 content hash for deduplication and audit. */
  contentHash: string;
  /** Absolute path to the INTENT.md file. */
  path: string;
  /** ISO timestamp when the doc was read. */
  readAt: string;
  /** Validation warnings (missing/empty/too_vague sections). */
  warnings: IntentDocWarning[];
}

export interface SafeReadIntentDocResult {
  /** True when the doc was successfully read and parsed. */
  ok: boolean;
  /** True when the INTENT.md file exists on disk. */
  found: boolean;
  /** True when the intent_engineering flag is enabled. */
  flagEnabled: boolean;
  /** The parsed IntentDoc, present only when ok=true. */
  doc?: IntentDoc;
  /** Structured reason for a degraded path (present when ok=false). */
  reason?: SafeReadIntentDocReason;
  /** Next action for the operator (present when ok=false). */
  nextAction?: string;
  /** Validation warnings (always present, empty when no warnings). */
  warnings: IntentDocWarning[];
}

interface CachedIntentDoc {
  doc: IntentDoc;
  mtime: number;
  loadedAt: number;
}

// ── Module-level cache (per-workspace) ───────────────────────────────────────

const _intentDocCache = new Map<string, CachedIntentDoc>();

/**
 * Reset the intent doc cache for test isolation.
 * Call in beforeEach() to ensure tests don't pollute each other.
 */
export function resetIntentDocCacheForTest(workspaceDir?: string): void {
  if (workspaceDir) {
    _intentDocCache.delete(workspaceDir);
  } else {
    _intentDocCache.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getIntentFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, INTENT_DIR, INTENT_FILENAME);
}

function buildDocFromRaw(raw: string, filePath: string, readAt: string): IntentDoc {
  const sections = parseIntentDocSections(raw);
  const warnings = validateIntentDocSections(sections);
  const contentHash = computeIntentContentHash(raw);
  return {
    raw,
    sections,
    contentHash,
    path: filePath,
    readAt,
    warnings,
  };
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

/**
 * Safely read INTENT.md for prompt injection.
 *
 * Contract (SPEC §12):
 * 1. Flag check FIRST via loadFeatureFlagFromConfig. Flag off → flag_disabled
 *    WITHOUT any fs access to INTENT.md.
 * 2. Flag on → check TTL + mtime cache. If cached and fresh → return cached.
 * 3. Otherwise → stat the file (oversized check), read, parse, validate, cache.
 * 4. Never throws — all errors return structured reason + nextAction.
 *
 * @param workspaceDir - Absolute path to the workspace root
 * @param options - Optional logger for debug-level diagnostics
 * @returns SafeReadIntentDocResult (never throws)
 */
export function safeReadIntentDoc(
  workspaceDir: string,
  options?: { logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void } },
): SafeReadIntentDocResult {
  // SPEC §12 — Flag check FIRST. Flag off → no fs access, no cache access.
  const flagResult = loadFeatureFlagFromConfig(workspaceDir, 'intent_engineering', options?.logger);
  if (!flagResult.enabled) {
    return {
      ok: false,
      found: false,
      flagEnabled: false,
      reason: 'flag_disabled',
      nextAction: 'Enable the intent_engineering feature flag in .pd/config.yaml to read INTENT.md.',
      warnings: [],
    };
  }

  const filePath = getIntentFilePath(workspaceDir);
  const now = Date.now();

  // Check cache freshness (TTL + mtime)
  const cached = _intentDocCache.get(workspaceDir);
  if (cached && (now - cached.loadedAt) < INTENT_CACHE_TTL_MS) {
    // Cache is within TTL. Verify mtime hasn't changed.
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === cached.mtime) {
        // Cache hit — return cached doc
        return {
          ok: true,
          found: true,
          flagEnabled: true,
          doc: cached.doc,
          warnings: cached.doc.warnings,
        };
      }
    } catch {
      // File may have been deleted since caching. Fall through to not_found path.
      // Don't return cached doc if the file no longer exists.
    }
  }

  // Fresh read path
  try {
    // Check existence first
    if (!fs.existsSync(filePath)) {
      // Invalidate stale cache entry if any
      _intentDocCache.delete(workspaceDir);
      return {
        ok: false,
        found: false,
        flagEnabled: true,
        reason: 'not_found',
        nextAction: 'Create .principles/INTENT.md using "pd intent init".',
        warnings: [],
      };
    }

    const stat = fs.statSync(filePath);

    // SPEC §12 — 32KB size cap
    if (stat.size > INTENT_MAX_BYTES) {
      _intentDocCache.delete(workspaceDir);
      return {
        ok: false,
        found: true,
        flagEnabled: true,
        reason: 'oversized',
        nextAction: `INTENT.md exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content.`,
        warnings: [],
      };
    }

    const raw = fs.readFileSync(filePath, 'utf8');

    // PRI-467 review fix (P2): TOCTOU guard — re-check actual byte length
    // after readFileSync. The file may have grown between statSync() and
    // readFileSync(), bypassing the stat.size oversized check. Without this,
    // an oversized file would enter parse/hash/cache as ok:true.
    const actualBytes = Buffer.byteLength(raw, 'utf8');
    if (actualBytes > INTENT_MAX_BYTES) {
      _intentDocCache.delete(workspaceDir);
      return {
        ok: false,
        found: true,
        flagEnabled: true,
        reason: 'oversized',
        nextAction: `INTENT.md exceeds ${INTENT_MAX_BYTES} bytes (${actualBytes} bytes after read). Reduce content.`,
        warnings: [],
      };
    }

    const doc = buildDocFromRaw(raw, filePath, new Date(now).toISOString());

    // Update cache
    _intentDocCache.set(workspaceDir, {
      doc,
      mtime: stat.mtimeMs,
      loadedAt: now,
    });

    return {
      ok: true,
      found: true,
      flagEnabled: true,
      doc,
      warnings: doc.warnings,
    };
  } catch (err) {
    // ERR-002 — graceful degradation with reason + nextAction
    _intentDocCache.delete(workspaceDir);
    const message = err instanceof Error ? err.message : String(err);
    options?.logger?.warn?.(`[PD:Intent] safeReadIntentDoc failed: workspace=${workspaceDir}, error=${message}`);
    return {
      ok: false,
      found: false,
      flagEnabled: true,
      reason: 'read_error',
      nextAction: 'Check filesystem permissions for .principles/INTENT.md.',
      warnings: [],
    };
  }
}
