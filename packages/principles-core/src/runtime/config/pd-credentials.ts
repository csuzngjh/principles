/**
 * PD local provider credentials — the ONE resolver for LLM API keys.
 *
 * Why this module exists (Owner-authorized revision of ADR-0016 §2.2 / §5,
 * ADR-0022 §2.1, 2026-11-14):
 *
 *   `.pd/config.yaml` still must NEVER contain a secret value (the validator
 *   keeps rejecting apiKey/token/secret/password). Provider keys live in ONE
 *   local file instead, so the console can offer "pick a provider, paste the
 *   key" without teaching users YAML or shell environment setup.
 *
 * Resolution precedence (single source of truth, same shape as owner-identity):
 *
 *   process env[apiKeyEnv] (highest — CI/ops, unchanged behaviour)
 *     -> ~/.pd/credentials.yaml
 *     -> none
 *
 * Security properties (documented honestly, not overstated):
 * - The file is written with mode 0600. POSIX honours it; Windows ignores the
 *   mode bits, so we additionally drop inheritance with `icacls` and grant the
 *   current user only. That is best-effort: if icacls is unavailable the write
 *   still succeeds and the caller is told `permissions: 'best_effort'`.
 * - Any process running as the same OS user can read the file. This is not a
 *   sandbox; it is user-scoped local storage.
 * - This module never logs, returns or embeds key VALUES in errors. Callers
 *   that need to show something must use `maskCredentialValue` (last 4 only).
 *
 * I/O seam: registered as `pd-credentials` in
 * packages/principles-core/io-seam-registry.json.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { defaultOwnerIdentityHomeDir } from '../owner-identity.js';

export const PD_CREDENTIALS_SCHEMA_VERSION = 1 as const;
export const PD_CREDENTIALS_DIR_NAME = '.pd';
export const PD_CREDENTIALS_FILE_NAME = 'credentials.yaml';

/** Uppercase env-var names only: the file is keyed by `runtimeProfiles.*.apiKeyEnv`. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_API_KEY_LENGTH = 8192;

export type CredentialSource = 'env' | 'file' | 'none';

/** How hardened the on-disk file actually is. Never claims more than achieved. */
export type CredentialFilePermissions = 'restricted' | 'best_effort';

export interface CredentialEntry {
  apiKey: string;
  updatedAt: string;
}

export interface ResolvedCredential {
  /** Secret value, or null when nowhere to be found. NEVER log this field. */
  value: string | null;
  source: CredentialSource;
  /** Machine-readable reason when the file could not be read/parsed. No values. */
  error?: string;
}

export interface CredentialStatus {
  configured: boolean;
  source: CredentialSource;
  /** Last four characters of the resolved key. Only present when long enough. */
  last4?: string;
  /** Present when a credentials file exists but could not be parsed. */
  error?: string;
}

export type CredentialWriteResult =
  | { ok: true; filePath: string; permissions: CredentialFilePermissions }
  | { ok: false; error: string };

export type CredentialDeleteResult =
  | { ok: true; removed: boolean; filePath: string }
  | { ok: false; error: string };

type CredentialsFileRead =
  | { ok: true; entries: Record<string, CredentialEntry>; filePath: string }
  | { ok: false; error: string; filePath: string };

export function credentialsFilePath(homeDir: string): string {
  return path.join(homeDir, PD_CREDENTIALS_DIR_NAME, PD_CREDENTIALS_FILE_NAME);
}

/**
 * `<home>/.pd` location. Delegates to the owner-identity home resolver so an
 * experiment instance (`PD_EXPERIMENT_ROOT`) writes its OWN credentials file
 * instead of the production `~/.pd/credentials.yaml`.
 */
export function defaultCredentialsHomeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return defaultOwnerIdentityHomeDir(env);
}

export function isValidCredentialEnvName(value: string): boolean {
  return ENV_NAME_PATTERN.test(value);
}

/** Last four characters, or undefined for short/empty values. Server-side only. */
export function maskCredentialValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 8) return undefined;
  return trimmed.slice(-4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the credentials document. Untrusted YAML (rc-1): every level is
 * validated, malformed entries are dropped, and the reason is reported WITHOUT
 * echoing file contents (rc-3/rc-8).
 */
function parseCredentialsDocument(
  raw: unknown,
): { ok: true; entries: Record<string, CredentialEntry> } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'credentials_malformed: expected a YAML object' };
  }
  if (raw.schemaVersion !== PD_CREDENTIALS_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `credentials_malformed: unsupported schemaVersion ${String(raw.schemaVersion)}`,
    };
  }
  if (!isRecord(raw.credentials)) {
    return { ok: false, error: 'credentials_malformed: credentials must be a mapping' };
  }
  const entries: Record<string, CredentialEntry> = {};
  for (const [envName, entryRaw] of Object.entries(raw.credentials)) {
    if (!isValidCredentialEnvName(envName) || !isRecord(entryRaw)) continue;
    const apiKey = typeof entryRaw.apiKey === 'string' ? entryRaw.apiKey.trim() : '';
    if (apiKey === '') continue;
    const updatedAt = typeof entryRaw.updatedAt === 'string' ? entryRaw.updatedAt : '';
    entries[envName] = { apiKey, updatedAt };
  }
  return { ok: true, entries };
}

function readCredentialsFile(homeDir: string): CredentialsFileRead {
  const filePath = credentialsFilePath(homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === 'ENOENT') return { ok: true, entries: {}, filePath };
    return {
      ok: false,
      filePath,
      error: `credentials_read_failed: ${typeof code === 'string' && code.length > 0 ? code : 'unreadable'}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    return { ok: false, filePath, error: 'credentials_malformed: invalid YAML' };
  }
  const result = parseCredentialsDocument(parsed);
  if (!result.ok) return { ok: false, filePath, error: result.error };
  return { ok: true, entries: result.entries, filePath };
}

/**
 * Resolve the key for a runtime profile's `apiKeyEnv`.
 *
 * ENV ALWAYS WINS. A non-empty env value is returned without even reading the
 * file, so existing deployments (and CI) behave exactly as before.
 */
export function resolveProviderApiKey(
  envName: string,
  options: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
  } = {},
): ResolvedCredential {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? defaultCredentialsHomeDir({ ...process.env, ...env });
  const fromEnv = env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), source: 'env' };
  }
  const file = readCredentialsFile(homeDir);
  if (!file.ok) {
    return { value: null, source: 'none', error: file.error };
  }
  const entry = Object.hasOwn(file.entries, envName) ? file.entries[envName] : undefined;
  if (entry === undefined) return { value: null, source: 'none' };
  return { value: entry.apiKey, source: 'file' };
}

/** Status for the console. Returns `last4` only — never the value. */
export function getCredentialStatus(
  envName: string,
  options: { env?: Record<string, string | undefined>; homeDir?: string } = {},
): CredentialStatus {
  if (!isValidCredentialEnvName(envName)) {
    return { configured: false, source: 'none', error: 'credentials_invalid_env_name' };
  }
  const resolved = resolveProviderApiKey(envName, options);
  if (resolved.value === null) {
    return {
      configured: false,
      source: 'none',
      ...(resolved.error !== undefined ? { error: resolved.error } : {}),
    };
  }
  const last4 = maskCredentialValue(resolved.value);
  return {
    configured: true,
    source: resolved.source,
    ...(last4 !== undefined ? { last4 } : {}),
  };
}

/**
 * POSIX 0600 + Windows inheritance drop. Returns what was actually achieved.
 * Never throws: a hardening failure must not turn a saved key into a 500.
 */
function hardenCredentialFile(filePath: string, dirPath: string): CredentialFilePermissions {
  let permissions: CredentialFilePermissions;
  try {
    fs.chmodSync(dirPath, 0o700);
    fs.chmodSync(filePath, 0o600);
    permissions = 'restricted';
  } catch {
    permissions = 'best_effort';
  }
  if (process.platform !== 'win32') return permissions;

  const user = process.env.USERNAME?.trim() || os.userInfo().username.trim();
  if (user === '') return permissions;
  try {
    // /inheritance:r drops inherited ACEs; /grant:r replaces this user's ACE.
    // Other explicit ACEs are not stripped — hence "best effort", reported as such.
    execFileSync(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${user}:F`],
      { stdio: 'ignore', windowsHide: true, timeout: 5_000 },
    );
    return 'restricted';
  } catch {
    return permissions;
  }
}

function serializeDocument(entries: Record<string, CredentialEntry>): string {
  const document = {
    schemaVersion: PD_CREDENTIALS_SCHEMA_VERSION,
    credentials: Object.fromEntries(
      Object.entries(entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([envName, entry]) => [
          envName,
          { apiKey: entry.apiKey, updatedAt: entry.updatedAt },
        ]),
    ),
  };
  return yaml.dump(document, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quoteStyle: 'double',
    forceQuotes: false,
  });
}

function writeCredentialsFile(
  homeDir: string,
  entries: Record<string, CredentialEntry>,
): CredentialWriteResult {
  const dirPath = path.join(homeDir, PD_CREDENTIALS_DIR_NAME);
  const filePath = credentialsFilePath(homeDir);
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      error: `credentials_dir_create_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, serializeDocument(entries), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure — the write error is the actionable one
    }
    return {
      ok: false,
      error: `credentials_write_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, filePath, permissions: hardenCredentialFile(filePath, dirPath) };
}

/**
 * Upsert one credential. Refuses to overwrite a malformed file (that would
 * destroy credentials this write never read) and reports why.
 */
export function saveProviderApiKey(
  envName: string,
  apiKey: string,
  options: { homeDir?: string } = {},
): CredentialWriteResult {
  if (!isValidCredentialEnvName(envName)) {
    return { ok: false, error: 'credentials_invalid_env_name' };
  }
  const trimmed = apiKey.trim();
  if (trimmed === '') return { ok: false, error: 'credentials_empty_api_key' };
  if (trimmed.length > MAX_API_KEY_LENGTH) {
    return { ok: false, error: 'credentials_api_key_too_long' };
  }
  if (/[\r\n]/.test(trimmed) || trimmed.includes(String.fromCharCode(0))) {
    return { ok: false, error: 'credentials_api_key_invalid_characters' };
  }
  const homeDir = options.homeDir ?? defaultCredentialsHomeDir();
  const existing = readCredentialsFile(homeDir);
  if (!existing.ok) {
    return {
      ok: false,
      error: `${existing.error}; refusing to overwrite the file — fix or remove ${existing.filePath} first`,
    };
  }
  const next: Record<string, CredentialEntry> = {
    ...existing.entries,
    [envName]: { apiKey: trimmed, updatedAt: new Date().toISOString() },
  };
  return writeCredentialsFile(homeDir, next);
}

export function deleteProviderApiKey(
  envName: string,
  options: { homeDir?: string } = {},
): CredentialDeleteResult {
  if (!isValidCredentialEnvName(envName)) {
    return { ok: false, error: 'credentials_invalid_env_name' };
  }
  const homeDir = options.homeDir ?? defaultCredentialsHomeDir();
  const existing = readCredentialsFile(homeDir);
  if (!existing.ok) {
    return { ok: false, error: `${existing.error}; refusing to rewrite ${existing.filePath}` };
  }
  if (!Object.hasOwn(existing.entries, envName)) {
    return { ok: true, removed: false, filePath: existing.filePath };
  }
  const next = { ...existing.entries };
  delete next[envName];
  const written = writeCredentialsFile(homeDir, next);
  if (!written.ok) return written;
  return { ok: true, removed: true, filePath: written.filePath };
}

/**
 * Remove every occurrence of the given secret values from arbitrary upstream
 * error text before it reaches a log, an API response or the UI (rc-8/rc-9).
 * Also strips generic bearer/`sk-` shapes so a provider echo cannot leak.
 */
export function redactSecretsFromText(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.trim() === '') continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/\bBearer\s+[A-Za-z0-9._+/=-]{6,}\b/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, '[REDACTED]')
    .slice(0, 800);
}

/**
 * Public facade (exported as `pdProviderCredentials` from `@principles/core/runtime`).
 * One object keeps the cross-package export surface small while keeping the
 * individual functions unit-testable inside core.
 */
export const pdProviderCredentials = {
  resolve: resolveProviderApiKey,
  status: getCredentialStatus,
  save: saveProviderApiKey,
  remove: deleteProviderApiKey,
  mask: maskCredentialValue,
  isValidEnvName: isValidCredentialEnvName,
  filePath: credentialsFilePath,
  redact: redactSecretsFromText,
} as const;
