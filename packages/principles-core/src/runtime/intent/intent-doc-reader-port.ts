/**
 * IntentDocReader — port interface for reading INTENT.md from the plugin layer.
 *
 * PRI-468 / SPEC §12 — the diagnostician Stage A runner needs INTENT.md
 * content to optionally produce `intentTension`. Core cannot do I/O, so it
 * defines this port; the plugin provides a concrete implementation that
 * wraps `safeReadIntentDoc()` with feature-flag checking.
 *
 * Contract (SPEC §12):
 *   - When `intent_engineering` flag is off, implementations MUST return
 *     `{ ok: false, flagEnabled: false, reason: 'flag_disabled' }` WITHOUT
 *     any filesystem access.
 *   - Implementations MUST NOT throw — all error paths return a structured
 *     `reason` + `nextAction` (EP-03 / ERR-002: no silent fallback).
 *   - `doc.raw` is unescaped; the caller is responsible for escaping when
 *     injecting into a prompt (SPEC §12.2 trust boundary).
 *
 * This interface is intentionally minimal — it returns only the fields the
 * diagnostician runner needs: `raw` (for prompt injection) and
 * `contentHash` (for `intentTension.intentDocHash` lineage). Validation
 * warnings are NOT surfaced here because the diagnostician does not act on
 * them; they remain visible via `pd intent show`.
 */

/**
 * A successfully read INTENT.md reference.
 *
 * `raw` is the unescaped file content. `contentHash` is the SHA-256 hash
 * used for `intentTension.intentDocHash` lineage (SPEC §16.2).
 */
export interface IntentDocReference {
  /** Raw INTENT.md content (unescaped — caller escapes for prompt injection). */
  readonly raw: string;
  /** SHA-256 content hash for deduplication and audit (e.g. "sha256:abc..."). */
  readonly contentHash: string;
  /** Absolute path to the INTENT.md file (for telemetry only — never read by core). */
  readonly path: string;
}

/**
 * Structured reason for a degraded read path.
 *
 * Mirrors `SafeReadIntentDocReason` from the plugin layer (PRI-467), but
 * defined here so core has no plugin-layer import.
 */
export type IntentDocReadReason =
  | 'flag_disabled'
  | 'not_found'
  | 'oversized'
  | 'read_error';

/**
 * Result of reading INTENT.md.
 *
 * When `ok === true`, `doc` is present. When `ok === false`, `reason` and
 * `nextAction` are present (EP-03 / ERR-002: no silent fallback).
 */
export interface IntentDocReadResult {
  /** True when the doc was successfully read and parsed. */
  readonly ok: boolean;
  /** True when the INTENT.md file exists on disk (false when not_found). */
  readonly found: boolean;
  /** True when the intent_engineering flag is enabled. */
  readonly flagEnabled: boolean;
  /** The parsed IntentDoc, present only when ok=true. */
  readonly doc?: IntentDocReference;
  /** Structured reason for a degraded path (present when ok=false). */
  readonly reason?: IntentDocReadReason;
  /** Next action for the operator (present when ok=false). */
  readonly nextAction?: string;
}

/**
 * Port interface for reading INTENT.md.
 *
 * Core defines this interface; the plugin provides a concrete implementation
 * that wraps `safeReadIntentDoc(workspaceDir)` with feature-flag checking.
 *
 * The implementation is expected to be a closure bound to a specific
 * workspaceDir (created in `pain-signal-runtime-factory.ts`), so this
 * method takes no arguments.
 */
export interface IntentDocReader {
  /**
   * Read INTENT.md for the bound workspace.
   *
   * NEVER throws — all error paths return a structured result.
   * When `intent_engineering` flag is off, returns `flag_disabled` WITHOUT
   * any filesystem access (SPEC §12).
   */
  readIntentDoc(): IntentDocReadResult;
}

/**
 * No-op IntentDocReader for backward compatibility.
 *
 * Used when no reader is provided (e.g., in unit tests that don't care
 * about INTENT). Always returns `flag_disabled` — ensuring the runner
 * behaves as if the flag is off, producing byte-identical prompts.
 */
export class NullIntentDocReader implements IntentDocReader {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  readIntentDoc(): IntentDocReadResult {
    return {
      ok: false,
      found: false,
      flagEnabled: false,
      reason: 'flag_disabled',
      nextAction: 'No IntentDocReader configured — intent_engineering is effectively off.',
    };
  }
}
