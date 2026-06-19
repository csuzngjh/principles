/**
 * PRI-432: Shared CLI output module.
 *
 * Extracts common output patterns from 3 CLI commands:
 *   - runtime-features.ts (JSON/text emit)
 *   - runtime-recovery.ts (dry-run/confirm conflict + JSON/text emit)
 *   - runtime-internalization-integrity-repair.ts (conflict + error catch + JSON/text emit)
 *
 * Design decisions:
 * - formatText stays call-site-specific (domain layout differs per command).
 *   This module handles only cross-cutting output concerns.
 * - Functions return exit codes; callers handle process.exit()/process.exitCode.
 *   This follows CLI Operator Gate rule #2 (no process.exit in shared modules).
 * - JSON error shape: { ok: false, reason: string, nextAction: string }
 *   (matches runtime-internalization-integrity-repair.ts canonical pattern)
 *
 * ERR refs:
 * - ERR-001 (no any): all types explicit
 * - ERR-005 (no as bypass): no type casts
 * - ERR-009 (fail-loud): emitError/emitFlagConflict return exit code 1
 * - ERR-002 (graceful degradation with reason): all error paths include reason + nextAction
 * - ERR-014 (bounded preview): JSON.stringify on known shapes only
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface EmitResultOptions<T> {
  /** When true, emit JSON to stdout; when false, emit text via formatText. */
  json: boolean;
  /** Call-site-specific text formatter (domain layout differs per command). */
  formatText: (output: T) => string;
}

export interface EmitErrorOptions {
  /** When true, emit JSON error to stdout; when false, emit text to stderr. */
  json: boolean;
  /** Next action suggestion for the user. */
  nextAction: string;
}

export interface EmitFlagConflictOptions {
  /** When true, emit JSON error to stdout; when false, emit text to stderr. */
  json: boolean;
}

// ── Functions ──────────────────────────────────────────────────────────────

/**
 * Emit a result object as JSON (stdout) or text (stdout via formatText).
 * Does NOT set exit code — caller decides based on result status.
 */
export function emitResult<T extends object>(output: T, opts: EmitResultOptions<T>): void {
  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(opts.formatText(output));
  }
}

/**
 * Emit a dry-run/confirm flag conflict error.
 * Returns exit code 1. Caller should process.exit(1) or set process.exitCode = 1.
 *
 * JSON shape: { ok: false, reason: string, nextAction: string }
 * Text shape: console.error with message
 */
export function emitFlagConflict(opts: EmitFlagConflictOptions): number {
  const reason = 'Error: --dry-run and --confirm are mutually exclusive';
  const nextAction = 'Specify only one of --dry-run or --confirm';

  if (opts.json) {
    console.log(JSON.stringify({ ok: false, reason, nextAction }, null, 2));
  } else {
    console.error(`${reason}. Specify one or the other.`);
  }
  return 1;
}

/**
 * Emit a structured error from a caught exception.
 * Returns exit code 1. Caller should process.exit(1) or set process.exitCode = 1.
 *
 * JSON shape: { ok: false, reason: string, nextAction: string }
 * Text shape: console.error with "Error: <message>"
 */
export function emitError(err: unknown, opts: EmitErrorOptions): number {
  const reason = err instanceof Error ? err.message : String(err);

  if (opts.json) {
    console.log(JSON.stringify({ ok: false, reason, nextAction: opts.nextAction }, null, 2));
  } else {
    console.error(`Error: ${reason}`);
  }
  return 1;
}
