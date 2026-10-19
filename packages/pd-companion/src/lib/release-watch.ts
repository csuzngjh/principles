/**
 * The installed release identity Companion decides on (PRI-1016).
 *
 * The version watch used to compare the installed plugin's `package.json`
 * version. That is a COMPONENT axis: each package bumps independently per
 * changeset cohort, so a signed release can lay new console/core code while
 * the plugin number stays put — field-verified on this machine (channel seq
 * 15→16→17 all carried plugin 2.1.0, and 22→23 all carried 2.1.8). The watch
 * never fired for those updates, so the running Console kept serving the
 * previous build indefinitely. The marker also flips while components are
 * still being laid (before the journal `staged` transition), which is the
 * race PRI-1012 had to absorb with a bounded entry wait, and it does not move
 * back when a transaction rolls over, so a rolled-back install stayed a
 * restart target.
 *
 * `~/.pd/active.json` is the installation authority: written at activation,
 * after the component tree is complete, and flipped on every release and on
 * every rollback. Its `releaseId` is the release identity — an opaque sha256
 * digest over the identity inputs (product version, source commit, asset
 * identities, minimum bootstrap version; see `release-identity.ts` in the
 * installer), never a string this module may parse or compare piece by piece.
 * `generation` is the monotonic activation counter.
 *
 * This module deliberately validates only what Companion must be able to trust
 * about a record: that it is a version-1 object carrying a complete identity
 * with the audit fields beside it. `generation` and `productVersion` are not
 * compared by the decision — they are required because a record that lost them
 * is not the record the update chain writes, and because every hand-over is
 * logged as from/to. The strict full-schema reader belongs to the update chain
 * (`transaction-journal.ts readActiveRecord`); duplicating that contract here
 * would make Companion a second de-facto schema authority and would refuse a
 * restart for any future field it has not been taught about.
 */

export interface ReleaseIdentity {
  readonly releaseId: string;
  readonly generation: number;
  readonly productVersion: string;
}

/** A read of the installation authority: either an identity, or why there is none. */
export type ActiveReleaseRead =
  | { readonly ok: true; readonly identity: ReleaseIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * A parse error's message quotes part of the corrupt file, so the reason that
 * reaches the log is capped — same bound as `entry-verdict.ts` (rc-8).
 */
function briefError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * Parse the active release record from an already-read JSON value (rc-1: the
 * file content is untrusted input until these checks pass). Absent file and
 * read/parse failures are decided by `readActiveRelease`, which owns the I/O.
 * Internal by design: the only reader-facing contract is `readActiveRelease`,
 * so no caller can hand this a value it obtained some other way.
 */
function parseActiveRelease(value: unknown): ActiveReleaseRead {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'active_record_not_object' };
  }
  const record = value as Record<string, unknown>;
  // A record from a newer layout version may mean different fields; refusing
  // to decide is safer than restarting a healthy Console on a guess.
  if (record.schemaVersion !== 1) {
    return { ok: false, reason: `active_record_schema_version_unsupported: ${briefError(JSON.stringify(record.schemaVersion))}` };
  }
  const { releaseId, generation, productVersion } = record;
  if (typeof releaseId !== 'string' || releaseId.length === 0) {
    return { ok: false, reason: 'active_record_release_id_missing' };
  }
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    return { ok: false, reason: 'active_record_generation_invalid' };
  }
  if (typeof productVersion !== 'string' || productVersion.length === 0) {
    return { ok: false, reason: 'active_record_product_version_missing' };
  }
  return { ok: true, identity: { releaseId, generation, productVersion } };
}

/**
 * Read `~/.pd/active.json` (the path is derived from the shared install layout
 * by `locate.ts resolveActiveRecordPath`, never from a caller-supplied string).
 * Fail-closed with a distinct structured reason for every failure class
 * (rc-3/rc-9) — a legacy install without the record, an unreadable file, and
 * malformed content are different situations an operator must be able to tell
 * apart from the log.
 */
export function readActiveRelease(activeRecordPath: string, fs: {
  existsSync(target: string): boolean;
  readFileSync(target: string, encoding: 'utf8'): string;
}): ActiveReleaseRead {
  if (!fs.existsSync(activeRecordPath)) {
    return { ok: false, reason: 'active_record_absent' };
  }
  let text: string;
  try {
    text = fs.readFileSync(activeRecordPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `active_record_read_failed: ${briefError(err)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (err) {
    return { ok: false, reason: `active_record_json_invalid: ${briefError(err)}` };
  }
  return parseActiveRelease(value);
}

/** What one tick of the version watch decided, and the evidence for it. */
export type ReleaseWatchDecision =
  | { readonly action: 'no_change' }
  | { readonly action: 'authority_unavailable'; readonly reason: string }
  | { readonly action: 'no_baseline' }
  | { readonly action: 'restart'; readonly from: ReleaseIdentity; readonly to: ReleaseIdentity }
  | { readonly action: 'attached_no_action'; readonly from: ReleaseIdentity; readonly to: ReleaseIdentity };

/**
 * Decide whether the running Console must be handed over to the installed
 * release. `started` is the identity the currently running process was
 * launched under; without it there is nothing to attribute the process to, so
 * no healthy Console is killed on a guess. Only a `managed` process is ever
 * stopped — an `attached` (externally launched or reused) Console is reported,
 * never touched, matching the ownership boundary the hand-over already holds.
 */
export function judgeReleaseWatch(options: {
  read: ActiveReleaseRead;
  started: ReleaseIdentity | undefined;
  mode: 'managed' | 'attached';
}): ReleaseWatchDecision {
  const { read, started, mode } = options;
  if (!read.ok) return { action: 'authority_unavailable', reason: read.reason };
  if (started === undefined) return { action: 'no_baseline' };
  if (started.releaseId === read.identity.releaseId) return { action: 'no_change' };
  return mode === 'managed'
    ? { action: 'restart', from: started, to: read.identity }
    : { action: 'attached_no_action', from: started, to: read.identity };
}
