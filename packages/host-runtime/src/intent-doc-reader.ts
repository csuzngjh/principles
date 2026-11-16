/**
 * PRI-1229 / SPEC-PD-INTENT-UNIFICATION-001 §9.3 — neutral host IntentDocReader.
 *
 * A host-neutral adapter implementing Core's `IntentDocReader` port for the
 * production entry points that live outside the OpenClaw plugin: PD CLI
 * (pain record / diagnose / pain retry) and host-runtime governance admission.
 *
 * Why a separate thin adapter instead of sharing the plugin's
 * `safeReadIntentDoc()` (SPEC §9.3 rule 4): the plugin package is a
 * host-specific delivery unit (ClawHub tarball) and must never become a
 * dependency of pd-cli or host-runtime — that would invert the dependency
 * direction. All BUSINESS logic stays in Core and is shared by every entry
 * point (no second copy):
 *   - flag predicate: `isIntentAnchoringEnabled(effectiveConfig)`
 *   - content hash:   `computeIntentContentHash(raw)`
 *   - path naming:    `getIntentFilename(lang)`
 * This module only performs the file read and maps it onto the Core port
 * result — the same responsibility split as the plugin-side adapter.
 *
 * Contract (SPEC §12 / §13.1, mirroring the plugin reader):
 *   - Flag check FIRST from the entry-provided effectiveConfig. Flag off →
 *     `flag_disabled` WITHOUT any filesystem or cache access.
 *   - 32KB cap enforced on the actually-read bytes (single open descriptor:
 *     no stat-then-read TOCTOU; the fixed buffer also bounds a file that
 *     grows while being read).
 *   - `not_found` / `oversized` / `read_error` degrade with structured
 *     reason + nextAction. NEVER throws.
 *   - TTL + mtime cache keyed `${workspaceDir}:${lang}` — the same mechanism
 *     as the plugin reader (SPEC §12.1: 60s TTL, mtime verified).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTENT_MAX_BYTES,
  computeIntentContentHash,
  getIntentFilename,
  isIntentAnchoringEnabled,
  type EffectivePdConfig,
  type IntentDocReader,
  type IntentDocReadResult,
  type IntentDocReference,
  type IntentLang,
} from '@principles/core/runtime';

/** True when a filesystem call failed because the path does not exist. */
function isEnoent(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(err, 'code');
  return descriptor?.value === 'ENOENT';
}

const INTENT_DIR = '.principles';
const INTENT_CACHE_TTL_MS = 60_000; // 1 minute (SPEC §12.1, same as plugin reader)

// ── Module-level cache (per workspace+lang) ──────────────────────────────────

interface CachedIntentDoc {
  reference: IntentDocReference;
  mtimeMs: number;
  loadedAt: number;
}

const _intentDocCache = new Map<string, CachedIntentDoc>();

/**
 * Reset the intent doc cache for test isolation (same semantics as the
 * plugin reader's resetIntentDocCacheForTest).
 */
export function resetHostIntentDocCacheForTest(workspaceDir?: string, lang?: IntentLang): void {
  if (workspaceDir === undefined) {
    _intentDocCache.clear();
    return;
  }
  if (lang !== undefined) {
    _intentDocCache.delete(`${workspaceDir}:${lang}`);
    return;
  }
  const prefix = `${workspaceDir}:`;
  for (const key of _intentDocCache.keys()) {
    if (key.startsWith(prefix)) _intentDocCache.delete(key);
  }
}

// ── Language resolution ───────────────────────────────────────────────────────

/**
 * Detect which language's INTENT file exists on disk (zh-CN first, then en,
 * default zh-CN) — the same resolution the OpenClaw plugin adapter applies.
 *
 * Filesystem-touching by design: callers MUST only invoke it when the
 * intent_engineering flag is already known to be on, so flag-off keeps the
 * zero-file-access contract.
 */
export function resolveHostIntentLang(workspaceDir: string): IntentLang {
  const zhPath = path.join(workspaceDir, INTENT_DIR, getIntentFilename('zh-CN'));
  if (fs.existsSync(zhPath)) return 'zh-CN';
  const enPath = path.join(workspaceDir, INTENT_DIR, getIntentFilename('en'));
  if (fs.existsSync(enPath)) return 'en';
  return 'zh-CN';
}

// ── Reader factory ────────────────────────────────────────────────────────────

export interface HostIntentDocReaderOptions {
  /** Absolute path to the workspace root the reader is bound to. */
  readonly workspaceDir: string;
  /**
   * Effective PD config from the CURRENT production entry point. The flag
   * predicate (`isIntentAnchoringEnabled`) is Core-owned — this adapter never
   * re-reads config and never re-implements the flag decision.
   */
  readonly effectiveConfig: EffectivePdConfig | undefined;
  /** Explicit language binding. When omitted, resolved lazily per read. */
  readonly lang?: IntentLang;
  /** Optional logger for debug-level diagnostics. */
  readonly logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * Create an IntentDocReader bound to a specific workspace.
 *
 * The returned reader is a closure over (workspaceDir, effectiveConfig, lang)
 * — each `readIntentDoc()` call re-evaluates the Core flag predicate against
 * the captured config, then reads through the TTL+mtime cache.
 */
export function createHostIntentDocReader(options: HostIntentDocReaderOptions): IntentDocReader {
  const { workspaceDir, effectiveConfig, logger } = options;
  const { lang: boundLang } = options;

  return {
    readIntentDoc(): IntentDocReadResult {
      // SPEC §12 / §13.1 — flag check FIRST, from the entry-provided config.
      // Flag off → no filesystem access, no cache access.
      if (!isIntentAnchoringEnabled(effectiveConfig)) {
        return {
          ok: false,
          found: false,
          flagEnabled: false,
          reason: 'flag_disabled',
          nextAction: 'Enable the intent_engineering feature flag in .pd/config.yaml to read the INTENT document.',
        };
      }

      // Language is resolved lazily (AFTER the flag gate) so a flag-off read
      // performs zero filesystem probes.
      const lang = boundLang ?? resolveHostIntentLang(workspaceDir);
      const cacheKey = `${workspaceDir}:${lang}`;
      const filePath = path.resolve(workspaceDir, INTENT_DIR, getIntentFilename(lang));
      const now = Date.now();

      const cached = _intentDocCache.get(cacheKey);
      if (cached && (now - cached.loadedAt) < INTENT_CACHE_TTL_MS) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs === cached.mtimeMs) {
            return { ok: true, found: true, flagEnabled: true, doc: cached.reference };
          }
        } catch {
          // File deleted since caching — fall through to the fresh-read path
          // (which will report not_found). Never serve a doc for a gone file.
        }
      }

      try {
        // Open once and let ENOENT be the not-found signal — a path-based
        // existsSync before the open is a check/use race.
        let fd: number;
        try {
          fd = fs.openSync(filePath, 'r');
        } catch (err) {
          if (!isEnoent(err)) throw err;
          _intentDocCache.delete(cacheKey);
          return {
            ok: false,
            found: false,
            flagEnabled: true,
            reason: 'not_found',
            nextAction: `Create .principles/${getIntentFilename(lang)} using "pd intent init".`,
          };
        }
        try {
          const stat = fs.fstatSync(fd);

          if (stat.size > INTENT_MAX_BYTES) {
            _intentDocCache.delete(cacheKey);
            return {
              ok: false,
              found: true,
              flagEnabled: true,
              reason: 'oversized',
              nextAction: `${getIntentFilename(lang)} exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content.`,
            };
          }

          // Read at most INTENT_MAX_BYTES + 1 bytes on the SAME descriptor:
          // the fixed buffer prevents concurrent growth from turning the size
          // check into an unbounded allocation, and the final fstat rejects a
          // file that grew past the cap during the read.
          const buffer = Buffer.allocUnsafe(INTENT_MAX_BYTES + 1);
          const bytesRead = fs.readSync(fd, buffer, 0, buffer.byteLength, 0);
          const finalStat = fs.fstatSync(fd);
          if (bytesRead > INTENT_MAX_BYTES || finalStat.size > INTENT_MAX_BYTES) {
            _intentDocCache.delete(cacheKey);
            return {
              ok: false,
              found: true,
              flagEnabled: true,
              reason: 'oversized',
              nextAction: `${getIntentFilename(lang)} exceeds ${INTENT_MAX_BYTES} bytes (${Math.max(stat.size, finalStat.size, bytesRead)} bytes observed). Reduce content.`,
            };
          }
          const raw = buffer.toString('utf8', 0, bytesRead);

          const reference: IntentDocReference = {
            raw,
            contentHash: computeIntentContentHash(raw),
            path: filePath,
          };

          _intentDocCache.set(cacheKey, {
            reference,
            mtimeMs: finalStat.mtimeMs,
            loadedAt: now,
          });

          return { ok: true, found: true, flagEnabled: true, doc: reference };
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        // ERR-002 — graceful degradation with reason + nextAction; never throw.
        _intentDocCache.delete(cacheKey);
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[host-runtime:intent] read failed: workspace=${workspaceDir}, lang=${lang}, error=${message}`);
        return {
          ok: false,
          found: false,
          flagEnabled: true,
          reason: 'read_error',
          nextAction: `Check filesystem permissions for .principles/${getIntentFilename(lang)}.`,
        };
      }
    },
  };
}
