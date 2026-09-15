// Worktree readiness probes — L1 dependencies, L2 build, L3 runtime resolution
// (PRI-796, SPEC §8; AGENTS.md §23A git-13).
//
// WHY NOT existsSync
// The failure this module exists to prevent is a SILENT false verification:
// with an npm-workspace monorepo, `node_modules/@principles/core` inside a task
// worktree can resolve to the PRIMARY checkout's `packages/principles-core/dist`
// — through a junction, a stale symlink, or a hoisted dependency. The worktree
// then appears to be "testing its own code" while actually exercising the
// control plane's build output. Every probe here therefore asks Node to perform
// a REAL module resolution and then asserts the resolved absolute path is
// inside the worktree. Anything else is PRIMARY_LEAKAGE and a hard failure.
//
// Three levels, each answering a different question:
//   L1  Can the worktree resolve ITS OWN workspace packages?  (dependencies)
//   L2  Did the build authority emit the artifacts it promises? (build)
//   L3  Do real specifiers resolve to those artifacts, inside this tree? (runtime)
//
// Read-only, fast, fail loud. It never installs, builds, or repairs — repairing
// belongs to `dev:worktree:bootstrap`.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CODES } from './preflight.mjs';

/**
 * L3 probe set, DERIVED from the manifests rather than hardcoded.
 *
 * A literal list of specifiers ("@principles/core/runtime-v2", …) would be a
 * second source of truth: adding a package or an export subpath would silently
 * drop it from coverage, and the probe set would rot. Each package's own
 * `exports`/`bin` IS the contract, so it is read from there (P4).
 *
 * Scoped to the packages the root build authority covers, for the same reason as
 * L2: a worktree bootstrapped with the supported `npm run build` must not be
 * failed for an artifact that authority never promised (pd-cli and pd-console
 * build outside the root chain).
 *
 * @returns {{probes: Array<{label: string, specifier: string}>, bins: Array<{label: string, file: string, specifier: string}>}}
 */
export function deriveRuntimeProbes(worktreeRoot, packages) {
  const covered = coveredByRootBuild(worktreeRoot);
  const coveredNames = new Set(covered.names);
  const probes = [];
  const bins = [];

  for (const pkg of packages) {
    if (!coveredNames.has(pkg.name)) continue;

    // Probe the package ROOT entry only when the manifest declares one. A
    // bin-only package (create-principles-disciple: no `main`, no `exports`) has
    // no root specifier, so resolving it there would report a false NOT_READY —
    // its CLI entry is probed separately below.
    const hasRootEntry =
      (pkg.manifest.exports && typeof pkg.manifest.exports === 'object' && '.' in pkg.manifest.exports) ||
      typeof pkg.manifest.main === 'string';
    if (hasRootEntry) {
      probes.push({ label: pkg.name, specifier: pkg.name });
    }

    // Every declared export subpath EXCEPT '.', which the package-root probe
    // above already covers (probing it twice would just duplicate a line).
    const exportsMap = pkg.manifest.exports;
    if (exportsMap && typeof exportsMap === 'object') {
      for (const key of Object.keys(exportsMap)) {
        if (key === '.' || key === './package.json') continue;
        probes.push({ label: pkg.name + key.replace(/^\./, ''), specifier: pkg.name + '/' + key.replace(/^\.\//, '') });
      }
    }

    // CLI entry points declared by this package.
    const bin = pkg.manifest.bin;
    if (typeof bin === 'string' && bin.length > 0) {
      bins.push({ label: pkg.name + ' (bin)', file: path.join(pkg.dir, bin), specifier: bin });
    } else if (bin && typeof bin === 'object') {
      for (const [key, rel] of Object.entries(bin)) {
        if (typeof rel !== 'string' || rel.length === 0) continue;
        bins.push({ label: pkg.name + ' bin:' + key, file: path.join(pkg.dir, rel), specifier: rel });
      }
    }
  }

  return { probes, bins, covered: covered.names };
}

/** Compare paths the way Windows/macOS actually resolve them. */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  const p = realPathOf(parent);
  const c = realPathOf(child);
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Real (symlink-resolved) absolute path, or the lexical form when it is absent. */
export function realPathOf(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Read a JSON file, returning null when absent or unparsable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Detect an install that predates the current lockfile.
 *
 * WHY THIS EXISTS (observed, not hypothetical): a fresh worktree was installed,
 * then `git merge origin/main` brought a dependency bump (js-yaml 4 → 5) in
 * `package-lock.json`. `npm run build` still "worked" far enough to fail with
 * `error TS2339: Property 'YAML11_SCHEMA' does not exist on type 'typeof
 * import("js-yaml")'` — a confusing TYPE error for what was really a STALE
 * ENVIRONMENT. `scripts/setup-worktree.mjs` skipped the install because
 * `node_modules/` merely EXISTED, so "bootstrap ran" was mistaken for "the tree
 * is trustworthy".
 *
 * The signal: npm rewrites both `package-lock.json` and
 * `node_modules/.package-lock.json` on a successful install, so a lockfile that
 * is NEWER than the installed marker (by more than the write-ordering margin)
 * can only mean the lock changed without a re-install. That happens on every
 * `git merge` / `git checkout` that touches the lock.
 *
 * Deliberately one-directional: the failure mode we accept is an occasional
 * unnecessary `npm install`; what we must not accept is silently building
 * against a dependency tree that does not match the lockfile.
 *
 * @returns {{stale: boolean, reason: string|null, lockMtime: number|null, markerMtime: number|null}}
 */
export const INSTALL_MARKER_MTIME_MARGIN_MS = 2000;

export function detectStaleInstall(worktreeRoot) {
  const lock = path.join(worktreeRoot, 'package-lock.json');
  const marker = path.join(worktreeRoot, 'node_modules', '.package-lock.json');
  const statOrNull = (file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const lockMtime = statOrNull(lock);
  const markerMtime = statOrNull(marker);
  if (lockMtime === null) return { stale: false, reason: null, lockMtime, markerMtime };
  if (markerMtime === null) {
    // No install marker at all: either nothing is installed (L1's own
    // "node_modules present" check already fails) or the install predates
    // npm's marker convention. Not evidence of drift by itself.
    return { stale: false, reason: null, lockMtime, markerMtime };
  }
  if (lockMtime > markerMtime + INSTALL_MARKER_MTIME_MARGIN_MS) {
    return {
      stale: true,
      reason:
        'package-lock.json is newer than node_modules/.package-lock.json — the lockfile changed after the last install ' +
        '(a merge or checkout rewrote it). Installed dependency versions may not match the lockfile.',
      lockMtime,
      markerMtime,
    };
  }
  return { stale: false, reason: null, lockMtime, markerMtime };
}

/**
 * Enumerate the workspace packages declared by the root `package.json`.
 * Only `packages/*` is supported in this repository; the glob is read rather
 * than assumed so a future layout change surfaces here instead of silently
 * reducing coverage to zero.
 *
 * @returns {Array<{name: string, dir: string, dirName: string, manifest: object}>}
 */
export function listWorkspacePackages(worktreeRoot) {
  const rootManifest = readJson(path.join(worktreeRoot, 'package.json'));
  if (!rootManifest || !Array.isArray(rootManifest.workspaces)) {
    throw new Error('no workspace manifest at ' + path.join(worktreeRoot, 'package.json'));
  }
  const packages = [];
  for (const entry of rootManifest.workspaces) {
    if (entry !== 'packages/*') {
      throw new Error("unsupported workspace pattern '" + entry + "' — extend listWorkspacePackages deliberately");
    }
    const base = path.join(worktreeRoot, 'packages');
    let dirNames;
    try {
      dirNames = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const dirName of dirNames) {
      const dir = path.join(base, dirName);
      const manifest = readJson(path.join(dir, 'package.json'));
      if (!manifest || !manifest.name) continue;
      packages.push({ name: manifest.name, dir, dirName, manifest });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Names the ROOT build authority covers, parsed from the authority itself.
 * `npm run build` in the root manifest is the single ordering authority
 * (SPEC §7.2) — this deliberately derives from that script rather than keeping
 * a parallel list, which would be a second source of truth (P4).
 *
 * @returns {{names: string[], parsed: boolean}}
 */
export function coveredByRootBuild(worktreeRoot) {
  const rootManifest = readJson(path.join(worktreeRoot, 'package.json'));
  const script = rootManifest?.scripts?.build;
  if (typeof script !== 'string' || script.length === 0) return { names: [], parsed: false };
  const names = new Set();
  const re = /--workspace(?:=|\s+)([^\s&]+)/g;
  let m;
  while ((m = re.exec(script)) !== null) names.add(m[1]);
  return { names: [...names].sort(), parsed: names.size > 0 };
}

/**
 * The artifact a package's own contract promises: `main`, else its first `bin`.
 * Returning null means "no artifact contract" (e.g. a website) — skipped.
 */
export function declaredEntry(pkg) {
  if (typeof pkg.manifest.main === 'string' && pkg.manifest.main.length > 0) {
    return { kind: 'main', file: path.join(pkg.dir, pkg.manifest.main), spec: pkg.manifest.main };
  }
  const bin = pkg.manifest.bin;
  if (typeof bin === 'string' && bin.length > 0) {
    return { kind: 'bin', file: path.join(pkg.dir, bin), spec: bin };
  }
  if (bin && typeof bin === 'object') {
    const first = Object.values(bin)[0];
    if (typeof first === 'string' && first.length > 0) {
      return { kind: 'bin', file: path.join(pkg.dir, first), spec: first };
    }
  }
  return null;
}

/**
 * Locate the directory a dependency resolves to, WITHOUT requiring the package
 * to declare a `./package.json` export and WITHOUT requiring its build output.
 *
 * Two wrong ways, both rejected:
 *   * `require.resolve(name + '/package.json')` — fails for any package whose
 *     `exports` map omits the `./package.json` subpath (install-layout does),
 *     which would report a healthy worktree as broken;
 *   * `require.resolve(name)` — follows the entry export, so a not-yet-built
 *     worktree looks like a missing DEPENDENCY when it is really a missing BUILD.
 *
 * Node's own search-path list is used instead, so the lookup order matches Node's
 * (closest node_modules first, hoisting included) and the answer is independent
 * of build state.
 */
export function locateDependencyDir(name, req) {
  let searchPaths = [];
  try {
    searchPaths = req.resolve.paths(name) || [];
  } catch {
    searchPaths = [];
  }
  for (const dir of searchPaths) {
    const candidate = path.join(dir, ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * L1 — dependency readiness for the worktree's OWN workspace resolution.
 * Locates each dependency through Node's resolution paths, then checks
 * containment of the REAL path, so a junction pointing back at the primary is
 * caught even though the file exists.
 */
export function checkL1Dependencies({ worktreeRoot, packages, req = defaultRequire(worktreeRoot) }) {
  const checks = [];
  const leakage = [];
  const nodeModules = path.join(worktreeRoot, 'node_modules');
  checks.push({ name: 'node_modules present', ok: fs.existsSync(nodeModules), detail: nodeModules });

  // A present-but-stale install is the trap that makes `bootstrap ran` look like
  // `the tree is trustworthy` (see detectStaleInstall).
  const install = detectStaleInstall(worktreeRoot);
  checks.push({
    name: 'node_modules matches package-lock.json',
    ok: !install.stale,
    detail: install.stale ? install.reason : 'in sync',
  });

  for (const pkg of packages) {
    const located = locateDependencyDir(pkg.name, req);
    if (located === null) {
      checks.push({ name: 'dependency ' + pkg.name, ok: false, detail: 'not installed — run bootstrap' });
      continue;
    }
    const actualDir = realPathOf(located);
    const expectedDir = realPathOf(pkg.dir);
    const inside = isInside(worktreeRoot, actualDir);
    const matchesWorkspace = actualDir.toLowerCase() === expectedDir.toLowerCase();
    checks.push({
      name: 'dependency ' + pkg.name,
      ok: inside && matchesWorkspace,
      detail: actualDir + (inside ? (matchesWorkspace ? '' : '  (not the workspace copy)') : '  (OUTSIDE worktree)'),
    });
    if (!inside) {
      leakage.push({ package: pkg.name, actual: actualDir, expected: worktreeRoot, expectedPackageDir: expectedDir });
    }
  }
  return { ok: checks.every((c) => c.ok), checks, leakage };
}

/**
 * L2 — did the build authority emit the artifacts it promises?
 * Scoped to the packages the root build actually covers, so a worktree that has
 * run the supported bootstrap is not failed for an artifact the authority never
 * produced (pd-console and pd-companion build outside the root chain).
 */
export function checkL2Build({ worktreeRoot, packages }) {
  const covered = coveredByRootBuild(worktreeRoot);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const results = [];
  if (!covered.parsed) {
    return {
      ok: false,
      parsedAuthority: false,
      results: [],
      reason: 'the root `build` script could not be parsed for --workspace targets',
    };
  }
  for (const name of covered.names) {
    const pkg = byName.get(name);
    if (!pkg) {
      results.push({ name, ok: false, detail: 'workspace not found in packages/*' });
      continue;
    }
    const entry = declaredEntry(pkg);
    if (!entry) {
      results.push({ name, ok: true, detail: 'no declared entry artifact — skipped' });
      continue;
    }
    results.push({
      name,
      ok: fs.existsSync(entry.file),
      detail: entry.spec + ' -> ' + entry.file,
    });
  }
  return { ok: results.every((r) => r.ok), parsedAuthority: true, results, covered: covered.names };
}

/**
 * L3 — real runtime resolution of the specifiers production actually consumes.
 * Every resolved path must stay inside the worktree; escaping is a hard gate.
 */
export function checkL3Runtime({ worktreeRoot, probes, bins }) {
  const req = defaultRequire(worktreeRoot);
  const results = [];
  const leakage = [];

  const record = (label, specifier, resolved) => {
    if (resolved === null) {
      results.push({ label, specifier, resolved: null, ok: false, detail: 'unresolved' });
      return;
    }
    const inside = isInside(worktreeRoot, resolved);
    results.push({ label, specifier, resolved, ok: inside, detail: inside ? '' : 'OUTSIDE worktree' });
    if (!inside) leakage.push({ package: label, actual: resolved, expected: worktreeRoot });
  };

  for (const probe of probes) {
    let resolved = null;
    try {
      resolved = req.resolve(probe.specifier);
    } catch {
      resolved = null;
    }
    record(probe.label, probe.specifier, resolved);
  }

  for (const bin of bins) {
    const exists = fs.existsSync(bin.file);
    results.push({
      label: bin.label,
      specifier: bin.specifier,
      resolved: bin.file,
      ok: exists && isInside(worktreeRoot, bin.file),
      detail: exists ? '' : 'artifact missing — run bootstrap/build',
    });
    if (exists && !isInside(worktreeRoot, bin.file)) {
      leakage.push({ package: bin.label, actual: bin.file, expected: worktreeRoot });
    }
  }

  return { ok: results.every((r) => r.ok), probes: results, leakage };
}

/**
 * A require-like object pinned to the target worktree. `createRequire` anchors
 * resolution to that tree's `package.json`, so the probe is independent of the
 * tool's own cwd or install location — running `dev:worktree:ready` from the
 * primary must still describe the TARGET worktree, not the caller.
 */
function defaultRequire(worktreeRoot) {
  return createRequire(path.join(worktreeRoot, 'package.json'));
}

/**
 * Full readiness report.
 *
 * @returns {{
 *   ok: boolean,
 *   code: string|null,
 *   worktreeRoot: string,
 *   primaryPath: string|null,
 *   levels: {l1: object, l2: object, l3: object},
 *   leakage: Array<object>,
 *   nextAction: string|null
 * }}
 */
export function checkReadiness({ worktreeRoot, primaryPath = null, req } = {}) {
  const root = path.resolve(worktreeRoot);
  const packages = listWorkspacePackages(root);
  const derived = deriveRuntimeProbes(root, packages);
  const requireFor = req || defaultRequire(root);
  const l1 = checkL1Dependencies({ worktreeRoot: root, packages, req: requireFor });
  const l2 = checkL2Build({ worktreeRoot: root, packages });
  const l3 = checkL3Runtime({ worktreeRoot: root, probes: derived.probes, bins: derived.bins });

  const leakage = [...l1.leakage, ...l3.leakage];
  const ok = leakage.length === 0 && l1.ok && l2.ok && l3.ok;

  let code = null;
  let nextAction = null;
  if (leakage.length > 0) {
    code = CODES.NOT_READY;
    nextAction =
      'PRIMARY_LEAKAGE: one or more workspace packages resolve OUTSIDE this worktree. ' +
      'Delete this worktree\'s node_modules and run `npm run dev:worktree:bootstrap` — never share node_modules between worktrees (SPEC D5).';
  } else if (!l1.ok) {
    code = CODES.NOT_READY;
    const installStale = l1.checks.some((c) => c.name === 'node_modules matches package-lock.json' && !c.ok);
    nextAction = installStale
      ? 'Dependencies are installed but STALE relative to package-lock.json: run `npm install` (or npm run dev:worktree:bootstrap). ' +
        'A stale tree fails later as a confusing type/build error instead of here.'
      : 'Dependencies are missing or incomplete: npm run dev:worktree:bootstrap';
  } else if (!l2.ok || !l3.ok) {
    code = CODES.NOT_READY;
    nextAction = 'Build artifacts are missing or stale: npm run dev:worktree:bootstrap (or npm run build)';
  }

  return { ok, code, worktreeRoot: root, primaryPath, leakage, levels: { l1, l2, l3 }, nextAction };
}

/** Human-readable rendering of a readiness report. */
export function renderReadiness(report) {
  const lines = [];
  lines.push('[worktree-ready] ' + (report.ok ? 'READY' : 'NOT_READY') + ' — ' + report.worktreeRoot);
  if (report.code) lines.push('  code: ' + report.code);
  lines.push('');
  lines.push('  L1 dependencies (' + (report.levels.l1.ok ? 'ok' : 'FAIL') + ')');
  for (const c of report.levels.l1.checks) lines.push('    ' + (c.ok ? 'ok  ' : 'FAIL') + '  ' + c.name + (c.detail ? '  — ' + c.detail : ''));
  lines.push('  L2 build (' + (report.levels.l2.ok ? 'ok' : 'FAIL') + ')');
  for (const r of report.levels.l2.results) lines.push('    ' + (r.ok ? 'ok  ' : 'FAIL') + '  ' + r.name + (r.detail ? '  — ' + r.detail : ''));
  lines.push('  L3 runtime resolve (' + (report.levels.l3.ok ? 'ok' : 'FAIL') + ')');
  for (const p of report.levels.l3.probes) {
    lines.push('    ' + (p.ok ? 'ok  ' : 'FAIL') + '  ' + p.specifier + ' -> ' + (p.resolved || '(unresolved)') + (p.detail ? '  ' + p.detail : ''));
  }
  if (report.leakage.length > 0) {
    lines.push('');
    lines.push('  PRIMARY_LEAKAGE (' + report.leakage.length + ')');
    for (const l of report.leakage) {
      lines.push('    package:  ' + l.package);
      lines.push('    actual:   ' + l.actual);
      lines.push('    expected: ' + l.expected);
    }
  }
  if (report.nextAction) {
    lines.push('');
    lines.push('  next: ' + report.nextAction);
  }
  return lines.join('\n');
}
