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
/**
 * PR #2684 P1: how many times a single readIntentDoc() call may re-open the
 * file when the stability check fails (writer rewriting the file while we
 * read). Bounded, not a sleep-and-hope loop: after the budget is exhausted
 * the read degrades to the structured read_error result (rc-9) rather than
 * caching possibly-torn content.
 */
const INTENT_STABILITY_RETRIES = 2;

// ── Module-level cache (per workspace+lang) ──────────────────────────────────

/** Full identity of the file a cached reference was read from (bigint fstat). */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  /** Full ns precision — an in-place same-millisecond rewrite bumps these. */
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CachedIntentDoc {
  reference: IntentDocReference;
  identity: FileIdentity;
  loadedAt: number;
}

const _intentDocCache = new Map<string, CachedIntentDoc>();

function identityOf(bigStat: fs.BigIntStats): FileIdentity {
  return {
    dev: bigStat.dev,
    ino: bigStat.ino,
    size: bigStat.size,
    // Full ns precision (CodeRabbit PR #2684 r2): truncating to milliseconds
    // would miss an in-place same-millisecond rewrite whose size is unchanged.
    mtimeNs: bigStat.mtimeNs,
    ctimeNs: bigStat.ctimeNs,
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

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
          // PR #2684 P1: cache-hit validation checks FILE IDENTITY, not just
          // mtime — a same-length rewrite or an atomic replace that kept the
          // size would otherwise pass an mtime-only check on filesystems with
          // coarse timestamps. dev+ino+size+mtimeMs(+ctimeMs) must all match.
          const stat = fs.statSync(filePath, { bigint: true });
          if (sameIdentity(identityOf(stat), cached.identity)) {
            return { ok: true, found: true, flagEnabled: true, doc: cached.reference };
          }
          // Identity mismatch → fall through to the fresh-read path.
        } catch {
          // File deleted since caching — fall through to the fresh-read path
          // (which will report not_found). Never serve a doc for a gone file.
        }
      }

      // PR #2684 P1: bounded re-read loop. A writer that rewrites/atomically
      // replaces the file WHILE we read it can invalidate every consistency
      // check of that attempt; we retry a bounded number of times and, if the
      // file never stabilizes, degrade to the structured read_error result
      // instead of caching torn content (rc-3 / rc-9).
      for (let attempt = 0; attempt <= INTENT_STABILITY_RETRIES; attempt += 1) {
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
            const openStat = fs.fstatSync(fd, { bigint: true });

            if (openStat.size > BigInt(INTENT_MAX_BYTES)) {
              _intentDocCache.delete(cacheKey);
              return {
                ok: false,
                found: true,
                flagEnabled: true,
                reason: 'oversized',
                nextAction: `${getIntentFilename(lang)} exceeds ${INTENT_MAX_BYTES} bytes (${openStat.size} bytes). Reduce content.`,
              };
            }

            // Read at most INTENT_MAX_BYTES + 1 bytes on the SAME descriptor:
            // the fixed buffer prevents concurrent growth from turning the size
            // check into an unbounded allocation.
            const buffer = Buffer.allocUnsafe(INTENT_MAX_BYTES + 1);
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.byteLength, 0);
            const finalStat = fs.fstatSync(fd, { bigint: true });
            if (bytesRead > INTENT_MAX_BYTES || finalStat.size > BigInt(INTENT_MAX_BYTES)) {
              _intentDocCache.delete(cacheKey);
              return {
                ok: false,
                found: true,
                flagEnabled: true,
                reason: 'oversized',
                nextAction: `${getIntentFilename(lang)} exceeds ${INTENT_MAX_BYTES} bytes (${Math.max(Number(openStat.size), Number(finalStat.size), bytesRead)} bytes observed). Reduce content.`,
              };
            }
            const raw = buffer.toString('utf8', 0, bytesRead);

            // PR #2684 P1 (Owner directive): the bytes may be TORN even when
            // the size matches — a writer that rewrites the file in place to
            // NEW content of the SAME length, or atomically replaces the path
            // mid-read, leaves `raw` describing a file that no longer exists.
            // Stability requires ALL of:
            //   a) full metadata equality (dev/ino/size/mtime/ctime) between
            //      the pre-read and post-read fstat of the SAME descriptor —
            //      a same-length rewrite bumps mtime, an atomic replace makes
            //      the fd point at an unlinked inode whose link count dropped;
            //   b) the PATH still resolves to the SAME dev/ino the fd holds —
            //      an atomic replace leaves the fd on the old inode while the
            //      path now names the new one;
            //   c) bytesRead equals the file size (complete, not torn read).
            // Any failure → serve the bytes read but do NOT cache, and retry
            // within the bounded budget; exhausted → structured read_error.
            const postPathStat = fs.statSync(filePath, { bigint: true });
            const stable = sameIdentity(identityOf(openStat), identityOf(finalStat))
              && finalStat.dev === postPathStat.dev
              && finalStat.ino === postPathStat.ino
              && BigInt(bytesRead) === finalStat.size;

            const reference: IntentDocReference = {
              raw,
              contentHash: computeIntentContentHash(raw),
              path: filePath,
            };

            if (!stable) {
              if (attempt < INTENT_STABILITY_RETRIES) {
                continue; // bounded re-read — try again from a fresh open
              }
              // Budget exhausted: never cache torn content, and do not present
              // possibly-mixed bytes as a successful read (rc-3).
              _intentDocCache.delete(cacheKey);
              logger?.warn?.(`[host-runtime:intent] read unstable after ${attempt + 1} attempts: workspace=${workspaceDir}, lang=${lang}`);
              return {
                ok: false,
                found: true,
                flagEnabled: true,
                reason: 'read_error',
                nextAction: `${getIntentFilename(lang)} kept changing while being read (concurrent writer). Retry; if this recurs, stop the writer process first.`,
              };
            }

            _intentDocCache.set(cacheKey, {
              reference,
              identity: identityOf(finalStat),
              loadedAt: now,
            });

            return { ok: true, found: true, flagEnabled: true, doc: reference };
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          // PR #2684 P1: a stability retry that hits a transient fs error
          // (e.g. the path vanished mid-retry because of an atomic replace)
          // is retried within the same budget; ENOENT on the FIRST open is
          // handled above, so reaching here mid-loop means the file was
          // removed while we were re-reading — treat as unstable and retry;
          // if the budget is exhausted, degrade below exactly like any other
          // real read failure (never throw — ERR-002).
          if (attempt < INTENT_STABILITY_RETRIES && isEnoent(err)) {
            continue;
          }
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
      }
      // Unreachable: every loop iteration either returns or continues, and the
      // stability-exhausted branch returns inside the loop. Kept so the
      // compiler sees a terminating return for IntentDocReadResult.
      return {
        ok: false,
        found: true,
        flagEnabled: true,
        reason: 'read_error',
        nextAction: `${getIntentFilename(lang)} kept changing while being read (concurrent writer). Retry.`,
      };
    },
  };
}
