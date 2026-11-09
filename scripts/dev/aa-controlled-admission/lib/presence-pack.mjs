// PRI-1152 Path A isolated-host run — execution pack: staging, freezing and
// offline verification. Nothing in this module starts a host, loads the
// plugin through the host, or sends a request to any model endpoint.
//
// Pack layout (one directory, all writable run state inside it):
//   manifest.json                     frozen execution manifest (approval object = its sha256)
//   approval.template.json            binds an approval to cardVersion + manifest sha256
//   host-files.json candidate-files.json  per-file sha256 of the staged trees
//   host/node_modules/openclaw/...    byte-verified copy of the official host package
//   candidate/principles-disciple/... candidate plugin payload + its one external (better-sqlite3)
//   config/openclaw.json              frozen host config (plugins.load.paths -> candidate)
//   workspace/                        PD workspace and agent cwd (.pd/config.yaml, .pd/state.db,
//                                     .openclaw/settings.json)
//   home/ tmp/ state/R1 state/R2      redirected profile, temp and per-round host state
//   inputs/R1.txt inputs/R2.txt       frozen user inputs (A1 golden sample + round marker)
//   preflight/                        offline verification output (never run evidence)
//   run/                              created only by an approved --execute

import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import {
  cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';
import { loadPdConfigForPlugin } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime';
import { buildAllowlistedHostEnv, isInsideRoot, isSamePath } from './env-isolation.mjs';
import { hostIdentity, resolveHostProfile } from './host-profile.mjs';
import { PLUGIN_ID } from './host-config.mjs';
import {
  PRESENCE_AGENT_SETTINGS, PRESENCE_MODEL_ID, PRESENCE_PD_FEATURE_EXPECTATIONS, PRESENCE_ROUND_BUDGETS, PRESENCE_ROUNDS,
  PRESENCE_RUN_BUDGET, buildPresenceHostConfig, buildPresencePdConfigText, generateFakeApiKey, roundModelRef, sha256Text,
  validatePresenceHostConfig,
} from './presence-config.mjs';
import { PRESENCE_FIXTURE, inspectPresenceFixture, seedPresenceFixture, sha256Utf8 } from './presence-fixture.mjs';
import { PRESENCE_ANSWER } from './presence-endpoint.mjs';

export const PACK_SCHEMA = 'pd-presence-exec-pack/v2';
export const CARD_VERSION = 'pri1152-run-card-v3.1';
export const PRESENCE_EVENT_TYPE = 'runtime_v2_prompt_presence_observed';
export const HOST_AGENT_TIMEOUT_SECONDS = 120;
export const ROUND_OUTER_TIMEOUT_MS = 180_000;
const A1_SAMPLE_ID = 'A1';
const MAX_HASHED_TARGET_BYTES = 256 * 1024 * 1024;
const MAX_MARKER_SCAN_BYTES = 16 * 1024 * 1024;
const CONSUMED_LIFECYCLE_MARKERS = new Set(['.openclaw-lifecycle-pending']);

const TOOL_DIR = 'scripts/dev/aa-controlled-admission';

/**
 * The local scripts that take part in a presence run: the launcher and its
 * relative-import closure, as paths from the repository root. A fixed list, not
 * a dependency scanner; a test walks the real import graph so it cannot drift.
 */
export const EXECUTION_SCRIPT_FILES = Object.freeze([
  'presence-run.mjs',
  'lib/env-isolation.mjs',
  'lib/host-config.mjs',
  'lib/host-profile.mjs',
  'lib/ledger.mjs',
  'lib/presence-config.mjs',
  'lib/presence-endpoint.mjs',
  'lib/presence-fixture.mjs',
  'lib/presence-pack.mjs',
  'lib/protocol-selftest.mjs',
  'lib/workspace-seed.mjs',
].map((rel) => `${TOOL_DIR}/${rel}`));

/** Built workspace packages the launcher loads, each frozen as one dist tree (executable .js only). */
export const EXECUTION_WORKSPACE_BUILDS = Object.freeze([
  Object.freeze({ specifier: '@principles/core/runtime', dist: 'packages/principles-core/dist' }),
  Object.freeze({ specifier: '@principles/host-runtime', dist: 'packages/host-runtime/dist' }),
  Object.freeze({ specifier: '@principles/install-layout', dist: 'packages/install-layout/dist' }),
]);

/** The checkout this module runs from: the code that is actually loaded, whatever --repo says. */
export const PRESENCE_CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const EXECUTION_CODE_TRUST_BOUNDARY = 'Drift check, not tamper-proofing: the launcher verifies itself, so this detects edits, rebuilds and branch switches made after prepare. It does not defend against a maliciously replaced verifier or node binary, or against changes made after the check. Third-party node_modules are outside the list.';

/**
 * Every check a pack needs before it may be called READY. A check that was not
 * produced counts as NOT_RUN, so omitting one can never make a pack READY.
 */
export const PREFLIGHT_REQUIRED_CHECKS = Object.freeze([
  'manifest', 'node-identity', 'host-identity', 'host-tree', 'host-registry-tarball', 'candidate-payload', 'presence-durability',
  'presence-surface', 'execution-code', 'budget-consistency', 'host-config', 'pd-config-and-retry', 'fixture-assembly', 'round-inputs',
  'environment-isolation', 'production-plugin-exclusion', 'pollution-baseline',
  'endpoint-port', 'termination-tool', 'process-sweep', 'protocol-selftest',
]);

export const PRESENCE_SURFACE_ID = 'hook:llm_input_presence';

export function sha256Buffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256FileSync(path) {
  return sha256Buffer(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function toPosix(rel) {
  return rel.split(sep).join('/');
}

/** Every regular file below `root` (posix relative paths); links are reported, never followed. */
export function listTree(root) {
  const files = [];
  const links = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) links.push(toPosix(childRel));
      else if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) files.push(toPosix(childRel));
      else links.push(toPosix(childRel));
    }
  }
  files.sort();
  links.sort();
  return { files, links };
}

/** Per-file sha256 plus one aggregate over the sorted `path\tsize\tsha256` lines. */
export function hashTree(root, { include = () => true } = {}) {
  const { files, links } = listTree(root);
  const entries = [];
  let totalBytes = 0;
  const aggregate = createHash('sha256');
  for (const rel of files.filter(include)) {
    const bytes = readFileSync(join(root, rel));
    const sha256 = sha256Buffer(bytes);
    entries.push({ path: rel, size: bytes.length, sha256 });
    totalBytes += bytes.length;
    aggregate.update(`${rel}\t${bytes.length}\t${sha256}\n`);
  }
  return { fileCount: entries.length, totalBytes, treeSha256: aggregate.digest('hex'), links, entries };
}

function copyTreeVerified(source, dest) {
  if (existsSync(dest)) throw new Error(`staging target already exists: ${dest}`);
  const sourceTree = hashTree(source);
  if (sourceTree.links.length > 0) throw new Error(`source contains links or special files (first: ${sourceTree.links[0]})`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true, errorOnExist: true, force: false, dereference: false, preserveTimestamps: true });
  const destTree = hashTree(dest);
  if (destTree.treeSha256 !== sourceTree.treeSha256 || destTree.links.length > 0) {
    throw new Error(`staged copy differs from its source: ${dest}`);
  }
  return destTree;
}

/** Locate a registry tarball in the npm cache through its own index and verify its SRI. */
export function findNpmCacheTarball({ cacheDir, name, version }) {
  const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  const key = `make-fetch-happen:request-cache:${url}`;
  const keyHash = sha256Text(key);
  const bucket = join(cacheDir, '_cacache', 'index-v5', keyHash.slice(0, 2), keyHash.slice(2, 4), keyHash.slice(4));
  if (!existsSync(bucket)) return { ok: false, reason: 'npm_cache_index_entry_missing', url, key };
  let integrity = null;
  for (const line of readFileSync(bucket, 'utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    try {
      const entry = JSON.parse(line.slice(tab + 1));
      if (entry?.key === key && typeof entry.integrity === 'string') integrity = entry.integrity;
    } catch { /* skip a torn index line */ }
  }
  if (!integrity || !integrity.startsWith('sha512-')) return { ok: false, reason: 'npm_cache_integrity_missing', url, key };
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  const contentPath = join(cacheDir, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  if (!existsSync(contentPath)) return { ok: false, reason: 'npm_cache_content_missing', url, integrity };
  const actual = createHash('sha512').update(readFileSync(contentPath)).digest('base64');
  return {
    ok: `sha512-${actual}` === integrity,
    reason: `sha512-${actual}` === integrity ? null : 'npm_cache_content_integrity_mismatch',
    url,
    integrity,
    contentPath,
    sizeBytes: statSync(contentPath).size,
  };
}

class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; }
  push(chunk) { if (chunk.length > 0) { this.chunks.push(chunk); this.length += chunk.length; } }
  read(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    return out;
  }
  readUpTo(n) { return this.read(Math.min(n, this.length)); }
}

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

/**
 * Stream the registry tarball and compare every packaged file with the staged
 * package directory. Files under node_modules/ come from dependency installs
 * and are outside the tarball by construction; any OTHER staged file the
 * tarball does not contain is reported as an extra.
 */
export async function verifyPackageAgainstTarball({ tarballPath, packageDir }) {
  const queue = new ByteQueue();
  const tarFiles = new Set();
  const mismatched = [];
  const missing = [];
  let checked = 0;
  let state = 'header';
  let current = null;
  let paxPath = null;
  let longName = null;
  let zeroBlocks = 0;
  let done = false;

  const finalize = (entry) => {
    if (entry.kind === 'pax') {
      const text = Buffer.concat(entry.chunks).toString('utf8');
      for (const record of text.split('\n')) {
        const space = record.indexOf(' ');
        const body = space === -1 ? '' : record.slice(space + 1);
        if (body.startsWith('path=')) paxPath = body.slice('path='.length);
      }
    } else if (entry.kind === 'longname') {
      longName = Buffer.concat(entry.chunks).toString('utf8').split('\0')[0];
    } else if (entry.kind === 'file') {
      const parts = entry.path.split('/');
      const rel = parts.slice(1).join('/');
      if (!rel) return;
      tarFiles.add(rel);
      checked += 1;
      const staged = join(packageDir, ...rel.split('/'));
      if (!existsSync(staged)) missing.push(rel);
      else if (sha256FileSync(staged) !== entry.hash.digest('hex')) mismatched.push(rel);
    }
  };

  const stream = createReadStream(tarballPath).pipe(createGunzip());
  for await (const chunk of stream) {
    if (done) continue;
    queue.push(chunk);
    for (;;) {
      if (state === 'header') {
        if (queue.length < 512) break;
        const block = queue.read(512);
        if (block.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks >= 2) { done = true; break; }
          continue;
        }
        zeroBlocks = 0;
        const name = tarString(block, 0, 100);
        const size = Number.parseInt(tarString(block, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(block[156]);
        const ustar = tarString(block, 257, 6).startsWith('ustar');
        const prefix = ustar ? tarString(block, 345, 155) : '';
        const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
        const pad = (512 - (size % 512)) % 512;
        if (type === 'x' || type === 'g') {
          current = { kind: type === 'x' ? 'pax' : 'skip', remaining: size, pad, chunks: [] };
        } else if (type === 'L') {
          current = { kind: 'longname', remaining: size, pad, chunks: [] };
        } else {
          current = (type === '0' || type === '\0' || type === '7')
            ? { kind: 'file', path, remaining: size, pad, hash: createHash('sha256') }
            : { kind: 'skip', remaining: size, pad };
          paxPath = null;
          longName = null;
        }
        state = 'data';
      }
      if (state === 'data') {
        if (current.remaining > 0) {
          if (queue.length === 0) break;
          const piece = queue.readUpTo(current.remaining);
          current.remaining -= piece.length;
          if (current.kind === 'file') current.hash.update(piece);
          else if (current.chunks) current.chunks.push(piece);
          continue;
        }
        state = 'pad';
      }
      if (state === 'pad') {
        if (queue.length < current.pad) break;
        if (current.pad > 0) queue.read(current.pad);
        finalize(current);
        current = null;
        state = 'header';
      }
    }
  }

  const extras = listTree(packageDir).files.filter((rel) => !rel.startsWith('node_modules/') && !tarFiles.has(rel));
  // The published tarball ships `.openclaw-lifecycle-pending`; the official
  // lifecycle completion removes it once postinstall has run. Its absence is
  // the completed-install state (its presence would make the host run
  // postinstall into its own package at the next start), so it is the only
  // packaged file allowed to be missing.
  const consumedLifecycleMarkers = missing.filter((rel) => CONSUMED_LIFECYCLE_MARKERS.has(rel));
  const unexplainedMissing = missing.filter((rel) => !CONSUMED_LIFECYCLE_MARKERS.has(rel));
  return {
    ok: checked > 0 && mismatched.length === 0 && unexplainedMissing.length === 0 && extras.length === 0,
    tarballPath,
    checkedFiles: checked,
    mismatched: mismatched.slice(0, 50),
    mismatchedCount: mismatched.length,
    missing: unexplainedMissing.slice(0, 50),
    missingCount: unexplainedMissing.length,
    consumedLifecycleMarkers,
    extraFilesOutsideNodeModules: extras.slice(0, 50),
    extraCount: extras.length,
  };
}


function repoFile(codeRoot, rel) {
  return join(codeRoot, ...rel.split('/'));
}

/**
 * The code a run would execute, as recorded in the manifest: repository-relative
 * paths with sha256 values. Pack files and the manifest are not part of it, so
 * the manifest hash has no dependency on itself.
 */
export function collectExecutionCode(codeRoot = PRESENCE_CODE_ROOT) {
  return {
    scripts: EXECUTION_SCRIPT_FILES.map((path) => ({ path, sha256: sha256FileSync(repoFile(codeRoot, path)) })),
    workspaceBuilds: EXECUTION_WORKSPACE_BUILDS.map(({ specifier, dist }) => {
      const tree = hashTree(repoFile(codeRoot, dist), { include: (rel) => rel.endsWith('.js') });
      return { specifier, path: dist, fileCount: tree.fileCount, treeSha256: tree.treeSha256 };
    }),
  };
}

/** Compare the frozen list with the code on disk now; an empty result means no drift was found. */
export function executionCodeViolations(frozen, codeRoot = PRESENCE_CODE_ROOT) {
  if (!Array.isArray(frozen?.scripts) || !Array.isArray(frozen?.workspaceBuilds)) {
    return ['manifest carries no execution-code binding; this pack predates the check and must be prepared again'];
  }
  let live;
  try {
    live = collectExecutionCode(codeRoot);
  } catch (error) {
    return [`the code that would run cannot be hashed: ${String(error?.message ?? error)}`];
  }
  const violations = [];
  const compare = (kind, frozenRows, liveRows, field) => {
    const frozenByPath = new Map(frozenRows.map((row) => [row.path, row[field]]));
    const liveByPath = new Map(liveRows.map((row) => [row.path, row[field]]));
    for (const [path, value] of liveByPath) {
      if (frozenByPath.get(path) !== value) violations.push(`${kind} ${path} differs from the frozen hash`);
    }
    for (const path of frozenByPath.keys()) {
      if (!liveByPath.has(path)) violations.push(`${kind} ${path} is frozen but no longer in the execution list`);
    }
  };
  compare('script', frozen.scripts, live.scripts, 'sha256');
  compare('workspace build', frozen.workspaceBuilds, live.workspaceBuilds, 'treeSha256');
  // What this process really imports must be the checkout that was just hashed.
  const resolveFromLauncher = createRequire(repoFile(PRESENCE_CODE_ROOT, `${TOOL_DIR}/lib/presence-pack.mjs`)).resolve;
  for (const { specifier, dist } of EXECUTION_WORKSPACE_BUILDS) {
    let resolved = null;
    try { resolved = resolveFromLauncher(specifier); } catch { /* reported below */ }
    if (resolved === null || !isInsideRoot(repoFile(PRESENCE_CODE_ROOT, dist), resolved)) {
      violations.push(`${specifier} resolves to ${resolved ?? 'nothing'}, outside the hashed build ${dist}`);
    }
  }
  return violations;
}

function budgetConsistencyViolations(manifest) {
  const violations = [];
  if (!isDeepStrictEqual(manifest.budget?.run, PRESENCE_RUN_BUDGET)) violations.push('the frozen run budget differs from the launcher run budget');
  if (!isDeepStrictEqual(manifest.budget?.rounds, PRESENCE_ROUND_BUDGETS)) violations.push('the frozen per-round budgets differ from the launcher per-round budgets');
  for (const round of manifest.rounds) {
    if (!isDeepStrictEqual(round.budget, manifest.budget?.rounds?.[round.id])) violations.push(`${round.id}: the round budget differs from budget.rounds inside the manifest`);
  }
  return violations;
}

function bundledPluginIds(hostPackageDir) {
  const root = join(hostPackageDir, 'dist', 'extensions');
  if (!existsSync(root)) return [];
  const ids = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, 'openclaw.plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const id = readJson(manifestPath)?.id;
      if (typeof id === 'string') ids.push(id);
    } catch { ids.push(`unreadable:${entry.name}`); }
  }
  return ids.sort();
}

function hostSourceFacts(packageDir, { expectedVersion, expectedCommit }) {
  const pkg = readJson(join(packageDir, 'package.json'));
  const buildInfoPath = join(packageDir, 'dist', 'build-info.json');
  const buildInfo = existsSync(buildInfoPath) ? readJson(buildInfoPath) : null;
  const lifecycleMarkers = [join(packageDir, '.openclaw-lifecycle-pending'), join(packageDir, 'dist', 'openclaw-install-guard')]
    .filter((path) => existsSync(path));
  const violations = [];
  if (pkg?.name !== 'openclaw') violations.push(`package name is ${pkg?.name}`);
  if (pkg?.version !== expectedVersion) violations.push(`host version ${pkg?.version} is not ${expectedVersion}`);
  if (buildInfo?.commit !== expectedCommit) violations.push(`build-info commit ${buildInfo?.commit ?? 'missing'} is not ${expectedCommit}`);
  if (lifecycleMarkers.length > 0) violations.push(`lifecycle markers present: ${lifecycleMarkers.join(', ')}`);
  return { version: pkg?.version ?? null, buildInfo, lifecycleMarkers, violations };
}

export async function stageHost({ hostSource, packRoot, expectedVersion, expectedCommit, npmCacheDir }) {
  const source = resolve(hostSource);
  const sourceFacts = hostSourceFacts(source, { expectedVersion, expectedCommit });
  if (sourceFacts.violations.length > 0) throw new Error(`host source refused: ${sourceFacts.violations.join('; ')}`);
  const hostRoot = join(packRoot, 'host');
  const packageDir = join(hostRoot, 'node_modules', 'openclaw');
  const tree = copyTreeVerified(source, packageDir);
  writeJson(join(packRoot, 'host-files.json'), { schemaVersion: 'pd-presence-tree/v1', root: packageDir, ...tree });
  const profile = resolveHostProfile({ hostRoot, expectedVersion });
  if (!profile.ok || !profile.healthy) throw new Error(`staged host is not usable: ${profile.reason ?? 'unhealthy'}`);
  const tarball = npmCacheDir
    ? findNpmCacheTarball({ cacheDir: npmCacheDir, name: 'openclaw', version: expectedVersion })
    : { ok: false, reason: 'npm_cache_dir_not_supplied' };
  const tarballCheck = tarball.ok
    ? await verifyPackageAgainstTarball({ tarballPath: tarball.contentPath, packageDir })
    : { ok: false, status: 'NOT_RUN', reason: tarball.reason };
  return {
    source,
    hostRoot,
    packageDir,
    version: sourceFacts.version,
    buildInfo: sourceFacts.buildInfo,
    identity: hostIdentity(profile),
    fsSafePath: profile.fsSafePath,
    tree: { fileCount: tree.fileCount, totalBytes: tree.totalBytes, treeSha256: tree.treeSha256, filesManifest: join(packRoot, 'host-files.json') },
    registryTarball: tarball,
    tarballVerification: tarballCheck,
    bundledPluginIds: bundledPluginIds(packageDir),
  };
}

const CANDIDATE_PAYLOAD = ['package.json', 'openclaw.plugin.json', 'dist', 'templates', 'mcp', 'assets'];

const PACKAGE_SPECIFIER = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.@-]+)*$/i;

/**
 * Bare specifiers a bundle can load at runtime, located the way Node would
 * (nearest node_modules walking up from the bundle). Scans statement-level
 * `import ... from`, dynamic `import()` and `require()` on non-comment lines;
 * doc-comment examples inside vendored code are not imports.
 */
export function auditBundleExternals({ bundlePath, packRoot }) {
  const text = readFileSync(bundlePath, 'utf8');
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const specifiers = new Set();
  const patterns = [
    /^import\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g,
    /(?<![\w$.])import\(\s*["']([^"']+)["']\s*\)/g,
    /(?<![\w$.])(?:__)?require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const spec = match[1];
        if (!PACKAGE_SPECIFIER.test(spec) || spec.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0])) continue;
        specifiers.add(spec);
      }
    }
  }
  const rows = [];
  for (const spec of [...specifiers].sort()) {
    const parts = spec.split('/');
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    let resolvedTo = null;
    let dir = dirname(bundlePath);
    for (;;) {
      const candidate = join(dir, 'node_modules', ...pkgName.split('/'), 'package.json');
      if (existsSync(candidate)) { resolvedTo = dirname(candidate); break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    rows.push({
      specifier: spec,
      package: pkgName,
      resolvedTo,
      // `absent` is not a leak: nothing outside the pack can satisfy it (the
      // ws accelerators bufferutil/utf-8-validate are try/catch optional).
      status: resolvedTo === null ? 'absent' : isInsideRoot(packRoot, resolvedTo) ? 'inside-pack' : 'outside-pack',
    });
  }
  return {
    bundlePath,
    specifiers: rows,
    absent: rows.filter((row) => row.status === 'absent').map((row) => row.specifier),
    ok: rows.every((row) => row.status !== 'outside-pack') && rows.some((row) => row.package === 'better-sqlite3' && row.status === 'inside-pack'),
  };
}

/**
 * The entry the host will import. OpenClaw resolves a config-path plugin's
 * runtime entry from the package's `openclaw.extensions` relative to the
 * candidate root, so the staged package.json must declare exactly the frozen
 * entry and that entry must be the frozen bundle inside the candidate root.
 */
export function candidateEntryViolations({ candidateRoot, bundlePath, frozenExtensions }) {
  let pkg;
  try {
    pkg = readJson(join(candidateRoot, 'package.json'));
  } catch (error) {
    return [`candidate package.json unreadable: ${String(error?.message ?? error)}`];
  }
  const extensions = pkg?.openclaw?.extensions;
  if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== 'string') {
    return ['candidate package.json openclaw.extensions must declare exactly one entry'];
  }
  const violations = [];
  if (!isDeepStrictEqual(extensions, frozenExtensions)) violations.push('candidate entry differs from the frozen openclaw.extensions');
  const entryPath = resolve(candidateRoot, extensions[0]);
  if (!isInsideRoot(candidateRoot, entryPath)) violations.push(`candidate entry ${extensions[0]} resolves outside the candidate root`);
  else if (!isSamePath(entryPath, bundlePath)) violations.push(`candidate entry ${extensions[0]} is not the frozen bundle`);
  return violations;
}

const isCandidateCodeFile = (rel) => rel === 'package.json' || rel === 'openclaw.plugin.json' || /\.(?:c|m)?js$/.test(rel) || rel.endsWith('.node');

/**
 * After a round: are the candidate's code files (entry, bundle, manifests, the
 * external dependency) still the frozen bytes? Data files the plugin may write
 * into its own root at runtime (e.g. mcp-binding.json) are reported, not
 * judged. The frozen per-file list is first proven against the manifest hash.
 */
export function candidateCodeDrift(manifest) {
  let frozen;
  try {
    frozen = readJson(manifest.candidate.tree.filesManifest);
  } catch (error) {
    return { ok: false, reason: `frozen candidate file list unreadable: ${String(error?.message ?? error)}` };
  }
  const entries = Array.isArray(frozen?.entries) ? frozen.entries : [];
  const aggregate = createHash('sha256');
  for (const entry of entries) aggregate.update(`${entry.path}\t${entry.size}\t${entry.sha256}\n`);
  if (entries.length === 0 || aggregate.digest('hex') !== manifest.candidate.tree.treeSha256) {
    return { ok: false, reason: 'the frozen candidate file list does not reproduce the manifest tree hash' };
  }
  const live = hashTree(manifest.candidate.root, { include: isCandidateCodeFile });
  const frozenCode = new Map(entries.filter((entry) => isCandidateCodeFile(entry.path)).map((entry) => [entry.path, entry.sha256]));
  const liveCode = new Map(live.entries.map((entry) => [entry.path, entry.sha256]));
  const changed = [...frozenCode].filter(([path, sha256]) => liveCode.has(path) && liveCode.get(path) !== sha256).map(([path]) => path);
  const missing = [...frozenCode.keys()].filter((path) => !liveCode.has(path));
  const added = [...liveCode.keys()].filter((path) => !frozenCode.has(path));
  return {
    ok: changed.length === 0 && missing.length === 0 && added.length === 0 && live.links.length === 0,
    codeFiles: liveCode.size,
    changed: changed.slice(0, 20),
    missing: missing.slice(0, 20),
    added: added.slice(0, 20),
    links: live.links.slice(0, 20),
    mcpBindingPresent: existsSync(join(manifest.candidate.root, 'mcp-binding.json')),
  };
}

export function stageCandidate({ pluginSource, packRoot }) {
  const source = resolve(pluginSource);
  const dest = join(packRoot, 'candidate', 'principles-disciple');
  for (const required of ['package.json', 'openclaw.plugin.json', join('dist', 'bundle.js')]) {
    if (!existsSync(join(source, required))) throw new Error(`candidate source is missing ${required} (build the plugin bundle first)`);
  }
  mkdirSync(dest, { recursive: true });
  const staged = [];
  for (const item of CANDIDATE_PAYLOAD) {
    const from = join(source, item);
    if (!existsSync(from)) continue;
    cpSync(from, join(dest, item), { recursive: true, errorOnExist: true, force: false, dereference: false, preserveTimestamps: true });
    staged.push(item);
  }
  // The bundle keeps exactly one runtime dependency external; stage it beside
  // the payload so Node resolves it inside the pack, never from the repo.
  const sqliteDir = dirname(createRequire(join(source, 'package.json')).resolve('better-sqlite3/package.json'));
  cpSync(sqliteDir, join(dest, 'node_modules', 'better-sqlite3'), { recursive: true, errorOnExist: true, force: false, dereference: false, preserveTimestamps: true });
  if (existsSync(join(dest, 'mcp-binding.json'))) throw new Error('candidate payload must not carry an mcp-binding.json');
  const tree = hashTree(dest);
  if (tree.links.length > 0) throw new Error(`candidate payload contains links (first: ${tree.links[0]})`);
  writeJson(join(packRoot, 'candidate-files.json'), { schemaVersion: 'pd-presence-tree/v1', root: dest, ...tree });
  const bundlePath = join(dest, 'dist', 'bundle.js');
  const pkg = readJson(join(dest, 'package.json'));
  const pluginManifest = readJson(join(dest, 'openclaw.plugin.json'));
  const bundleText = readFileSync(bundlePath, 'utf8');
  return {
    source,
    root: dest,
    stagedItems: staged,
    packageName: pkg?.name ?? null,
    packageVersion: pkg?.version ?? null,
    pluginId: pluginManifest?.id ?? null,
    extensions: pkg?.openclaw?.extensions ?? null,
    bundlePath,
    bundleSha256: sha256FileSync(bundlePath),
    bundleBytes: statSync(bundlePath).size,
    sqlite: { from: sqliteDir, version: readJson(join(sqliteDir, 'package.json'))?.version ?? null },
    presenceEventCapable: bundleText.includes(PRESENCE_EVENT_TYPE),
    presenceDurability: presenceDurability(bundleText),
    presenceSurface: presenceSurface(bundleText),
    externals: auditBundleExternals({ bundlePath, packRoot }),
    tree: { fileCount: tree.fileCount, totalBytes: tree.totalBytes, treeSha256: tree.treeSha256, filesManifest: join(packRoot, 'candidate-files.json') },
  };
}

/**
 * Static durability fact for the presence event in a built bundle: is the
 * buffered event written out at record time? The plugin EventLog buffers up
 * to 20 events / 30 s on an unref'd timer and nothing flushes it at a one-shot
 * host's natural exit (reproduced offline), so without an immediate flush the
 * presence event cannot reach events_*.jsonl in a single `agent exec` turn.
 */
export function presenceDurability(bundleText) {
  const marker = 'recordPromptPresenceObserved(data) {';
  const start = bundleText.indexOf(marker);
  if (start === -1) return { status: 'unknown', reason: 'record method not found in bundle' };
  const end = bundleText.indexOf('\n  }', start);
  const body = bundleText.slice(start, end === -1 ? start + 400 : end);
  return body.includes('flushEvents()')
    ? { status: 'flushed_on_record' }
    : { status: 'buffered_lost_on_one_shot_exit', reason: 'recordPromptPresenceObserved only buffers; no exit-time flush exists' };
}

/**
 * Static fact for the presence hook surface in a built (unminified) bundle. The
 * plugin registers the llm_input handler through guardHook, and guardHook
 * installs a no-op for any surface the bundled PLUGIN_SURFACE_REGISTRY does not
 * enable by default (PRI-289; it passes no overrides). Without an enabled entry
 * the observation never runs, whatever the host dispatches.
 */
export function presenceSurface(bundleText) {
  if (!bundleText.includes(`guardHook("${PRESENCE_SURFACE_ID}"`)) {
    return { status: 'not_registered', reason: 'no guardHook registration for the presence surface in the bundle' };
  }
  const start = bundleText.indexOf('PLUGIN_SURFACE_REGISTRY = [');
  const end = start === -1 ? -1 : bundleText.indexOf('\n];', start);
  if (start === -1 || end === -1) return { status: 'unknown', reason: 'surface registry not found in the bundle (minified build?)' };
  const entry = bundleText.slice(start, end).match(/(?<![\w$])id:\s*"hook:llm_input_presence"[^}]*\}/)?.[0];
  if (!entry) {
    return { status: 'unclassified', reason: 'the bundled surface registry has no hook:llm_input_presence entry, so guardHook installs a no-op' };
  }
  return /enabledByDefault:\s*true/.test(entry) && !/category:\s*"gone"/.test(entry)
    ? { status: 'enabled_by_default' }
    : { status: 'disabled_by_default', reason: 'the surface is classified but not enabled by default, and guardHook passes no overrides' };
}

export function inspectProductionPlugin(realHome) {
  const root = join(realHome, '.openclaw', 'extensions', 'principles-disciple');
  if (!existsSync(root)) return { root, exists: false };
  const bundlePath = join(root, 'dist', 'bundle.js');
  const pkgPath = join(root, 'package.json');
  const bundleText = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';
  return {
    root,
    exists: true,
    version: existsSync(pkgPath) ? readJson(pkgPath)?.version ?? null : null,
    bundleSha256: existsSync(bundlePath) ? sha256Buffer(Buffer.from(bundleText, 'utf8')) : null,
    presenceEventCapable: bundleText.includes(PRESENCE_EVENT_TYPE),
  };
}

function productionWorkspaces(realHome, operatorEnv) {
  const candidates = new Set();
  if (typeof operatorEnv.PD_WORKSPACE_DIR === 'string' && isAbsolute(operatorEnv.PD_WORKSPACE_DIR)) candidates.add(resolve(operatorEnv.PD_WORKSPACE_DIR));
  candidates.add(join(realHome, '.openclaw', 'workspace'));
  const pointer = join(realHome, '.openclaw', 'principles-disciple.json');
  if (existsSync(pointer)) {
    try {
      const workspace = readJson(pointer)?.workspace;
      if (typeof workspace === 'string' && isAbsolute(workspace)) candidates.add(resolve(workspace));
    } catch { /* unreadable pointer is recorded by the snapshot */ }
  }
  return [...candidates].filter((path) => existsSync(path));
}

/** Production paths the run could plausibly touch, by class. Read-only. */
export function pollutionTargets({ realHome, operatorEnv, globalHostDir }) {
  const targets = [
    { id: 'global-host-package-json', path: join(globalHostDir, 'package.json'), class: 'static-install' },
    { id: 'global-host-cli', path: join(globalHostDir, 'openclaw.mjs'), class: 'static-install' },
    { id: 'global-host-build-info', path: join(globalHostDir, 'dist', 'build-info.json'), class: 'static-install' },
    { id: 'prod-plugin-package-json', path: join(realHome, '.openclaw', 'extensions', 'principles-disciple', 'package.json'), class: 'static-install' },
    { id: 'prod-plugin-bundle', path: join(realHome, '.openclaw', 'extensions', 'principles-disciple', 'dist', 'bundle.js'), class: 'static-install' },
    { id: 'prod-plugin-mcp-binding', path: join(realHome, '.openclaw', 'extensions', 'principles-disciple', 'mcp-binding.json'), class: 'config' },
    { id: 'prod-openclaw-config', path: join(realHome, '.openclaw', 'openclaw.json'), class: 'config' },
    { id: 'prod-openclaw-cron', path: join(realHome, '.openclaw', 'cron', 'jobs.json'), class: 'config' },
    { id: 'prod-pd-telemetry-consent', path: join(realHome, '.pd', 'product-telemetry.json'), class: 'config' },
  ];
  for (const [index, workspace] of productionWorkspaces(realHome, operatorEnv).entries()) {
    targets.push({ id: `prod-workspace-${index}-state-db`, path: join(workspace, '.pd', 'state.db'), class: 'live-store' });
    targets.push({ id: `prod-workspace-${index}-event-logs`, path: join(workspace, '.state', 'logs'), class: 'log-dir' });
  }
  return targets;
}

export function snapshotTargets(targets) {
  return targets.map((target) => {
    try {
      if (!existsSync(target.path)) return { ...target, exists: false };
      const stat = statSync(target.path);
      if (target.class === 'log-dir') {
        const files = readdirSync(target.path).filter((name) => name.startsWith('events_') && name.endsWith('.jsonl')).sort()
          .map((name) => {
            const fileStat = statSync(join(target.path, name));
            return { name, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
          });
        return { ...target, exists: true, files };
      }
      return {
        ...target,
        exists: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: stat.size <= MAX_HASHED_TARGET_BYTES ? sha256FileSync(target.path) : null,
      };
    } catch (error) {
      // One unreadable target must not abort the audit, and must not read as clean.
      return { ...target, exists: null, unreadable: String(error?.code ?? error?.message ?? error) };
    }
  });
}

/** Targets a snapshot could not establish a comparable baseline for. */
export function pollutionSnapshotGaps(snapshot) {
  return snapshot.flatMap((row) => {
    if (row.unreadable) return [{ id: row.id, reason: `snapshot failed: ${row.unreadable}` }];
    if (row.class !== 'log-dir' && row.exists === true && row.sha256 === null) return [{ id: row.id, reason: 'target exceeds the hash limit' }];
    return [];
  });
}

function markerScan(path, markers, fromByte = 0) {
  try {
    const text = readFileSync(path).subarray(fromByte).toString('utf8');
    return { hits: markers.filter((marker) => text.includes(marker)) };
  } catch (error) {
    return { hits: [], unreadable: String(error?.code ?? error?.message ?? error) };
  }
}

/**
 * Classify production changes WITHOUT over-claiming: an unchanged hash is
 * "unchanged"; a changed static install is flagged for review; a live store is
 * never attributed by hash (independent legitimate writers exist); log and
 * config files are attributed only by a run-unique marker. "No marker found"
 * is not proof of zero writes, and a target that could not be read or hashed
 * is `audit-incomplete`, never unchanged and never attributed.
 */
export function comparePollution(before, after, markers) {
  const byId = new Map(before.map((row) => [row.id, row]));
  const rows = after.map((now) => {
    const was = byId.get(now.id) ?? { exists: false };
    const row = { id: now.id, path: now.path, class: now.class };
    if (was.unreadable || now.unreadable) {
      return { ...row, verdict: 'audit-incomplete', reason: was.unreadable ? `baseline snapshot failed: ${was.unreadable}` : `current snapshot failed: ${now.unreadable}` };
    }
    if (now.class === 'log-dir') {
      const previous = new Map((was.files ?? []).map((file) => [file.name, file]));
      const currentNames = new Set((now.files ?? []).map((file) => file.name));
      const removed = [...previous.keys()].filter((name) => !currentNames.has(name));
      const touched = (now.files ?? []).filter((file) => {
        const old = previous.get(file.name);
        return !old || old.size !== file.size || old.mtimeMs !== file.mtimeMs;
      }).map((file) => ({ name: file.name, ...markerScan(join(now.path, file.name), markers, previous.get(file.name)?.size ?? 0) }));
      const unreadable = touched.filter((file) => file.unreadable);
      if (touched.some((file) => file.hits.length > 0)) return { ...row, verdict: 'changed-attributed', touched, removed };
      if (unreadable.length > 0) return { ...row, verdict: 'audit-incomplete', reason: `marker scan failed: ${unreadable.map((file) => `${file.name} ${file.unreadable}`).join(', ')}`, touched, removed };
      const changed = touched.length > 0 || removed.length > 0 || was.exists !== now.exists;
      return { ...row, verdict: changed ? 'changed-no-run-marker-found' : 'unchanged', touched, removed };
    }
    const changed = was.exists !== now.exists || was.sha256 !== now.sha256 || was.size !== now.size;
    if (!changed && now.exists && now.sha256 === null) {
      return { ...row, verdict: 'audit-incomplete', reason: 'target exceeds the hash limit; an equal size is not proof of no change' };
    }
    if (!changed) return { ...row, verdict: 'unchanged' };
    if (now.class === 'live-store') {
      return { ...row, verdict: 'changed-independent-writer-possible', note: 'live store hash is not attributable' };
    }
    if (now.exists && now.size > MAX_MARKER_SCAN_BYTES) {
      return { ...row, verdict: 'audit-incomplete', reason: 'changed target exceeds the marker scan limit' };
    }
    const scan = now.exists ? markerScan(now.path, markers) : { hits: [] };
    if (scan.unreadable) return { ...row, verdict: 'audit-incomplete', reason: `marker scan failed: ${scan.unreadable}` };
    return {
      ...row,
      verdict: scan.hits.length > 0 ? 'changed-attributed' : now.class === 'static-install' ? 'changed-static-install-review' : 'changed-no-run-marker-found',
      hits: scan.hits,
    };
  });
  const idsOf = (...verdicts) => rows.filter((row) => verdicts.includes(row.verdict)).map((row) => row.id);
  return {
    rows,
    attributed: idsOf('changed-attributed'),
    reviewRequired: idsOf('changed-static-install-review'),
    unattributed: idsOf('changed-independent-writer-possible', 'changed-no-run-marker-found'),
    incomplete: rows.filter((row) => row.verdict === 'audit-incomplete').map((row) => ({ id: row.id, reason: row.reason })),
    statement: 'Verdicts are bounded: unchanged hashes and missing markers are reported as such; neither proves the absence of every write.',
  };
}

const POLLUTION_VERDICT_MEANING = Object.freeze({
  attributed: 'A production target carries a run-unique marker: the run reached production. Stop; the run cannot be completed.',
  'review-required': 'A static install file changed during the run window. The cause is not established; stop and hand to human review.',
  incomplete: 'The audit could not be completed for at least one target. No audit pass is claimed; stop.',
  'unattributed-changes-noted': 'Live stores or logs changed with no run marker. Other sessions write them legitimately, so this is recorded as unattributable, not as pollution.',
  clean: 'No change was seen on the audited targets. This does not prove zero writes anywhere else.',
});

/** Turn one comparison into the single stop/continue decision a run acts on. */
export function classifyPollution({ attributed, reviewRequired, unattributed, incomplete }) {
  const verdict = attributed.length > 0 ? 'attributed'
    : reviewRequired.length > 0 ? 'review-required'
      : incomplete.length > 0 ? 'incomplete'
        : unattributed.length > 0 ? 'unattributed-changes-noted' : 'clean';
  return {
    verdict,
    stop: verdict === 'attributed' || verdict === 'review-required' || verdict === 'incomplete',
    pendingHumanReview: reviewRequired.length > 0,
    attributed,
    reviewRequired,
    unattributed,
    incomplete,
    meaning: POLLUTION_VERDICT_MEANING[verdict],
  };
}

function readA1Sample(repoRoot) {
  const datasetPath = join(repoRoot, 'scripts', 'dev', 'pain-real-llm-bdd', 'golden-dataset.json');
  const dataset = readJson(datasetPath);
  const sample = Array.isArray(dataset?.samples) ? dataset.samples.find((row) => row?.sample_id === A1_SAMPLE_ID) : null;
  if (!sample || typeof sample.text !== 'string') throw new Error('golden dataset has no A1 sample text');
  return { datasetPath, datasetSha256: sha256FileSync(datasetPath), sampleId: A1_SAMPLE_ID, text: sample.text, textSha256: sha256Utf8(sample.text) };
}

export function roundInputText(packId, roundId, a1Text) {
  return `[PRI-1152 isolated-host presence ${packId} ${roundId}]\n${a1Text}\n`;
}

export function packLayout(packRoot) {
  return {
    packRoot,
    manifestPath: join(packRoot, 'manifest.json'),
    hostRoot: join(packRoot, 'host'),
    candidateRoot: join(packRoot, 'candidate', 'principles-disciple'),
    configPath: join(packRoot, 'config', 'openclaw.json'),
    hostLogPath: join(packRoot, 'logs', 'openclaw-host.log'),
    workspaceDir: join(packRoot, 'workspace'),
    pdConfigPath: join(packRoot, 'workspace', '.pd', 'config.yaml'),
    settingsPath: join(packRoot, 'workspace', '.openclaw', 'settings.json'),
    homeDir: join(packRoot, 'home'),
    tempDir: join(packRoot, 'tmp'),
    stateDir: (roundId) => join(packRoot, 'state', roundId),
    inputPath: (roundId) => join(packRoot, 'inputs', `${roundId}.txt`),
    preflightDir: join(packRoot, 'preflight'),
    runDir: join(packRoot, 'run'),
    budgetLedgerPath: join(packRoot, 'run', 'budget-ledger.json'),
  };
}

export function roundArgv({ manifest, round }) {
  return [
    manifest.host.identity.cliPath,
    'agent', 'exec',
    '--config', manifest.paths.configPath,
    '--state-dir', round.stateDir,
    '--model', round.modelRef,
    '--cwd', manifest.paths.workspaceDir,
    '--timeout', String(HOST_AGENT_TIMEOUT_SECONDS),
    '--code-mode', 'direct',
    '--json',
    '--message-file', round.inputPath,
  ];
}

export function buildRoundEnv({ layout, roundId, baseEnv = process.env }) {
  return buildAllowlistedHostEnv({
    baseEnv,
    experimentRoot: layout.packRoot,
    homeDir: layout.homeDir,
    tempDir: layout.tempDir,
    workspaceDir: layout.workspaceDir,
    stateDir: layout.stateDir(roundId),
    configPath: layout.configPath,
  });
}

/**
 * Freeze a new execution pack. Stages and verifies everything offline; starts
 * no host and sends no request. Returns the manifest (also written to disk).
 */
export async function preparePack({
  repoRoot,
  packRoot,
  packId,
  hostSource,
  pluginSource,
  expectedHostVersion,
  expectedHostCommit,
  npmCacheDir = null,
  endpointPort,
  source,
  operatorEnv = process.env,
  realHome = homedir(),
  codeRoot = PRESENCE_CODE_ROOT,
}) {
  if (!isAbsolute(packRoot)) throw new Error('packRoot must be absolute');
  if (existsSync(packRoot)) throw new Error(`pack already exists: ${packRoot}`);
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) throw new Error('a frozen endpoint port is required');
  const layout = packLayout(packRoot);
  mkdirSync(packRoot, { recursive: true });

  const host = await stageHost({ hostSource, packRoot, expectedVersion: expectedHostVersion, expectedCommit: expectedHostCommit, npmCacheDir });
  const candidate = stageCandidate({ pluginSource, packRoot });

  const fakeApiKey = generateFakeApiKey();
  const hostConfig = buildPresenceHostConfig({ endpointPort, pluginRoot: layout.candidateRoot, fakeApiKey, hostLogPath: layout.hostLogPath });
  writeJson(layout.configPath, hostConfig);

  mkdirSync(join(layout.workspaceDir, '.pd'), { recursive: true });
  writeFileSync(layout.pdConfigPath, buildPresencePdConfigText(), { encoding: 'utf8', flag: 'wx' });
  writeJson(layout.settingsPath, PRESENCE_AGENT_SETTINGS);
  await seedPresenceFixture(layout.workspaceDir);
  const stateDbSha256 = sha256FileSync(join(layout.workspaceDir, '.pd', 'state.db'));
  const fixture = await inspectPresenceFixture(layout.workspaceDir);
  if (!fixture.ok) throw new Error(`fixture inspection failed: ${fixture.violations.join('; ')}`);

  for (const dir of [layout.homeDir, join(layout.homeDir, 'AppData', 'Roaming'), join(layout.homeDir, 'AppData', 'Local'), layout.tempDir,
    ...PRESENCE_ROUNDS.map((round) => layout.stateDir(round.id)), layout.preflightDir, dirname(layout.hostLogPath)]) {
    mkdirSync(dir, { recursive: true });
  }

  const a1 = readA1Sample(repoRoot);
  const rounds = PRESENCE_ROUNDS.map((round) => {
    const inputPath = layout.inputPath(round.id);
    mkdirSync(dirname(inputPath), { recursive: true });
    writeFileSync(inputPath, roundInputText(packId, round.id, a1.text), { encoding: 'utf8', flag: 'wx' });
    const env = buildRoundEnv({ layout, roundId: round.id, baseEnv: operatorEnv });
    return {
      id: round.id,
      api: round.api,
      endpointPath: round.path,
      provider: round.provider,
      model: PRESENCE_MODEL_ID,
      modelRef: roundModelRef(round),
      stateDir: layout.stateDir(round.id),
      inputPath,
      inputSha256: sha256FileSync(inputPath),
      budget: PRESENCE_ROUND_BUDGETS[round.id],
      outerTimeoutMs: ROUND_OUTER_TIMEOUT_MS,
      agentTimeoutSeconds: HOST_AGENT_TIMEOUT_SECONDS,
      env: { explicit: env.resolved.env, inheritedKeys: env.inheritedFromParent.sort(), resolved: { ...env.resolved, env: undefined } },
    };
  });

  const productionPlugin = inspectProductionPlugin(realHome);
  const manifest = {
    schemaVersion: PACK_SCHEMA,
    cardVersion: CARD_VERSION,
    packId,
    createdAt: new Date().toISOString(),
    scope: 'Path A post-assembly presence observation connectivity on the unmodified official host; D=unknown; no G1/C04/G2 sign-off; no delivery/adherence/behaviour claim',
    source,
    executionCode: { ...collectExecutionCode(codeRoot), trustBoundary: EXECUTION_CODE_TRUST_BOUNDARY },
    node: { path: process.execPath, version: process.version, sha256: sha256FileSync(process.execPath) },
    host,
    candidate,
    productionPlugin,
    paths: {
      packRoot,
      configPath: layout.configPath,
      hostLogPath: layout.hostLogPath,
      workspaceDir: layout.workspaceDir,
      pdConfigPath: layout.pdConfigPath,
      settingsPath: layout.settingsPath,
      homeDir: layout.homeDir,
      tempDir: layout.tempDir,
      runDir: layout.runDir,
      budgetLedgerPath: layout.budgetLedgerPath,
    },
    // The generated placeholder key is pinned by the config file hash; it is never fingerprinted on its own.
    hostConfig: { path: layout.configPath, sha256: sha256FileSync(layout.configPath), fakeApiKeyFormat: 'pdpresence-local-<32 hex>, generated per pack' },
    pdConfig: { path: layout.pdConfigPath, sha256: sha256FileSync(layout.pdConfigPath), featureExpectations: PRESENCE_PD_FEATURE_EXPECTATIONS },
    agentSettings: { path: layout.settingsPath, sha256: sha256FileSync(layout.settingsPath), content: PRESENCE_AGENT_SETTINGS },
    endpoint: { host: '127.0.0.1', port: endpointPort, baseUrl: `http://127.0.0.1:${endpointPort}/v1`, answer: PRESENCE_ANSWER },
    fixture: { ...PRESENCE_FIXTURE, text: undefined, textSha256: fixture.rawTextSha256, stateDbSha256, inspection: fixture },
    userInput: { ...a1, text: undefined, note: 'A1 is the user message of both rounds; it is not an activation' },
    rounds,
    budget: { run: PRESENCE_RUN_BUDGET, rounds: PRESENCE_ROUND_BUDGETS, counterMapping: { hostTurns: 'host starts', httpRequests: 'provider HTTP requests reaching the endpoint', toolCalls: 'tool calls', paidCalls: 'paid calls' } },
    pollution: { targets: pollutionTargets({ realHome, operatorEnv, globalHostDir: resolve(hostSource) }), markers: runMarkers({ packId, packRoot, endpointPort }) },
  };
  writeJson(layout.manifestPath, manifest);
  return { manifest, manifestSha256: sha256FileSync(layout.manifestPath), layout };
}

export function runMarkers({ packId, packRoot, endpointPort }) {
  return [packId, PRESENCE_FIXTURE.principleId, PRESENCE_FIXTURE.artifactId, PRESENCE_FIXTURE.activationId, PRESENCE_MODEL_ID,
    ...PRESENCE_ROUNDS.map((round) => round.provider), `127.0.0.1:${endpointPort}`, packRoot];
}

export function preflightCheck(id, status, detail, evidence = {}) {
  return { id, status, detail, evidence };
}

/**
 * The one place READY is decided. A pack is READY only when every required
 * check ran and passed; NOT_RUN is never a pass. Callers derive their exit code
 * and refusal reasons from this result and nothing else.
 */
export function summarizePreflight(checks) {
  const produced = new Set(checks.map((row) => row.id));
  const all = [
    ...checks,
    ...PREFLIGHT_REQUIRED_CHECKS.filter((id) => !produced.has(id)).map((id) => preflightCheck(id, 'NOT_RUN', 'this required check was not produced')),
  ];
  const failing = all.filter((row) => row.status !== 'PASS').map((row) => ({ id: row.id, status: row.status, detail: row.detail, evidence: row.evidence }));
  return {
    checks: all,
    summary: {
      pass: all.filter((row) => row.status === 'PASS').length,
      fail: all.filter((row) => row.status === 'FAIL').length,
      notRun: all.filter((row) => row.status === 'NOT_RUN').length,
      total: all.length,
    },
    failing,
    ready: failing.length === 0,
  };
}

/**
 * Offline re-verification of a frozen pack. `full` re-hashes the staged host
 * tree. Never starts a host. Returns checks only: `summarizePreflight` decides
 * READY once the launcher has added its runtime capability checks.
 */
export async function verifyPack({ packRoot, full = false, operatorEnv = process.env, realHome = homedir(), codeRoot = PRESENCE_CODE_ROOT }) {
  const layout = packLayout(packRoot);
  const check = preflightCheck;
  const checks = [];
  if (!existsSync(layout.manifestPath)) return { schemaVersion: 'pd-presence-verify/v2', packRoot, manifestSha256: null, full, checks: [check('manifest', 'FAIL', 'manifest.json missing')] };
  const manifestSha256 = sha256FileSync(layout.manifestPath);
  const manifest = readJson(layout.manifestPath);
  checks.push(check('manifest', manifest.schemaVersion === PACK_SCHEMA && manifest.cardVersion === CARD_VERSION ? 'PASS' : 'FAIL',
    'frozen manifest schema and card version', { manifestSha256, schemaVersion: manifest.schemaVersion, cardVersion: manifest.cardVersion }));

  const nodeOk = process.execPath === manifest.node.path && process.version === manifest.node.version && sha256FileSync(process.execPath) === manifest.node.sha256;
  checks.push(check('node-identity', nodeOk ? 'PASS' : 'FAIL', 'the verifying node binary is the frozen host node binary', { path: process.execPath, version: process.version }));

  const profile = resolveHostProfile({ hostRoot: manifest.host.hostRoot, expectedVersion: manifest.host.version });
  const identity = profile.ok ? hostIdentity(profile) : null;
  const identityViolations = [];
  if (!profile.ok || !profile.healthy) identityViolations.push(profile.reason ?? 'staged host unhealthy');
  for (const key of ['cliPath', 'cliSha256', 'version', 'nodePath', 'identitySha256']) {
    if (identity?.[key] !== manifest.host.identity?.[key]) identityViolations.push(`host.${key} differs`);
  }
  const sourceFacts = profile.ok ? hostSourceFacts(manifest.host.packageDir, { expectedVersion: manifest.host.version, expectedCommit: manifest.host.buildInfo?.commit }) : { violations: ['unresolved'] };
  identityViolations.push(...sourceFacts.violations);
  checks.push(check('host-identity', identityViolations.length === 0 ? 'PASS' : 'FAIL', 'staged official host: version, build commit, CLI hash, no lifecycle marker', { violations: identityViolations, buildCommit: manifest.host.buildInfo?.commit }));

  if (full) {
    const tree = hashTree(manifest.host.packageDir);
    checks.push(check('host-tree', tree.treeSha256 === manifest.host.tree.treeSha256 && tree.links.length === 0 ? 'PASS' : 'FAIL',
      'every staged host file is byte-identical to the frozen tree', { treeSha256: tree.treeSha256, fileCount: tree.fileCount }));
  } else {
    checks.push(check('host-tree', 'NOT_RUN', 'full host re-hash skipped (run --verify --full; --execute always re-hashes)'));
  }
  checks.push(check('host-registry-tarball', manifest.host.tarballVerification?.ok ? 'PASS' : manifest.host.tarballVerification?.status === 'NOT_RUN' ? 'NOT_RUN' : 'FAIL',
    'staged package files equal the npm-cache registry tarball whose sha512 matches its recorded integrity (verified at prepare)', {
      integrity: manifest.host.registryTarball?.integrity ?? null, checkedFiles: manifest.host.tarballVerification?.checkedFiles ?? 0,
      mismatchedCount: manifest.host.tarballVerification?.mismatchedCount ?? null, extraCount: manifest.host.tarballVerification?.extraCount ?? null,
    }));

  const candidateTree = hashTree(manifest.candidate.root);
  const externals = auditBundleExternals({ bundlePath: manifest.candidate.bundlePath, packRoot });
  const candidateViolations = [];
  if (candidateTree.treeSha256 !== manifest.candidate.tree.treeSha256) candidateViolations.push('candidate tree changed');
  if (sha256FileSync(manifest.candidate.bundlePath) !== manifest.candidate.bundleSha256) candidateViolations.push('bundle changed');
  if (!externals.ok) candidateViolations.push(`external resolves outside the pack: ${externals.specifiers.filter((row) => row.status === 'outside-pack').map((row) => row.specifier).join(', ')}`);
  if (existsSync(join(manifest.candidate.root, 'mcp-binding.json'))) candidateViolations.push('candidate root carries an mcp-binding.json before any run');
  if (manifest.candidate.pluginId !== PLUGIN_ID) candidateViolations.push(`candidate plugin id is ${manifest.candidate.pluginId}`);
  candidateViolations.push(...candidateEntryViolations({ candidateRoot: manifest.candidate.root, bundlePath: manifest.candidate.bundlePath, frozenExtensions: manifest.candidate.extensions }));
  checks.push(check('candidate-payload', candidateViolations.length === 0 ? 'PASS' : 'FAIL', 'candidate payload frozen; its declared entry is the frozen bundle; externals resolve inside the pack', {
    violations: candidateViolations, bundleSha256: manifest.candidate.bundleSha256, extensions: manifest.candidate.extensions ?? null, externals: externals.specifiers,
  }));

  checks.push(check('presence-durability', manifest.candidate.presenceDurability?.status === 'flushed_on_record' ? 'PASS' : 'FAIL',
    'the presence event is written at record time (a one-shot host exits without flushing buffered events)', manifest.candidate.presenceDurability ?? {}));

  // Read from the staged bundle itself (its bytes are pinned by candidate-payload), never from the manifest.
  const surface = presenceSurface(readFileSync(manifest.candidate.bundlePath, 'utf8'));
  checks.push(check('presence-surface', surface.status === 'enabled_by_default' ? 'PASS' : 'FAIL',
    'the bundled surface registry enables hook:llm_input_presence (guardHook installs a no-op otherwise)', surface));

  const codeViolations = executionCodeViolations(manifest.executionCode, codeRoot);
  checks.push(check('execution-code', codeViolations.length === 0 ? 'PASS' : 'FAIL',
    'the launcher, its local scripts and the workspace builds it loads are byte-identical to the frozen list', {
      violations: codeViolations, trustBoundary: EXECUTION_CODE_TRUST_BOUNDARY,
    }));

  const budgetViolations = budgetConsistencyViolations(manifest);
  checks.push(check('budget-consistency', budgetViolations.length === 0 ? 'PASS' : 'FAIL',
    'the frozen run and per-round budgets match the launcher and each other (the ledger is built from the frozen values)', {
      violations: budgetViolations, frozen: manifest.budget ?? null,
    }));

  const config = readJson(layout.configPath);
  const configViolations = validatePresenceHostConfig(config, {
    pluginRoot: manifest.candidate.root, endpointPort: manifest.endpoint.port, hostLogPath: manifest.paths.hostLogPath ?? layout.hostLogPath,
  });
  if (manifest.paths.hostLogPath === undefined) configViolations.push('manifest records no in-pack host log path; this pack predates the registration-source check and must be prepared again');
  if (sha256FileSync(layout.configPath) !== manifest.hostConfig.sha256) configViolations.push('host config bytes changed');
  checks.push(check('host-config', configViolations.length === 0 ? 'PASS' : 'FAIL', 'frozen host config: candidate-only load path, deny-all tools, MCP off, two loopback providers, host log pinned inside the pack', { violations: configViolations }));

  const pdConfig = loadPdConfigForPlugin(layout.workspaceDir);
  const { flags } = computeFeatureFlagsFromConfig(pdConfig.effective);
  const pdViolations = [];
  if (!pdConfig.ok || pdConfig.source !== 'user_config') pdViolations.push(`PD config not loaded as user_config (${pdConfig.source})`);
  for (const [flag, enabled] of Object.entries(PRESENCE_PD_FEATURE_EXPECTATIONS)) {
    if (flags[flag]?.enabled !== enabled) pdViolations.push(`features.${flag}.enabled is ${flags[flag]?.enabled}`);
  }
  if (sha256FileSync(layout.pdConfigPath) !== manifest.pdConfig.sha256) pdViolations.push('PD config bytes changed');
  const settings = readJson(layout.settingsPath);
  if (settings?.retry?.provider?.maxRetries !== 0 || sha256FileSync(layout.settingsPath) !== manifest.agentSettings.sha256) pdViolations.push('host session settings (retry.provider.maxRetries=0) changed');
  checks.push(check('pd-config-and-retry', pdViolations.length === 0 ? 'PASS' : 'FAIL', 'PD config parses through the real loader with the frozen flags; host provider retries disabled', { violations: pdViolations }));

  const stateDbPath = join(layout.workspaceDir, '.pd', 'state.db');
  const stateDbBefore = existsSync(stateDbPath) ? sha256FileSync(stateDbPath) : null;
  const fixture = await inspectPresenceFixture(layout.workspaceDir);
  const fixtureViolations = [...(fixture.violations ?? [])];
  if (stateDbBefore !== manifest.fixture.stateDbSha256) fixtureViolations.push('fixture state.db changed since prepare');
  if (fixture.expectation?.directiveSliceSha256 !== manifest.fixture.inspection.expectation?.directiveSliceSha256) fixtureViolations.push('frozen directive slice differs');
  checks.push(check('fixture-assembly', fixture.ok && fixtureViolations.length === 0 ? 'PASS' : 'FAIL',
    'fixture resolves through the formal stores and the real shared route freezes one complete, single-escaped directive (authority=system_policy, no approvals row)', {
      violations: fixtureViolations, directiveSliceSha256: fixture.expectation?.directiveSliceSha256 ?? null, escaping: fixture.escaping ?? null, renderedAuthority: fixture.renderedAuthority ?? null,
    }));

  const inputViolations = [];
  for (const round of manifest.rounds) {
    if (!existsSync(round.inputPath) || sha256FileSync(round.inputPath) !== round.inputSha256) inputViolations.push(`${round.id} input changed`);
  }
  if (sha256FileSync(manifest.userInput.datasetPath) !== manifest.userInput.datasetSha256) inputViolations.push('golden dataset changed');
  checks.push(check('round-inputs', inputViolations.length === 0 ? 'PASS' : 'FAIL', 'frozen user inputs (A1 + round marker)', { violations: inputViolations }));

  const envViolations = [];
  const envEvidence = {};
  for (const round of manifest.rounds) {
    try {
      const env = buildRoundEnv({ layout, roundId: round.id, baseEnv: operatorEnv });
      envEvidence[round.id] = { explicit: env.resolved.env, removedFromParentCount: env.removedFromParent.length };
      for (const [key, value] of Object.entries(round.env.explicit)) {
        if (env.resolved.env[key] !== value) envViolations.push(`${round.id} ${key} differs from the frozen plan`);
      }
    } catch (error) {
      envViolations.push(`${round.id}: ${String(error?.message ?? error)}`);
    }
  }
  checks.push(check('environment-isolation', envViolations.length === 0 ? 'PASS' : 'FAIL',
    'allowlisted child env rebuilt from the CURRENT parent env: home/profile/temp/state/config/workspace redirected inside the pack, no credential keys', { violations: envViolations, evidence: envEvidence }));

  const layoutViolations = [];
  for (const path of [join(layout.workspaceDir, '.openclaw', 'extensions'), join(layout.homeDir, '.openclaw', 'extensions'),
    ...manifest.rounds.map((round) => join(round.stateDir, 'extensions'))]) {
    if (existsSync(path)) layoutViolations.push(`unexpected plugin discovery root exists: ${path}`);
  }
  if (existsSync(layout.runDir)) layoutViolations.push('run/ exists: this pack was already executed or tampered with');
  if (manifest.host.bundledPluginIds?.includes(PLUGIN_ID)) layoutViolations.push('the official host bundles a plugin with the PD id');
  if (manifest.productionPlugin?.exists && isInsideRoot(packRoot, manifest.productionPlugin.root)) layoutViolations.push('production plugin is inside the pack');
  // The production build's version and whether it can emit the presence event
  // are recorded as environment facts only. Candidate identity is proven per
  // round from the runtime registration source (round gate), not from what the
  // production build happens to lack.
  checks.push(check('production-plugin-exclusion', layoutViolations.length === 0 ? 'PASS' : 'FAIL',
    'no discovery root inside the pack carries a plugin, the host bundles no PD plugin, the production plugin is outside the pack', {
      violations: layoutViolations, productionPlugin: manifest.productionPlugin, bundledPluginIdsCount: manifest.host.bundledPluginIds?.length ?? 0,
      environmentFact: manifest.productionPlugin?.exists
        ? `production PD ${manifest.productionPlugin.version ?? 'unknown version'} ${manifest.productionPlugin.presenceEventCapable ? 'contains' : 'does not contain'} the presence event code; not used as candidate evidence`
        : 'no production PD plugin found',
    }));

  const pollutionBaseline = snapshotTargets(manifest.pollution.targets);
  const pollutionGaps = pollutionSnapshotGaps(pollutionBaseline);
  checks.push(check('pollution-baseline', pollutionGaps.length === 0 ? 'PASS' : 'FAIL',
    'every frozen production target can be read and hashed for the before/after audit (read-only)', {
      gaps: pollutionGaps,
      targets: pollutionBaseline.map((row) => ({ id: row.id, class: row.class, exists: row.exists, sha256: row.sha256 ?? null, files: row.files?.length ?? undefined })),
    }));

  return {
    schemaVersion: 'pd-presence-verify/v2',
    generatedAt: new Date().toISOString(),
    packRoot,
    manifestSha256,
    full,
    checks,
  };
}

