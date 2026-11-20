/**
 * Active release record — the ONE authoritative schema + reader for
 * `<pdHome>/active.json` (the installation authority).
 *
 * The only production writer is the installer/update transaction's commit
 * point (`writeActiveRecord` in create-principles-disciple's
 * transaction-journal), which always serializes the full field set:
 * `schemaVersion: 1`, `generation` (positive safe integer, monotonic),
 * `releaseId`, `releaseMetadataDigest` (64-char hex), `previousReleaseId`
 * (string | null), `transactionId`, `productVersion`, and an optional
 * `sourceCommit` (40-char hex) embedded on records written after SPEC §12
 * provenance stamping.
 *
 * This module is the single validation authority every reader shares:
 * consumers that need the full record (the update chain's recovery, the
 * run-once coordinator's install-identity check) must not carry a second,
 * looser copy of the schema — a record that lost any of these fields is
 * not the record the update chain writes, and treating it as one is how a
 * corrupted install gets reported as a healthy release.
 *
 * Failure classes stay DISTINCT (rc-3/rc-9): absent file, unreadable file,
 * non-JSON content, non-object JSON, unsupported schemaVersion and each
 * malformed field are different situations an operator must tell apart —
 * never collapse them into "no release".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The only schema generation this reader accepts. */
export const ACTIVE_RELEASE_SCHEMA_VERSION = 1 as const;

/** The full record exactly as the installer's commit point writes it. */
export interface ActiveReleaseRecord {
  readonly schemaVersion: typeof ACTIVE_RELEASE_SCHEMA_VERSION;
  readonly generation: number;
  readonly releaseId: string;
  readonly releaseMetadataDigest: string;
  readonly previousReleaseId: string | null;
  readonly transactionId: string;
  readonly productVersion: string;
  /** Embedded provenance (stamped source commit); absent on legacy records. */
  readonly sourceCommit?: string;
}

/**
 * The distinct failure classes a read can end in. Field-level reasons name
 * the field that failed so a corrupted install's repair message can say
 * exactly what is wrong instead of "malformed".
 */
export type ActiveReleaseFailureReason =
  | 'active_record_absent'
  | 'active_record_read_failed'
  | 'active_record_json_invalid'
  | 'active_record_not_object'
  | 'active_record_schema_version_unsupported'
  | 'active_record_release_id_invalid'
  | 'active_record_generation_invalid'
  | 'active_record_digest_invalid'
  | 'active_record_previous_release_id_invalid'
  | 'active_record_transaction_id_invalid'
  | 'active_record_product_version_invalid'
  | 'active_record_source_commit_invalid';

export type ActiveReleaseVerdict =
  | { readonly ok: true; readonly record: ActiveReleaseRecord }
  | { readonly ok: false; readonly reason: ActiveReleaseFailureReason; readonly detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded, control-character-free error detail (rc-8). */
function brief(value: unknown, max = 160): string {
  const text = value instanceof Error ? value.message : String(value);
  const clean = text.replace(/[^\x20-\x7E]+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function fail(reason: ActiveReleaseFailureReason, detail: string): ActiveReleaseVerdict {
  return { ok: false, reason, detail };
}

/**
 * Validate an already-parsed JSON value against the authoritative record
 * schema. Untrusted input: every field is checked by primitive guards
 * (rc-1/rc-2), no `as` bypass.
 */
export function parseActiveReleaseRecord(value: unknown): ActiveReleaseVerdict {
  if (!isPlainObject(value)) {
    return fail('active_record_not_object', 'active.json is not a JSON object');
  }
  if (value.schemaVersion !== ACTIVE_RELEASE_SCHEMA_VERSION) {
    return fail(
      'active_record_schema_version_unsupported',
      `active.json has unsupported schemaVersion: ${brief(JSON.stringify(value.schemaVersion))}`,
    );
  }
  const { generation, releaseId } = value;
  const digest = value.releaseMetadataDigest;
  const { previousReleaseId, transactionId, productVersion, sourceCommit } = value;
  if (typeof releaseId !== 'string' || releaseId.length === 0) {
    return fail('active_record_release_id_invalid', 'active.json releaseId must be a non-empty string');
  }
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    return fail('active_record_generation_invalid', 'active.json generation must be a positive safe integer');
  }
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    return fail('active_record_digest_invalid', 'active.json releaseMetadataDigest must be a 64-char hex string');
  }
  if (previousReleaseId !== null && (typeof previousReleaseId !== 'string' || previousReleaseId.length === 0)) {
    return fail('active_record_previous_release_id_invalid', 'active.json previousReleaseId must be a non-empty string or null');
  }
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    return fail('active_record_transaction_id_invalid', 'active.json transactionId must be a non-empty string');
  }
  if (typeof productVersion !== 'string' || productVersion.length === 0) {
    return fail('active_record_product_version_invalid', 'active.json productVersion must be a non-empty string');
  }
  // Optional embedded provenance: strict WHEN present (rc-3); absence is the
  // legacy shape and stays valid.
  if (sourceCommit !== undefined && (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit))) {
    return fail('active_record_source_commit_invalid', 'active.json sourceCommit must be a 40-char git commit sha when present');
  }
  return {
    ok: true,
    record: {
      schemaVersion: ACTIVE_RELEASE_SCHEMA_VERSION,
      generation,
      releaseId,
      releaseMetadataDigest: digest,
      previousReleaseId,
      transactionId,
      productVersion,
      ...(sourceCommit !== undefined ? { sourceCommit } : {}),
    },
  };
}

/**
 * Read and validate `<pdHome>/active.json`. Missing vs unreadable vs corrupt
 * vs schema-nonconforming are all distinguishable by `reason` (rc-3/rc-9).
 */
export function readActiveReleaseRecord(recordPath: string): ActiveReleaseVerdict {
  // No existsSync pre-check (P2-2): the check-then-read pair is a TOCTOU —
  // the file can appear or vanish between them, and existsSync answers a
  // different question than "can we read the record". Read directly and
  // classify by errno: ENOENT/ENOTDIR (including a dangling symlink, whose
  // read fails ENOENT) is `absent`; every other read failure — EACCES,
  // EPERM, EIO, EISDIR — is `read_failed`, fail-closed and never faked as
  // "no release installed".
  let text: string;
  try {
    text = fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return fail('active_record_absent', `active.json does not exist: ${recordPath}`);
    }
    return fail('active_record_read_failed', `active.json could not be read (${recordPath}): ${brief(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail('active_record_json_invalid', `active.json is not valid JSON (${recordPath}): ${brief(error)}`);
  }
  return parseActiveReleaseRecord(value);
}

/** `<pdHome>/active.json` — the canonical record location. */
export function activeReleaseRecordPath(pdHome: string): string {
  return path.join(pdHome, 'active.json');
}
