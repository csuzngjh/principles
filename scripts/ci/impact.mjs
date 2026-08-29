// CI Impact Resolver — semantic authority CANDIDATE for "what does this
// change affect?" (CI Governance SPEC §7). SHADOW MODE: it computes and
// reports only; no CI job conditions consume it yet. It becomes the single
// source of truth only when the existing per-workflow path filters
// (pd-console-e2e.yml, release-reproducibility.yml, publish-npm detect)
// migrate to consume it.
//
// Inputs : --base <sha> --head <sha>   (or IMPACT_BASE / IMPACT_HEAD env)
//          --repo <path>               (default: cwd)
//          --format json|markdown      (default: markdown)
//
// The package graph is built from the REAL workspace manifests
// (packages/*/package.json) — no hand-maintained second graph.
//
// The `release` scope answers the RELEASE-VERIFICATION question ("could this
// change alter the self-contained release artifact or its construction?"),
// NOT the publish-selection question (which npm packages a main merge should
// republish/lockstep — that is publish-npm detect's job and would migrate
// here later under separate publication semantics). Evidence: the asset is
// built from six workspace components — build-release-asset.mjs
// REQUIRED_COMPONENTS (plugin, console, core, pd-cli, host-runtime,
// install-layout) — mirrored by release-asset-smoke COMPONENT_NAMES and the
// release-locks/ tree.
//
// Conservative defaults: unknown/root-level changes BROADEN impact
// (repo scope → every package scope). Never "unknown → skip".

import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const { execFile } = await import('node:child_process');
const execFileAsync = promisify(execFile);

// Package directory name → semantic scope key (stable interface; job names
// may change, these semantics must not).
const SCOPE_BY_DIR = {
  'principles-core': 'core',
  'install-layout': 'installLayout',
  'host-runtime': 'hostRuntime',
  'codex-adapter': 'codexAdapter',
  'openclaw-plugin': 'plugin',
  'pd-cli': 'cli',
  'pd-console': 'console',
  'pd-companion': 'companion',
  'create-principles-disciple': 'installer',
  website: 'website',
};

const ALL_PACKAGE_SCOPES = [
  'core',
  'installLayout',
  'hostRuntime',
  'codexAdapter',
  'plugin',
  'cli',
  'console',
  'companion',
  'installer',
  'website',
];

// Root-level changes that legitimately affect only the docs surface.
const DOCS_FILE = /^docs\//;
const DOCS_SUFFIX = /\.(md|mdx|png|jpg|svg)$/;

// Release-construction surfaces beyond the installer package itself.
const RELEASE_PATHS = [
  /^packages\/create-principles-disciple\/release-locks\//,
  /^\.github\/workflows\/(publish-npm|release-reproducibility|release-reproducibility-full|companion-release)\.yml$/,
];

// Direct components of the self-contained release asset + the release
// construction itself — verbatim from build-release-asset.mjs
// REQUIRED_COMPONENTS ('plugin', 'console', 'core', 'pd-cli', 'host-runtime',
// 'install-layout') plus the installer package. codex-adapter is included
// because it is bundled into pd-cli's node_modules inside the asset (pd-cli
// declares it as a runtime dependency). pd-companion and website are NOT
// part of the asset (separate delivery surfaces).
const RELEASE_ASSET_REACHABLE_DIRS = new Set([
  'openclaw-plugin',
  'pd-console',
  'principles-core',
  'pd-cli',
  'host-runtime',
  'install-layout',
  'create-principles-disciple',
  'codex-adapter',
]);

function parseArgs(argv) {
  const args = { base: process.env.IMPACT_BASE || null, head: process.env.IMPACT_HEAD || null, repo: process.cwd(), format: 'markdown' };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--base') args.base = rest[++i];
    else if (arg === '--head') args.head = rest[++i];
    else if (arg === '--repo') args.repo = rest[++i];
    else if (arg === '--format') args.format = rest[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/ci/impact.mjs --base <sha> --head <sha> [--repo <path>] [--format json|markdown]');
      process.exit(0);
    } else {
      console.error('Unknown argument: ' + arg);
      process.exit(2);
    }
  }
  if (!args.base || !args.head) {
    console.error('Both --base and --head are required (or IMPACT_BASE / IMPACT_HEAD env).');
    process.exit(2);
  }
  if (args.format !== 'json' && args.format !== 'markdown') {
    console.error("--format must be 'json' or 'markdown'");
    process.exit(2);
  }
  return args;
}

async function runGit(args, { cwd }) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
    throw new Error('git command failed: git ' + args.join(' ') + '\n' + (stderr || (err && err.message) || 'unknown error'));
  }
}

/**
 * Build name→dir, dir→deps(name set) maps from the real workspace manifests.
 * All dependency kinds count (dependencies/dev/peer/optional): a devDep
 * change affects the consumer's build just the same.
 */
function loadWorkspaceGraph(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  const nameToDir = new Map();
  const dirToName = new Map();
  const dirToDeps = new Map();
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pjPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pjPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
    nameToDir.set(pkg.name, entry.name);
    dirToName.set(entry.name, pkg.name);
    const deps = new Set();
    for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const block = pkg[kind];
      if (!block) continue;
      for (const depName of Object.keys(block)) deps.add(depName);
    }
    dirToDeps.set(entry.name, deps);
  }
  return { nameToDir, dirToName, dirToDeps };
}

/** Transitive consumers: every workspace package that depends (transitively) on any of `changedDirs`. */
function affectedClosure(changedDirs, graph) {
  const affected = new Set(changedDirs);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [dir, deps] of graph.dirToDeps) {
      if (affected.has(dir)) continue;
      for (const dep of deps) {
        const depDir = graph.nameToDir.get(dep);
        if (depDir && affected.has(depDir)) {
          affected.add(dir);
          grew = true;
          break;
        }
      }
    }
  }
  return affected;
}

function classifyFile(file, changedDirs) {
  const pkgMatch = file.match(/^packages\/([^/]+)\//);
  if (pkgMatch && Object.hasOwn(SCOPE_BY_DIR, pkgMatch[1])) {
    changedDirs.add(pkgMatch[1]);
    return;
  }
  // Remaining files are root-level; docs-surface files are narrow, everything
  // else broadens (conservative default — unknown never means "no impact").
  return (DOCS_FILE.test(file) || DOCS_SUFFIX.test(file)) ? 'docs' : 'broad';
}

export async function computeImpact({ base, head, repo }) {
  const repoRoot = path.resolve(repo);
  const baseSha = (await runGit(['rev-parse', '--verify', base + '^{commit}'], { cwd: repoRoot })).trim();
  const headSha = (await runGit(['rev-parse', '--verify', head + '^{commit}'], { cwd: repoRoot })).trim();
  const diffOut = await runGit(['diff', '--name-only', baseSha + '...' + headSha], { cwd: repoRoot });
  const changedFiles = diffOut.split(/\r?\n/).filter((l) => l.length > 0);

  const graph = loadWorkspaceGraph(repoRoot);
  const changedDirs = new Set();
  const classifications = new Map(); // file → 'docs' | 'broad'
  for (const file of changedFiles) {
    const cls = classifyFile(file, changedDirs);
    if (cls) classifications.set(file, cls);
  }

  const broadFiles = [...classifications.entries()].filter(([, cls]) => cls === 'broad').map(([f]) => f);
  const docsFiles = [...classifications.entries()].filter(([, cls]) => cls === 'docs').map(([f]) => f);
  const broad = broadFiles.length > 0;
  const docsOnly = !broad && changedDirs.size === 0 && docsFiles.length === changedFiles.length;

  const affectedDirs = broad ? new Set(graph.dirToDeps.keys()) : affectedClosure(changedDirs, graph);

  const scopes = { repo: broad };
  for (const scope of ALL_PACKAGE_SCOPES) scopes[scope] = false;
  for (const dir of affectedDirs) {
    const scope = SCOPE_BY_DIR[dir];
    if (scope) scopes[scope] = true;
  }

  const reasons = {};
  for (const dir of changedDirs) {
    const scope = SCOPE_BY_DIR[dir];
    if (scope) reasons[scope] = 'direct file change under packages/' + dir;
  }
  for (const scope of ALL_PACKAGE_SCOPES) {
    if (scopes[scope] && !Object.hasOwn(reasons, scope)) {
      if (broad) reasons[scope] = 'broadened by root-level change (' + broadFiles.slice(0, 3).join(', ') + (broadFiles.length > 3 ? ', …' : '') + ')';
      else reasons[scope] = 'transitive consumer via workspace dependency graph';
    }
  }

  // Performance: the benchmark job exercises principles-core.
  scopes.perf = scopes.core;
  if (scopes.perf) reasons.perf = 'benchmark job targets principles-core';

  // Release-verification impact: could this change alter the self-contained
  // release asset or its construction? Component reachability over the real
  // workspace graph (broad changes reach everything → release), plus
  // release-construction surfaces. Deliberately conservative.
  scopes.release =
    [...affectedDirs].some((d) => RELEASE_ASSET_REACHABLE_DIRS.has(d)) ||
    changedFiles.some((f) => RELEASE_PATHS.some((re) => re.test(f))) ||
    changedFiles.includes('package-lock.json');
  if (scopes.release) {
    const releaseReasons = [];
    if (broad) {
      releaseReasons.push('broad/root-level change treated as reaching release inputs');
    } else {
      for (const dir of changedDirs) {
        if (RELEASE_ASSET_REACHABLE_DIRS.has(dir)) {
          releaseReasons.push('packages/' + dir + ' is a release asset component (build-release-asset.mjs REQUIRED_COMPONENTS)');
        }
      }
      const transitive = [...affectedDirs].filter((d) => RELEASE_ASSET_REACHABLE_DIRS.has(d) && !changedDirs.has(d));
      if (transitive.length > 0) {
        releaseReasons.push('transitive release-asset reach via: ' + transitive.map((d) => 'packages/' + d).join(', '));
      }
    }
    if (changedFiles.includes('package-lock.json')) releaseReasons.push('root lockfile changed');
    const wf = changedFiles.filter((f) => RELEASE_PATHS.some((re) => re.test(f)));
    if (wf.length > 0) releaseReasons.push('release workflow changed (' + wf[0] + ')');
    reasons.release = releaseReasons.join('; ');
  }

  return {
    base: baseSha,
    head: headSha,
    changedFiles,
    changedPackages: [...changedDirs].map((d) => graph.dirToName.get(d)),
    affectedPackages: [...affectedDirs].map((d) => graph.dirToName.get(d)).sort(),
    docsOnly,
    scopes,
    reasons,
  };
}

function renderMarkdown(impact) {
  const lines = [];
  lines.push('# CI Impact — SHADOW REPORT');
  lines.push('');
  lines.push('> **SHADOW ONLY** — this prediction currently skips nothing. Every CI job');
  lines.push('> still runs exactly as before. This report exists to collect evidence');
  lines.push('> until the resolver is proven to have zero false negatives.');
  lines.push('');
  lines.push('Base: `' + impact.base + '`');
  lines.push('Head: `' + impact.head + '`');
  lines.push('');
  lines.push('Changed files (' + impact.changedFiles.length + '):');
  for (const f of impact.changedFiles.slice(0, 30)) lines.push('- ' + f);
  if (impact.changedFiles.length > 30) lines.push('- … ' + (impact.changedFiles.length - 30) + ' more');
  lines.push('');
  lines.push('Docs-only change: **' + impact.docsOnly + '**');
  lines.push('');
  lines.push('| Scope | Predicted | Reason |');
  lines.push('| ----- | --------- | ------ |');
  const scopeKeys = Object.keys(impact.scopes);
  for (const key of scopeKeys) {
    const on = impact.scopes[key];
    lines.push('| ' + key + ' | ' + (on ? 'RUN' : 'skip') + ' | ' + (impact.reasons[key] || (on ? '—' : '')) + ' |');
  }
  lines.push('');
  lines.push('Affected packages: ' + (impact.affectedPackages.join(', ') || 'none'));
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const impact = await computeImpact({ base: args.base, head: args.head, repo: args.repo });
  if (args.format === 'json') console.log(JSON.stringify(impact, null, 2));
  else console.log(renderMarkdown(impact));
}

const isMain = process.argv[1] && process.argv[1].endsWith('impact.mjs');
if (isMain) {
  await main();
}
