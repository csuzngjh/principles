/**
 * Supported Codex ingestion version contract (Codex Governance Closure
 * Slice A; ADR-0020 §11.2 + G1 probe report §9).
 *
 * The G1 contract baseline is: minimum supported Codex 0.148.0, verified
 * on-device at 0.150.1. The transcript itself carries `session_meta.
 * payload.cli_version`, which is the version signal available inside a hook
 * subprocess (hook payloads carry no version field — G1 fixture contract).
 *
 * Older-than-minimum and newer-than-verified versions both degrade
 * explicitly; an unknown version must never silently guess record fields.
 * Adopting a newer Codex version requires re-running the contract probe and
 * refreshing the fixtures (G1 report §9 drift-detection boundary).
 */

export const CODEX_INGESTION_MIN_VERSION = '0.148.0';
export const CODEX_INGESTION_VERIFIED_VERSION = '0.150.1';

export type CodexVersionClassification =
  | { status: 'supported' }
  | { status: 'unsupported_below'; reason: 'unsupported_codex_version' }
  | { status: 'unverified_above'; reason: 'codex_version_unverified' }
  | { status: 'unknown'; reason: 'codex_version_unverified' };

export const CODEX_VERSION_NEXT_ACTION = 'rerun the Codex contract probe / update supported fixtures (docs/architecture/CODEX_G1_CONTRACT_PROBE_REPORT.md §9)';

interface Semver { major: number; minor: number; patch: number }

function isDigits(value: string): boolean {
  return value.length > 0 && /^[0-9]+$/.test(value);
}

function parseSemver(value: string): Semver | null {
  const parts = value.trim().split('.');
  if (parts.length < 3) return null;
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (!isDigits(major) || !isDigits(minor) || !isDigits(patch)) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function classifyCodexVersion(cliVersion: string | null | undefined): CodexVersionClassification {
  if (typeof cliVersion !== 'string' || cliVersion.trim().length === 0) {
    return { status: 'unknown', reason: 'codex_version_unverified' };
  }
  const version = parseSemver(cliVersion);
  const min = parseSemver(CODEX_INGESTION_MIN_VERSION);
  const verified = parseSemver(CODEX_INGESTION_VERIFIED_VERSION);
  if (!version || !min || !verified) return { status: 'unknown', reason: 'codex_version_unverified' };
  if (compareSemver(version, min) < 0) return { status: 'unsupported_below', reason: 'unsupported_codex_version' };
  if (compareSemver(version, verified) > 0) return { status: 'unverified_above', reason: 'codex_version_unverified' };
  return { status: 'supported' };
}
