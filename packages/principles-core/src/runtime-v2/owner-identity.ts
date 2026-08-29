/**
 * OwnerIdentity — install-level Owner identity registration (ADR-0022).
 *
 * Resolution precedence — a single resolver whose documented chain IS the
 * single source of truth (AGENTS.md P4; same shape as DEFAULT_FEATURE_FLAGS +
 * config override):
 *
 *   PD_OWNER_ID + PD_OWNER_CREDENTIAL_ID (env, highest — CI/ops)
 *     -> ~/.pd/owner.json (install-level, registered via Console Settings)
 *     -> none
 *
 * Persists identifiers only; never secret/token values (ADR-0016 §2.2/§2.3).
 * ERR-045: the `credentialId` field name matches SECRET_KEY_SEGMENTS
 * (pd-config-store.ts) and is auto-redacted in any log/config echo path —
 * expected defense in depth, do not "fix".
 *
 * The env override is an ATOMIC PAIR (ADR-0022 review): if either
 * PD_OWNER_ID or PD_OWNER_CREDENTIAL_ID is set (even to empty/whitespace)
 * without the other being set and non-empty, resolution FAILS CLOSED —
 * source 'invalid_env', no ownerId/credentialId, and the file is NOT read.
 * Reason: ops may be mid-migration to a different Owner while an old file
 * identity still sits on disk; silently continuing under the old identity is
 * an authority-attribution bug (rc-9), not a config fallback.
 *
 * File reads distinguish "absent" (ENOENT — a valid not-registered state)
 * from any other filesystem failure (EACCES, EISDIR, EPERM, I/O): a read
 * failure is surfaced as a diagnosable error and never interpreted as
 * "Owner not registered".
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const OWNER_IDENTITY_SCHEMA_VERSION = 1 as const;
export const OWNER_IDENTITY_FILE_NAME = 'owner.json';

export interface OwnerIdentityRecord {
  schemaVersion: number;
  ownerId: string;
  credentialId: string;
  registeredAt: string;
}

export type OwnerIdentitySource = 'env' | 'file' | 'none' | 'invalid_env';

export interface OwnerIdentityResolved {
  ownerId: string | null;
  credentialId: string | null;
  source: OwnerIdentitySource;
  /**
   * Machine-readable failure reason. Present when source is 'invalid_env'
   * (partial/empty env override) or when the registration file could not be
   * read (non-ENOENT filesystem failure). Never contains identity values.
   */
  error?: string;
}

export type OwnerIdentityFileResult =
  | { ok: true; record: OwnerIdentityRecord }
  | { ok: false; error: string };

export type OwnerIdentityDeleteResult = { ok: true } | { ok: false; error: string };

export function ownerIdentityFilePath(homeDir: string): string {
  return path.join(homeDir, '.pd', OWNER_IDENTITY_FILE_NAME);
}

export function defaultOwnerIdentityHomeDir(): string {
  return os.homedir();
}

function parseOwnerIdentityRecord(raw: unknown): { record?: OwnerIdentityRecord; error?: string } {
  if (raw === null || typeof raw !== 'object') {
    return { error: 'owner_identity_malformed: expected an object' };
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== OWNER_IDENTITY_SCHEMA_VERSION) {
    return { error: `owner_identity_unsupported_version: ${String(value.schemaVersion)}` };
  }
  const ownerId = typeof value.ownerId === 'string' ? value.ownerId.trim() : '';
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : '';
  const registeredAt = typeof value.registeredAt === 'string' ? value.registeredAt : '';
  if (!ownerId || !credentialId) {
    return { error: 'owner_identity_malformed: ownerId and credentialId must be non-empty strings' };
  }
  return {
    record: { schemaVersion: OWNER_IDENTITY_SCHEMA_VERSION, ownerId, credentialId, registeredAt },
  };
}

/**
 * Read ~/.pd/owner.json. Absent file (ENOENT) => { record: null } — a valid
 * "not registered" state. Malformed content => { record: null, error }. Any
 * other filesystem failure (EACCES, EISDIR, EPERM, I/O) => { record: null,
 * error: 'owner_identity_read_failed: <code>' } — it must never be
 * interpreted as "Owner not registered".
 */
export function readOwnerIdentityFile(homeDir: string): { record: OwnerIdentityRecord | null; error?: string } {
  const filePath = ownerIdentityFilePath(homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === 'ENOENT') return { record: null };
    return {
      record: null,
      error: `owner_identity_read_failed: ${typeof code === 'string' && code.length > 0 ? code : 'unreadable'}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, error: 'owner_identity_malformed: invalid JSON' };
  }
  const result = parseOwnerIdentityRecord(parsed);
  if (result.error !== undefined) return { record: null, error: result.error };
  if (result.record === undefined) {
    return { record: null, error: 'owner_identity_malformed: parse returned no record' };
  }
  return { record: result.record };
}

/**
 * Write ~/.pd/owner.json (mkdir -p, then confirm by re-read). Trims input;
 * rejects empty ownerId/credentialId.
 */
export function writeOwnerIdentityFile(
  homeDir: string,
  input: { ownerId: string; credentialId: string },
): OwnerIdentityFileResult {
  const ownerId = input.ownerId.trim();
  const credentialId = input.credentialId.trim();
  if (!ownerId || !credentialId) {
    return { ok: false, error: 'owner_identity_invalid_input: ownerId and credentialId must be non-empty' };
  }
  const record: OwnerIdentityRecord = {
    schemaVersion: OWNER_IDENTITY_SCHEMA_VERSION,
    ownerId,
    credentialId,
    registeredAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.join(homeDir, '.pd'), { recursive: true });
    fs.writeFileSync(ownerIdentityFilePath(homeDir), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (error) {
    return { ok: false, error: `owner_identity_write_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const reread = readOwnerIdentityFile(homeDir);
  if (reread.record === null) {
    return { ok: false, error: reread.error ?? 'owner_identity_write_confirm_failed: re-read returned no record' };
  }
  return { ok: true, record: reread.record };
}

/**
 * Delete ~/.pd/owner.json. Absent file is a no-op success (unregister is
 * idempotent). Uses unlinkSync (not rmSync) to avoid any rm-interception.
 */
export function deleteOwnerIdentityFile(homeDir: string): OwnerIdentityDeleteResult {
  const filePath = ownerIdentityFilePath(homeDir);
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === 'ENOENT') return { ok: true };
    return { ok: false, error: `owner_identity_delete_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}

/**
 * Resolve the Owner identity — the atomic-pair truth table (ADR-0022):
 *
 *   A. neither env key set                 -> ~/.pd/owner.json (or none)
 *   B. both keys set and non-empty (trim)  -> env
 *   C/D/E. anything else where at least    -> INVALID (fail-closed):
 *          one key is explicitly set          no file fallback, no identity
 */
export function resolveOwnerIdentity(
  env: Record<string, string | undefined>,
  homeDir: string,
): OwnerIdentityResolved {
  const envOwnerIdSet = Object.hasOwn(env, 'PD_OWNER_ID');
  const envCredentialIdSet = Object.hasOwn(env, 'PD_OWNER_CREDENTIAL_ID');
  if (envOwnerIdSet || envCredentialIdSet) {
    const envOwnerId = env.PD_OWNER_ID?.trim() ?? '';
    const envCredentialId = env.PD_OWNER_CREDENTIAL_ID?.trim() ?? '';
    if (envOwnerId && envCredentialId) {
      return { ownerId: envOwnerId, credentialId: envCredentialId, source: 'env' };
    }
    return {
      ownerId: null,
      credentialId: null,
      source: 'invalid_env',
      error: 'owner_identity_invalid_env: PD_OWNER_ID and PD_OWNER_CREDENTIAL_ID must be set together, both non-empty, to use the env override',
    };
  }
  const file = readOwnerIdentityFile(homeDir);
  if (file.record !== null) {
    return { ownerId: file.record.ownerId, credentialId: file.record.credentialId, source: 'file' };
  }
  // A file read failure must not masquerade as a clean "not registered":
  // surface the reason, resolve no identity.
  return file.error !== undefined
    ? { ownerId: null, credentialId: null, source: 'none', error: file.error }
    : { ownerId: null, credentialId: null, source: 'none' };
}
