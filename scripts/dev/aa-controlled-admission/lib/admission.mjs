// PRI-1118 controlled-admission experiment — admission FILE validation.
//
// Owner requirement (2026-11-06): prepare, P0 and execute must validate the
// REAL admission file (creation time, expiry, unconsumed state and hashes),
// not only the command-line arguments that produced it. An argument check
// proves intent; only the file proves what the plugin will actually read.
//
// The 15-minute ceiling is a PD rule, not a host rule: the plugin's
// `validateAdmissionDocument` compares `expiresAt - createdAt` and rejects
// anything longer (`admission_file_invalid`). The earlier attribution to the
// host was wrong and must not reappear.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Bytes, sha256File } from './host-profile.mjs';

export const ADMISSION_SCHEMA = 'pd-aa-controlled-admission/v2';

/** `MAX_ADMISSION_LIFETIME_MS` in packages/openclaw-plugin/src/hooks/controlled-admission.ts. */
export const PD_ADMISSION_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** Allowed skew between the file's `createdAt` field and the filesystem clock. */
const BIRTHTIME_TOLERANCE_MS = 2 * 60 * 1000;

export class AdmissionFileError extends Error {
  constructor(violations, facts) {
    super(`admission file invalid: ${violations.join('; ')}`);
    this.name = 'AdmissionFileError';
    this.code = 'aa_admission_file_invalid';
    this.violations = violations;
    this.facts = facts;
  }
}

function pathKey(path) {
  try {
    const resolved = resolve(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return pathKey(left) === pathKey(right);
}

function parseIso(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return NaN;
  return Date.parse(value);
}

/**
 * Inspect the admission file the plugin will read.
 *
 * `requireUnconsumed` is true for prepare/P0/execute-prior: the plugin writes
 * `consumedAt`/`consumedBy` into this same file, so any non-null value means a
 * claim already happened and the experiment must not start another arm.
 *
 * Returns `{ ok, violations, facts }` and never throws for a file problem; the
 * caller decides whether the phase must abort (`assertAdmissionReady`).
 */
export function inspectAdmissionFile({
  admissionPath,
  plan = null,
  manifestPath = null,
  expectedSha256 = null,
  requireUnconsumed = true,
  now = Date.now(),
} = {}) {
  const violations = [];
  const facts = {
    schemaVersion: 'pd-aa-admission-file-check/v1',
    admissionPath: typeof admissionPath === 'string' ? admissionPath : null,
    exists: false,
    isRegularFile: false,
    fileSha256: null,
    expectedSha256,
    sha256MatchesPlan: null,
    sizeBytes: null,
    createdAt: null,
    createdAtMs: null,
    expiresAt: null,
    expiresAtMs: null,
    lifetimeMs: null,
    ageMs: null,
    remainingMs: null,
    consumedAt: null,
    consumedAtMs: null,
    consumedBy: null,
    manifestSha256: null,
    manifestFileSha256: null,
    manifestPath: null,
    mtime: null,
    mtimeMs: null,
    birthtime: null,
    birthtimeMs: null,
    birthtimeBinding: 'not-applied',
    checkedAt: new Date(now).toISOString(),
  };

  if (typeof admissionPath !== 'string' || admissionPath.trim().length === 0) {
    violations.push('admissionPath is required');
    return { ok: false, violations, facts };
  }
  if (!existsSync(admissionPath)) {
    violations.push(`admission file does not exist: ${admissionPath}`);
    return { ok: false, violations, facts };
  }

  let stat;
  let bytes;
  try {
    stat = statSync(admissionPath);
    if (!stat.isFile()) violations.push('admission path is not a regular file');
    bytes = readFileSync(admissionPath);
  } catch (error) {
    violations.push(`admission file is unreadable: ${String(error?.message ?? error)}`);
    return { ok: false, violations, facts };
  }
  facts.exists = true;
  facts.isRegularFile = stat.isFile();
  facts.sizeBytes = stat.size;
  facts.fileSha256 = sha256Bytes(bytes);
  facts.mtimeMs = stat.mtimeMs;
  facts.mtime = new Date(stat.mtimeMs).toISOString();
  facts.birthtimeMs = stat.birthtimeMs;
  facts.birthtime = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? new Date(stat.birthtimeMs).toISOString() : null;
  if (expectedSha256 !== null) {
    facts.sha256MatchesPlan = facts.fileSha256 === expectedSha256;
    if (!facts.sha256MatchesPlan) violations.push('admission file sha256 differs from the frozen plan');
  }

  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    violations.push(`admission file is not valid JSON: ${String(error?.message ?? error)}`);
    return { ok: false, violations, facts };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    violations.push('admission file is not a JSON object');
    return { ok: false, violations, facts };
  }

  if (document.schemaVersion !== ADMISSION_SCHEMA) {
    violations.push(`schemaVersion ${JSON.stringify(document.schemaVersion)} is not ${ADMISSION_SCHEMA}`);
  }

  facts.createdAt = typeof document.createdAt === 'string' ? document.createdAt : null;
  facts.createdAtMs = parseIso(document.createdAt);
  facts.expiresAt = typeof document.expiresAt === 'string' ? document.expiresAt : null;
  facts.expiresAtMs = parseIso(document.expiresAt);
  facts.consumedAt = document.consumedAt ?? null;
  facts.consumedAtMs = parseIso(document.consumedAt);
  facts.consumedBy = document.consumedBy ?? null;
  facts.manifestSha256 = typeof document.manifestSha256 === 'string' ? document.manifestSha256 : null;
  facts.manifestPath = typeof document.manifestPath === 'string' ? document.manifestPath : null;

  if (!Number.isFinite(facts.createdAtMs)) {
    violations.push('createdAt must be a parseable ISO timestamp');
  } else {
    facts.ageMs = now - facts.createdAtMs;
    if (facts.createdAtMs > now + BIRTHTIME_TOLERANCE_MS) violations.push('createdAt is in the future');
  }
  if (!Number.isFinite(facts.expiresAtMs)) {
    violations.push('expiresAt must be a parseable ISO timestamp');
  } else {
    facts.remainingMs = facts.expiresAtMs - now;
    if (facts.remainingMs <= 0) violations.push('admission is already expired');
  }
  if (Number.isFinite(facts.createdAtMs) && Number.isFinite(facts.expiresAtMs)) {
    facts.lifetimeMs = facts.expiresAtMs - facts.createdAtMs;
    if (facts.lifetimeMs <= 0) {
      violations.push('expiresAt must be after createdAt');
    } else if (facts.lifetimeMs > PD_ADMISSION_MAX_LIFETIME_MS) {
      violations.push(
        `admission lifetime ${facts.lifetimeMs}ms exceeds the PD controlled-admission 15-minute limit (${PD_ADMISSION_MAX_LIFETIME_MS}ms)`,
      );
    }
  }

  if (requireUnconsumed) {
    if (document.consumedAt !== null && document.consumedAt !== undefined) {
      violations.push('consumedAt is not null (admission already consumed)');
    }
    if (document.consumedBy !== null && document.consumedBy !== undefined) {
      violations.push('consumedBy is not null (admission already consumed)');
    }
  }

  // File-time binding: the claimed createdAt must agree with the filesystem's
  // creation time. birthtime is unavailable (0) on some CI filesystems; it is
  // then recorded as skipped rather than fabricated.
  if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 && Number.isFinite(facts.createdAtMs)) {
    facts.birthtimeBinding = 'verified';
    if (Math.abs(stat.birthtimeMs - facts.createdAtMs) > BIRTHTIME_TOLERANCE_MS) {
      violations.push('file birthtime differs from the claimed createdAt');
    }
  }
  if (Number.isFinite(facts.createdAtMs) && stat.mtimeMs < facts.createdAtMs - BIRTHTIME_TOLERANCE_MS) {
    violations.push('file mtime precedes the claimed createdAt');
  }
  if (stat.mtimeMs > now + BIRTHTIME_TOLERANCE_MS) {
    violations.push('file mtime is in the future');
  }

  if (manifestPath !== null) {
    try {
      facts.manifestFileSha256 = sha256File(manifestPath);
    } catch (error) {
      violations.push(`manifest file is unreadable: ${String(error?.message ?? error)}`);
    }
    if (facts.manifestFileSha256 !== null && facts.manifestSha256 !== facts.manifestFileSha256) {
      violations.push('admission.manifestSha256 does not match the manifest file');
    }
  }

  if (plan) {
    if (!samePath(document.experimentRoot, plan.runDir)) violations.push('admission.experimentRoot is not this run directory');
    if (!samePath(document.inputPath, plan.inputFile)) violations.push('admission.inputPath is not the frozen input file');
    if (document.inputSha256 !== plan.inputSha256) violations.push('admission.inputSha256 differs from the frozen input');
    if (!samePath(document.manifestPath, plan.manifestPath)) violations.push('admission.manifestPath is not the frozen manifest');
    if (document.manifestSha256 !== plan.manifestSha256) violations.push('admission.manifestSha256 differs from the frozen manifest');
    if (document.targetArtifactId !== plan.mapping?.artifactId) violations.push('admission.targetArtifactId differs from the frozen target');
    if (document.targetActivationId !== plan.mapping?.activationId) violations.push('admission.targetActivationId differs from the frozen target');
    if (document.expiresAt !== plan.mapping?.expiresAt) violations.push('admission.expiresAt differs from the frozen activation expiry');
    if (document.fixtureRef !== plan.fixtureRef) violations.push('admission.fixtureRef differs from the frozen fixture');
    if (plan.sessionBinding === 'predeclared') {
      if (document.sessionBinding !== 'predeclared') violations.push('admission.sessionBinding is not predeclared');
      if (document.expectedSessionId !== plan.expectedSessionId) violations.push('admission.expectedSessionId differs from the frozen session');
    } else if (plan.sessionBinding === 'first_consumer') {
      if (document.sessionBinding !== 'first_consumer') violations.push('admission.sessionBinding is not first_consumer');
      if (document.expectedSessionId !== null) violations.push('admission.expectedSessionId must be null for first_consumer');
    } else {
      violations.push('plan.sessionBinding is not a supported binding');
    }
  }

  return { ok: violations.length === 0, violations, facts };
}

/** Abort the phase when the real admission file is not ready. */
export function assertAdmissionReady(options) {
  const result = inspectAdmissionFile(options);
  if (!result.ok) throw new AdmissionFileError(result.violations, result.facts);
  return result;
}
