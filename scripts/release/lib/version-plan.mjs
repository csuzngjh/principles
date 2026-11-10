/**
 * Version-plan engine (SPEC v1.2 §12, §14): changeset parsing, final release
 * plan computation, component mirror sync, and the deterministic
 * reproduction check that defines Version-PR identity.
 *
 * Design rule (SPEC §12.1): a Version PR is identified by PROOF — its diff
 * must be reproducible from the pending changesets at its base through the
 * same materialization pipeline — never by branch name, PR title, or actor.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parseChangeset from '@changesets/parse';
import { RUNTIME_PIN_TARGETS, composePinsFromWorkspace } from '../sync-codex-runtime-pins.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function gitSafe(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/** Repo root that owns THIS module (and its node_modules/@changesets/cli). */
export const HOST_REPO_ROOT = path.resolve(SCRIPTS_DIR, '..', '..', '..');

/**
 * Absolute path to the @changesets/cli entry this repo pins. Resolved from
 * the HOST repo, not from a `cwd` argument: reproduction may run against a
 * fixture tree that has no node_modules of its own.
 */
export function changesetBinPath() {
  return path.join(HOST_REPO_ROOT, 'node_modules', '@changesets', 'cli', 'bin.js');
}

/** Run `changeset version` in the given tree (cwd only; no install). */
export function runChangesetVersion(cwd) {
  const res = spawnSync(process.execPath, [changesetBinPath(), 'version'], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, CI: 'true' },
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/**
 * Parse the pending changesets of a tree. Returns an array of
 * { file, releases: [{name, type}], summary }. Files that fail to parse
 * surface as { file, error } — callers fail loud on them (rc-3).
 */
export function readPendingChangesets(cwd) {
  const dir = path.join(cwd, '.changeset');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.md') || entry === 'README.md' || entry === 'config.json') continue;
    const file = path.join(dir, entry);
    const raw = fs.readFileSync(file, 'utf8');
    try {
      const parsed = parseChangeset(raw);
      out.push({ file: entry, releases: parsed.releases ?? [], summary: parsed.summary ?? '' });
    } catch (err) {
      out.push({ file: entry, error: err?.message ?? String(err) });
    }
  }
  return out;
}

/**
 * Final release plan for a tree (direct changesets + Changesets' internal
 * dependency propagation — SPEC §14.1). Read-only; safe on any checkout.
 */
export async function computeFinalPlan(cwd) {
  const getReleasePlan = (await import('@changesets/get-release-plan')).default;
  const plan = await getReleasePlan(cwd);
  return {
    releases: (plan.releases ?? []).map((r) => ({
      name: r.name,
      type: r.type,
      oldVersion: r.oldVersion,
      newVersion: r.newVersion,
      changesets: r.changesets,
    })),
    changesets: plan.changesets ?? [],
  };
}

/**
 * Approved component mirror (SPEC §15.1): the plugin manifest version
 * mirrors the plugin package version. Explicitly NOT propagated to the root
 * Product Version or any runtime pin (SPEC §15.2).
 */
export function syncPluginVersionMirror(cwd) {
  const pkgPath = path.join(cwd, 'packages', 'openclaw-plugin', 'package.json');
  const mirrorPath = path.join(cwd, 'packages', 'openclaw-plugin', 'openclaw.plugin.json');
  // Direct reads with E-loop recovery instead of existsSync-then-read —
  // the check-then-read window is a TOCTOU the CodeQL gate flags, and a
  // try/catch handles the same absence cases without the race.
  let version;
  let mirror;
  try {
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'));
  } catch {
    return false;
  }
  if (mirror.version === version) return false;
  mirror.version = version;
  fs.writeFileSync(mirrorPath, JSON.stringify(mirror, null, 2) + '\n');
  return true;
}

/**
 * Approved component mirror (SPEC-PD-MCP-GATE4-001 §9.3): the pd-mcp-server
 * `SERVER_VERSION` constant mirrors its package version.
 *
 * changesets rewrites only `package.json`; without this step the constant
 * stays at the previous minor and the G4-6 guard fails on the generated
 * Version Packages PR (CI 2026-11-03: expected '0.1.0' to be '0.2.0').
 */
export function syncMcpServerVersionMirror(cwd) {
  const pkgPath = path.join(cwd, 'packages', 'pd-mcp-server', 'package.json');
  const mirrorPath = path.join(cwd, 'packages', 'pd-mcp-server', 'src', 'version.ts');
  // Direct reads with E-loop recovery instead of existsSync-then-read —
  // same TOCTOU reasoning as syncPluginVersionMirror above.
  let version;
  let source;
  try {
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    source = fs.readFileSync(mirrorPath, 'utf8');
  } catch {
    return false;
  }
  // A present mirror without the declaration is a broken contract, not a
  // no-op: fail loud instead of silently shipping a stale identity (rc-3).
  const declaration = /export const SERVER_VERSION = '[^']*' as const;/;
  if (!declaration.test(source)) {
    throw new Error(`pd-mcp-server/src/version.ts has no SERVER_VERSION declaration: ${mirrorPath}`);
  }
  const next = source.replace(
    /(export const SERVER_VERSION = ')[^']*(' as const;)/,
    `$1${version}$2`,
  );
  if (next === source) return false;
  fs.writeFileSync(mirrorPath, next);
  return true;
}

/**
 * Component mirror declarations — the ONE authority for "which non
 * package.json/CHANGELOG.md files does release materialization rewrite"
 * (SPEC §15.1; SPEC-PD-MCP-GATE4-001 §9.3).
 *
 * The Version-PR allowlist and the reproduction steps are derived from this
 * list, and so is the materialization command. A new mirror therefore cannot
 * be shipped by the bot while being rejected by the guard — the 2026-11-03
 * drift was exactly that: syncMcpServerVersionMirror started rewriting
 * `pd-mcp-server/src/version.ts`, but the allowlist stayed a hand-written
 * list, so the generated Version Packages PR failed as mode=normal.
 */
export const COMPONENT_MIRRORS = [
  { target: 'packages/openclaw-plugin/openclaw.plugin.json', sync: syncPluginVersionMirror },
  { target: 'packages/pd-mcp-server/src/version.ts', sync: syncMcpServerVersionMirror },
];

const MIRROR_TARGETS = new Set(COMPONENT_MIRRORS.map((m) => m.target));
const PIN_TARGETS = new Set(RUNTIME_PIN_TARGETS);

/** Run every declared mirror sync; returns the targets that were rewritten. */
export function syncComponentVersionMirrors(cwd) {
  const synced = [];
  for (const mirror of COMPONENT_MIRRORS) {
    if (mirror.sync(cwd)) synced.push(mirror.target);
  }
  return synced;
}

/**
 * Everything the Version PR materializes beyond `changeset version` and the
 * lockfile: declared component mirrors plus the Codex runtime pin (pin file +
 * the plugin cache version that must move with it). The bot and reproduction
 * call THIS function, so the Version-PR allowlist and the byte-for-byte
 * reproduction can never disagree about what the pin should be.
 */
export function materializeDerivedFiles(cwd) {
  return { mirrors: syncComponentVersionMirrors(cwd), pin: composePinsFromWorkspace(cwd) };
}

function extractArchive(repoRoot, sha, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Feed git archive straight into tar's stdin (cwd-relative, no absolute
  // paths — an absolute Windows path (C:\...) makes MSYS tar treat it as a
  // remote host spec) — no intermediate file, so there is no write/read
  // window to race on (CodeQL TOCTOU).
  // -c core.autocrlf=false pins the archive to the stored (LF) blobs: on a
  // Windows dev machine with autocrlf=true, git archive would otherwise
  // export CRLF and break byte-comparison with the materialization output.
  const buf = execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', 'archive', '--format=tar', sha],
    { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024 },
  );
  execFileSync('tar', ['-x'], { cwd: dest, input: buf, maxBuffer: 512 * 1024 * 1024 });
}

function showFile(repoRoot, sha, relPath) {
  try {
    return git(repoRoot, ['show', `${sha}:${relPath}`]);
  } catch {
    return null;
  }
}

function diffNameOnly(repoRoot, baseSha, headSha) {
  return git(repoRoot, ['diff', '--name-only', `${baseSha}..${headSha}`])
    .split('\n')
    .filter(Boolean);
}

function normalizeChangelogText(text) {
  // Reproduction may run on a later day, and from a git-archive tree that
  // has no .git — so entry commit hashes and dates are the only legitimate
  // variance; everything else must match (SPEC §12.3: core governance
  // files must match). Line endings normalize away any host eol config.
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]*/g, '<DATE>')
    .replace(/^- ([0-9a-f]{7,40}): /gm, '- ')
    .replace(/ \[([0-9a-f]{7,40})\]/gm, '');
}

/**
 * Files a Version PR may touch (SPEC §12.2). Mirror targets come from the
 * COMPONENT_MIRRORS declarations above, and the Codex pin from its single
 * owner module — never a second hand-written list.
 */
export function isAllowedVersionPrPath(relPath) {
  if (relPath === 'package-lock.json') return true;
  if (relPath.startsWith('.changeset/')) return true;
  if (MIRROR_TARGETS.has(relPath) || PIN_TARGETS.has(relPath)) return true;
  const m = /^packages\/([^/]+)\/(.+)$/.exec(relPath);
  if (!m) return false;
  return m[2] === 'package.json' || m[2] === 'CHANGELOG.md';
}

function internalRangeSnapshot(manifest) {
  const deps = manifest.dependencies ?? {};
  return Object.fromEntries(
    Object.entries(deps).filter(([k]) => k.startsWith('@principles/') || k === 'principles-disciple'),
  );
}
export { internalRangeSnapshot };

/**
 * Structural lockfile check (SPEC §12.3): the head lockfile's workspace
 * pins must equal the head manifests, and the root pin (Product Version)
 * must equal the base root pin. Avoids regenerating the lockfile during
 * validation (no install, no network in the guard).
 */
export function checkLockfileStructure(cwd, { rootVersionAtBase }) {
  const lockPath = path.join(cwd, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return { ok: false, reason: 'package-lock.json missing' };
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.packages?.['']?.version !== rootVersionAtBase) {
    return {
      ok: false,
      reason: `lockfile root pin ${lock.packages?.['']?.version} != base Product Version ${rootVersionAtBase}`,
    };
  }
  for (const dir of fs.readdirSync(path.join(cwd, 'packages'))) {
    const manifestPath = path.join(cwd, 'packages', dir, 'package.json');
    const pin = lock.packages?.[`packages/${dir}`];
    if (!manifestPath || !pin) continue;
    const version = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
    if (pin.version !== version) {
      return { ok: false, reason: `lockfile pin for packages/${dir} (${pin.version}) != manifest (${version})` };
    }
  }
  return { ok: true };
}

/**
 * Attempt to reproduce a diff as a Version Packages materialization
 * (SPEC §12.1/§12.3).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.baseSha  tree whose pending changesets feed the plan
 * @param {string} args.headSha  tree the diff points at
 * @returns {Promise<{reproducible:boolean, identity:'version-pr'|'normal'|'empty', reasons:string[], releases:Array}>}
 */
export async function reproduceVersionMaterialization({ repoRoot, baseSha, headSha }) {
  const reasons = [];
  const changed = diffNameOnly(repoRoot, baseSha, headSha);
  if (changed.length === 0) {
    return { reproducible: false, identity: 'empty', reasons: ['no diff'], releases: [] };
  }

  // Any file outside the allowed set disqualifies Version-PR identity —
  // this is simultaneously the containment check for Product Version,
  // runtime pins, installer logic and unrelated files (SPEC §12.2).
  const disallowed = changed.filter((f) => !isAllowedVersionPrPath(f));
  if (disallowed.length > 0) {
    reasons.push(`diff touches files outside the Version PR allowlist: ${disallowed.slice(0, 10).join(', ')}`);
    return { reproducible: false, identity: 'normal', reasons, releases: [] };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-version-repro-'));
  try {
    extractArchive(repoRoot, baseSha, tmp);

    const pending = readPendingChangesets(tmp);
    if (pending.length === 0) {
      return { reproducible: false, identity: 'normal', reasons: ['no pending changesets at base'], releases: [] };
    }

    // The same materialization the bot runs (SPEC §12.3): changeset version
    // then EVERY declared component mirror sync plus the Codex runtime pin —
    // one declaration, so a new mirror or pin cannot be missed here either.
    // Lockfile materialization is validated structurally instead of
    // regenerated (no network in guards).
    const versionRun = runChangesetVersion(tmp);
    if (versionRun.status !== 0) {
      reasons.push(`changeset version failed in reproduction: ${versionRun.stderr.slice(0, 300)}`);
      return { reproducible: false, identity: 'normal', reasons, releases: [] };
    }
    materializeDerivedFiles(tmp);

    // 1) changed file set equality with what materialization produced
    for (const rel of changed) {
      const headContent = showFile(repoRoot, headSha, rel);
      const tmpPath = path.join(tmp, rel);
      const tmpExists = fs.existsSync(tmpPath);
      const headExists = headContent !== null;

      if (rel.startsWith('.changeset/')) {
        // Consumed changesets must be gone at head; unconsumed ones kept.
        if (headExists === tmpExists) continue;
        reasons.push(`changeset file ${rel} presence at head (${headExists}) != materialization (${tmpExists})`);
        return { reproducible: false, identity: 'normal', reasons, releases: [] };
      }

      if (!tmpExists && !headExists) continue;
      if (!tmpExists || !headExists) {
        reasons.push(`file ${rel} exists on one side only (head=${headExists}, materialization=${tmpExists})`);
        return { reproducible: false, identity: 'normal', reasons, releases: [] };
      }

      // Line endings normalize away any host eol config (Windows autocrlf).
      let tmpContent = fs.readFileSync(tmpPath, 'utf8').replace(/\r\n/g, '\n');
      let headText = headContent.replace(/\r\n/g, '\n');
      if (rel === 'package-lock.json') {
        // The reproduction does not re-run lockfile materialization
        // (no network in guards, SPEC §12.3) — the lockfile is validated
        // STRUCTURALLY below: workspace pins must match the head manifests
        // and the root Product Version pin must be unchanged.
        continue;
      }
      if (rel.endsWith('CHANGELOG.md')) {
        tmpContent = normalizeChangelogText(tmpContent);
        headText = normalizeChangelogText(headText);
      }
      if (tmpContent !== headText) {
        reasons.push(`file ${rel} differs from deterministic materialization`);
        return { reproducible: false, identity: 'normal', reasons, releases: [] };
      }
    }

    // 2) no leftover drift inside the allowed set: every file materialization
    //    changed relative to base must appear in the PR diff
    const baseFiles = new Set(
      git(repoRoot, ['ls-tree', '-r', '--name-only', baseSha]).split('\n').filter(Boolean),
    );
    for (const rel of walkTree(tmp)) {
      const relNorm = rel.split(path.sep).join('/');
      if (!isAllowedVersionPrPath(relNorm) && relNorm !== '.changeset/config.json') continue;
      const baseContent = baseFiles.has(relNorm) ? showFile(repoRoot, baseSha, relNorm) : null;
      const tmpContent = fs.readFileSync(path.join(tmp, rel), 'utf8');
      const changedByMaterialization = baseContent !== tmpContent;
      if (changedByMaterialization && !changed.includes(relNorm)) {
        reasons.push(`materialization changed ${relNorm} but the PR diff does not include it`);
        return { reproducible: false, identity: 'normal', reasons, releases: [] };
      }
    }

    // 3) structural lockfile containment at head: Product Version unchanged
    const baseRootPkg = JSON.parse(showFile(repoRoot, baseSha, 'package.json'));
    const headRootPkg = JSON.parse(showFile(repoRoot, headSha, 'package.json'));
    if (baseRootPkg.version !== headRootPkg.version) {
      reasons.push(`root Product Version changed (${baseRootPkg.version} -> ${headRootPkg.version})`);
      return { reproducible: false, identity: 'normal', reasons, releases: [] };
    }
    if (changed.includes('package-lock.json')) {
      // Lockfile check runs against the head tree, not the temp tree.
      const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-version-head-'));
      try {
        extractArchive(repoRoot, headSha, tmpHead);
        const lockCheck = checkLockfileStructure(tmpHead, { rootVersionAtBase: baseRootPkg.version });
        if (!lockCheck.ok) {
          reasons.push(`lockfile structure invalid: ${lockCheck.reason}`);
          return { reproducible: false, identity: 'normal', reasons, releases: [] };
        }
      } finally {
        fs.rmSync(tmpHead, { recursive: true, force: true });
      }
    }

    const releases = [];
    for (const pkgDir of fs.readdirSync(path.join(tmp, 'packages'))) {
      const pkgPath = path.join(tmp, 'packages', pkgDir, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const now = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const before = JSON.parse(showFile(repoRoot, baseSha, `packages/${pkgDir}/package.json`) ?? '{}');
      if (now.version !== before?.version) {
        releases.push({ name: now.name, oldVersion: before?.version, newVersion: now.version });
      }
    }
    if (releases.length === 0) {
      reasons.push('pending changesets existed but no package version changed');
      return { reproducible: false, identity: 'normal', reasons, releases: [] };
    }
    return { reproducible: true, identity: 'version-pr', reasons: [], releases };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function* walkTree(root) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) stack.push(rel ? `${rel}/${entry}` : entry);
    } else {
      yield rel;
    }
  }
}
