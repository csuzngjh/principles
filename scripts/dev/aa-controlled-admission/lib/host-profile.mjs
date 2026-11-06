// PRI-1118 controlled-admission experiment — the isolated host identity.
//
// Owner decision (2026-11-06, option B): the experiment installs OpenClaw in an
// isolated directory and uses THAT executable. This module therefore never
// guesses a global install path: the caller must pass the isolated prefix.
//
// P0 and the run launcher both resolve the host through this module, so the two
// phases cannot drift onto different executables, versions or packages.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false, reason: 'not a JSON object' };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function existsAsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the isolated host prefix (the directory holding node_modules/openclaw).
 * Every failure is returned as a structured reason; nothing is repaired here.
 */
export function resolveHostProfile({ hostRoot, expectedVersion = null } = {}) {
  if (typeof hostRoot !== 'string' || hostRoot.trim().length === 0) {
    return { ok: false, reason: 'host root is required (the isolated install prefix)' };
  }
  if (!isAbsolute(hostRoot)) return { ok: false, reason: 'host root must be an absolute path' };
  const root = resolve(hostRoot);
  if (!existsSync(root)) return { ok: false, reason: `host root does not exist: ${root}` };

  const packageDir = join(root, 'node_modules', 'openclaw');
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsAsFile(packageJsonPath)) return { ok: false, reason: 'isolated openclaw package.json is missing', packageDir };

  const parsed = readJsonObject(packageJsonPath);
  if (!parsed.ok) return { ok: false, reason: `package.json unreadable: ${parsed.reason}`, packageDir };
  const version = typeof parsed.value.version === 'string' ? parsed.value.version : null;
  if (!version) return { ok: false, reason: 'package.json has no version', packageDir };
  if (expectedVersion && version !== expectedVersion) {
    return { ok: false, reason: `host version ${version} does not match required ${expectedVersion}`, packageDir, version };
  }

  const lifecyclePendingPaths = [
    join(packageDir, '.openclaw-lifecycle-pending'),
    join(dirname(packageDir), '.openclaw-lifecycle-pending'),
    join(root, '.openclaw-lifecycle-pending'),
  ];
  const lifecyclePending = lifecyclePendingPaths.filter((path) => existsSync(path));

  // fs-safe may be hoisted to the prefix; resolve it the way node would from the
  // package, never by a single hard-coded path.
  let fsSafePath = null;
  try {
    fsSafePath = dirname(createRequire(packageJsonPath).resolve('@openclaw/fs-safe/package.json'));
  } catch {
    fsSafePath = null;
  }

  const cliPath = join(packageDir, 'openclaw.mjs');
  if (!existsAsFile(cliPath)) return { ok: false, reason: 'isolated openclaw.mjs is missing', packageDir, version };
  const cliSha256 = sha256File(cliPath);
  const nodePath = process.execPath;
  const identitySha256 = sha256Bytes(Buffer.from(`${nodePath}\n${cliPath}\n${cliSha256}\n${version}\n`, 'utf8'));

  return {
    ok: true,
    hostRoot: root,
    packageDir,
    packageJsonPath,
    version,
    lifecyclePendingPaths,
    lifecyclePending,
    fsSafePath,
    healthy: lifecyclePending.length === 0 && fsSafePath !== null,
    cliPath,
    cliSha256,
    nodePath,
    identitySha256,
  };
}

/** Absolute argv prefix for a host CLI call (node + openclaw.mjs, no shell). */
export function hostCommand(host) {
  if (!host || typeof host.nodePath !== 'string' || typeof host.cliPath !== 'string') {
    throw new Error('hostCommand: host profile is incomplete');
  }
  return { command: host.nodePath, prefixArgs: [host.cliPath] };
}

/** The host identity fields that must match between P0 and the run launcher. */
export function hostIdentity(host) {
  if (!host || typeof host !== 'object') return null;
  return {
    nodePath: host.nodePath ?? null,
    cliPath: host.cliPath ?? null,
    cliSha256: host.cliSha256 ?? null,
    version: host.version ?? null,
    identitySha256: host.identitySha256 ?? null,
  };
}

export function verifyHostIdentity(expected, actual) {
  const violations = [];
  if (!expected || !actual) {
    violations.push('host identity missing on one side');
    return violations;
  }
  for (const key of ['nodePath', 'cliPath', 'cliSha256', 'version', 'identitySha256']) {
    if (expected[key] !== actual[key]) violations.push(`host.${key} differs (${expected[key]} != ${actual[key]})`);
  }
  return violations;
}

export function isRegularFile(path) {
  try {
    return !lstatSync(path).isSymbolicLink() && statSync(path).isFile();
  } catch {
    return false;
  }
}
