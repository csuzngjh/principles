#!/usr/bin/env node
/**
 * Installer payload component-version contract.
 *
 * WHY THIS EXISTS (release 1.150.1 / cohort 8851a3be8 / tag v3.2.1):
 * `bundle-plugin.mjs` has two version sources — the committed source tree
 * (preserve mode) and the movable npm registry `latest` (default mode). The
 * npm installer leg intended to preserve source versions, but the exported
 * `PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1` lived in the "Build target package"
 * step while the bundle actually ran from the later pack step's `prepack`
 * lifecycle. Step-scoped environment does not cross steps, so the registry
 * branch ran and rewrote `pd-cli` 2.2.0 → 2.1.0 from `latest` (the newer
 * version was not published yet). The tarball shipped a CLI one version
 * behind every other component.
 *
 * The contract has two halves:
 *   1. `resolveBundledComponentVersion` — a bundle must never choose a
 *      version OLDER than the source tree it was built from. Preserve mode
 *      always keeps the source version; default mode may only move forward
 *      to the registry (the historical "working tree is stale" sync).
 *   2. `verifyInstallerPayloadVersions` — the packed installer must carry
 *      exactly the versions committed at the release cohort for every
 *      runtime component. Whatever future change rewrites a payload manifest,
 *      the pack leg fails before anything is published.
 */

import { execFileSync } from 'node:child_process';

/**
 * The runtime components every installer payload ships, with the npm name
 * they are published under (documentation only — the source path is the
 * authority). Adding a component to the installer payload means adding it
 * here too; the assertion below fails closed on a missing manifest rather
 * than silently skipping it.
 */
export const INSTALLER_PAYLOAD_COMPONENTS = Object.freeze([
  { label: 'pd-cli', payloadPath: 'pd-cli/package.json', sourcePath: 'packages/pd-cli/package.json' },
  { label: 'core', payloadPath: 'core/package.json', sourcePath: 'packages/principles-core/package.json' },
  { label: 'host-runtime', payloadPath: 'host-runtime/package.json', sourcePath: 'packages/host-runtime/package.json' },
  { label: 'codex-adapter', payloadPath: 'codex-adapter/package.json', sourcePath: 'packages/codex-adapter/package.json' },
  { label: 'plugin', payloadPath: 'plugin/package.json', sourcePath: 'packages/openclaw-plugin/package.json' },
]);

const STRICT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStrict(version) {
  if (typeof version !== 'string') return null;
  const match = STRICT_VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Strict x.y.z ordering; `null` when either side is not strict semver. */
export function compareStrictVersions(a, b) {
  const left = parseStrict(a);
  const right = parseStrict(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Choose the version a bundled component manifest carries.
 *
 * - preserve mode (release cohort / immutable asset): the committed source
 *   version, unconditionally. The registry is a movable, later-published
 *   fact and must not define artifact content (SPEC v1.2 §21).
 * - default mode: forward sync to registry `latest` only. A registry version
 *   older than the source tree is never installed over it — that is the
 *   downgrade this module exists to make impossible.
 *
 * Returns `{ version, refusedDowngrade }` so the caller can report the
 * refusal instead of degrading silently (rc-9).
 */
export function resolveBundledComponentVersion({ label, sourceVersion, registryVersion, preserveSourceVersions }) {
  if (!parseStrict(sourceVersion) && typeof sourceVersion !== 'string') {
    throw new Error(`${label}: source version is not a string (${JSON.stringify(sourceVersion)})`);
  }
  if (preserveSourceVersions || registryVersion == null || registryVersion === '') {
    return { version: sourceVersion, refusedDowngrade: false };
  }
  const order = compareStrictVersions(registryVersion, sourceVersion);
  if (order === null) {
    throw new Error(
      `${label}: cannot order source version ${JSON.stringify(sourceVersion)} and registry version ${JSON.stringify(registryVersion)} — refusing to guess which one is newer.`,
    );
  }
  if (order < 0) {
    return { version: sourceVersion, refusedDowngrade: true };
  }
  return { version: registryVersion, refusedDowngrade: false };
}

function parseManifest(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: manifest is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: manifest is not a JSON object`);
  }
  if (typeof value.version !== 'string' || value.version === '') {
    throw new Error(`${label}: manifest has no package version`);
  }
  return value;
}

/**
 * Read each component's committed version from the cohort commit. This is the
 * only authority: the payload is built from that tree, so it must advertise
 * exactly those versions regardless of what npm `latest` points at now.
 */
export function readCommittedComponentVersions({ repoRoot, cohort, readCommittedFile } = {}) {
  if (typeof cohort !== 'string' || !/^[a-f0-9]{40}$/.test(cohort)) {
    // `HEAD` is intentionally rejected: a moving ref cannot pin artifact
    // content, and callers must pass the resolved cohort SHA (rc-6 line).
    throw new Error(`readCommittedComponentVersions: cohort must be a full 40-char git sha, got ${JSON.stringify(cohort)}`);
  }
  const read =
    readCommittedFile ??
    ((path) =>
      execFileSync('git', ['show', `${cohort}:${path}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }));
  return INSTALLER_PAYLOAD_COMPONENTS.map((component) => {
    const label = `${component.label} (${cohort.slice(0, 10)}:${component.sourcePath})`;
    let raw;
    try {
      raw = read(component.sourcePath);
    } catch (error) {
      throw new Error(
        `${label}: cannot read the committed component manifest — refusing to verify a payload whose expected version is unknown (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const manifest = parseManifest(raw, label);
    return { ...component, version: manifest.version };
  });
}

/**
 * Fail-closed comparison of the packed installer payload against the cohort.
 *
 * `readPayloadManifest(payloadPath)` returns the parsed manifest of a file
 * inside the packed `package/` root; a missing file must throw. Every
 * mismatch is reported together, and a missing component is a failure — an
 * unpinned component is exactly the silent-skip this guard forbids.
 */
export function verifyInstallerPayloadVersions({ committed, readPayloadManifest }) {
  if (!Array.isArray(committed) || committed.length === 0) {
    throw new Error('verifyInstallerPayloadVersions: no committed component versions were supplied');
  }
  const mismatches = [];
  for (const component of committed) {
    let actual;
    try {
      actual = parseManifest(
        readPayloadManifest(component.payloadPath),
        `${component.label} (${component.payloadPath})`,
      ).version;
    } catch (error) {
      mismatches.push({
        label: component.label,
        payloadPath: component.payloadPath,
        expected: component.version,
        actual: null,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (actual !== component.version) {
      mismatches.push({
        label: component.label,
        payloadPath: component.payloadPath,
        expected: component.version,
        actual,
        reason: 'version differs from the cohort commit',
      });
    }
  }
  if (mismatches.length > 0) {
    const lines = mismatches.map(
      (m) => `  - ${m.label} (${m.payloadPath}): expected ${m.expected}, got ${m.actual ?? '<missing>'} — ${m.reason}`,
    );
    throw new Error(
      [
        `[installer-payload-versions] ${mismatches.length} bundled component(s) do not match the release cohort commit:`,
        ...lines,
        'nextAction: the installer bundle must preserve the source-tree versions (PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1 on the step that runs pack/prepack).',
        'A payload version that differs from the cohort is a downgrade or a mixed-version release; it must never be published.',
      ].join('\n'),
    );
  }
  return { components: committed.map((component) => ({ label: component.label, version: component.version })) };
}
