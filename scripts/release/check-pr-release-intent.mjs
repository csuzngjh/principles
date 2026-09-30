#!/usr/bin/env node
/**
 * Normal PR release-intent guard (SPEC v1.2 §11 / Step D) with integrated
 * Version-PR contract routing (SPEC §12).
 *
 * One guard, two contracts, identity decided by PROOF:
 *
 *   1. If the PR diff is reproducible from the base's pending changesets
 *      through the deterministic materialization pipeline, the PR IS a
 *      Version Packages PR — the reproduction itself proves the allowed
 *      diff, the Product Version and runtime pins are untouched, and only
 *      the C4 plan guard still applies.
 *   2. Otherwise the PR is a normal PR and must DECLARE its own release
 *      intent (this PR's changesets — base/main pending changesets do not
 *      count, SPEC §11 intro):
 *        N-1 unknown package declared            -> FAIL
 *        N-2 private package declared            -> FAIL
 *        N-3 release-affecting change, no intent -> FAIL
 *        N-4 bump type not major/minor/patch     -> FAIL
 *        N-5 direct C4 (plugin/console -> installer) via the final plan
 *      plus: a normal PR may not edit any package `version` field —
 *      versions materialize only through the Version Packages PR.
 *
 * The official empty changeset is the explicit no-release declaration for
 * conservative path-rule hits (SPEC §10.2) — it waives N-3 and C4-direct,
 * never a plan-triggered edge. No waiver database.
 *
 * Usage (CI verify-merge step, local verify:merge, and pre-push):
 *   node scripts/release/check-pr-release-intent.mjs
 * Env: PR_BASE_SHA (base SHA of the pull request). Falls back to the
 * merge-base of origin/main and HEAD (strict — task-branch local runs are
 * authoritative). A final HEAD~1 fallback (no differing main ref, e.g. on
 * the main checkout itself) degrades the run to ADVISORY: findings are
 * reported as a warning, never a verdict, because HEAD~1 cannot represent
 * a PR base (PRI-917 v0.3.2: a missing changeset escaped to CI exactly
 * because this guard was CI-only — it now also runs in local verify:merge).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeFinalPlan,
  reproduceVersionMaterialization,
} from './lib/version-plan.mjs';
import {
  ASSEMBLY_PAYLOAD_SOURCES,
  PRODUCT_ASSEMBLY_RULES,
  changedPublishablePackages,
  loadWorkspace,
} from './lib/workspace.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const repoRoot = path.resolve(argValue('--repo-root') ?? DEFAULT_REPO_ROOT);

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function resolveBase() {
  if (process.env.PR_BASE_SHA && /^[0-9a-f]{7,40}$/.test(process.env.PR_BASE_SHA)) {
    return { sha: process.env.PR_BASE_SHA, advisory: false };
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  // origin/main is the fetch authority for the PR base. The old logic
  // skipped it when it equals HEAD (`sha === head: continue`) and fell back
  // to the LOCAL `main` ref — which can be arbitrarily stale on long-lived
  // checkouts, producing a completely wrong diff (PRI-917 v0.3.2: base
  // resolved to a weeks-old main and "failed" on 17 unrelated commits).
  // When origin/main == HEAD the correct base IS HEAD (empty diff = nothing
  // to judge), so it is no longer skipped. The local `main` candidate is
  // gone for the same reason.
  const originMain = (() => {
    try {
      return git(['rev-parse', '--verify', 'origin/main^{commit}']).trim();
    } catch {
      return null;
    }
  })();
  if (originMain) {
    try {
      return { sha: git(['merge-base', originMain, head]).trim(), advisory: false };
    } catch {
      // Unrelated histories — cannot derive a PR base from origin/main.
    }
  }
  // Fallback: no usable origin/main ref. HEAD~1 cannot represent a PR base,
  // so the strict release-intent contract is NOT evaluated here — the run
  // degrades to advisory (see the exit path) instead of risking a silent
  // wrong verdict. CI (PR_BASE_SHA) remains authoritative.
  console.warn(
    'RELEASE_INTENT_GUARD ADVISORY: no usable origin/main ref found — falling back to HEAD~1. ' +
      'The release-intent contract is NOT fully evaluated in this mode; CI (PR_BASE_SHA) is authoritative.',
  );
  return { sha: `${head}~1`, advisory: true };
}

function showFile(sha, relPath) {
  try {
    return git(['show', `${sha}:${relPath}`]);
  } catch {
    return null;
  }
}function diffPaths(baseSha, headSha) {
  return git(['diff', '--name-only', `${baseSha}..${headSha}`]).split('\n').filter(Boolean);
}

const headSha = git(['rev-parse', 'HEAD']).trim();
const resolvedBase = resolveBase();
const baseSha = resolvedBase.sha;
const baseAdvisory = resolvedBase.advisory;
const changedPaths = diffPaths(baseSha, headSha);

if (changedPaths.length === 0) {
  console.log('RELEASE_INTENT_GUARD PASS mode=empty (no diff)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode 1 — Version Packages PR (identity by reproduction, SPEC §12.1)
// ---------------------------------------------------------------------------
const repro = await reproduceVersionMaterialization({ repoRoot, baseSha, headSha });
if (repro.reproducible) {
  // At the Version PR head the changesets are already consumed, so the
  // final-plan API returns an empty plan — the releases come from the
  // reproduction itself.
  const inPlan = new Map(repro.releases.map((r) => [r.name, r]));
  const failures = [];
  for (const rule of PRODUCT_ASSEMBLY_RULES) {
    if (inPlan.has(rule.when) && !inPlan.has(rule.requires)) {
      failures.push(
        `Version PR C4 violation: ${rule.when} release without ${rule.requires} release in the materialized plan.`,
      );
    }
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log(
    `RELEASE_INTENT_GUARD PASS mode=version-pr (${repro.releases
      .map((r) => `${r.name}@${r.newVersion}`)
      .join(', ')}) — diff reproduced from base pending changesets; Product Version and runtime pins untouched.`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode 2 — normal PR release-intent contract
// ---------------------------------------------------------------------------
const failures = [];
const ws = loadWorkspace(repoRoot);

// Baseline-alignment window (SPEC §9.3): the ONE migration PR that carries a
// fresh registry baseline snapshot may move package versions onto that
// baseline. The exemption is narrow and self-validating: the PR must ADD a
// docs/release/registry-baseline-*.json snapshot, and every changed version
// must equal that snapshot's registry latest for the same package. After the
// migration merges, bypassing the freeze would require fabricating registry
// evidence — which the publish train's exact-version/behind checks would
// catch anyway (SPEC §19).
const addedBaselineSnapshot = changedPaths.find(
  (p) => /^docs\/release\/registry-baseline-.*\.json$/.test(p) && !showFile(baseSha, p),
);
let alignmentSnapshot = null;
if (addedBaselineSnapshot) {
  try {
    alignmentSnapshot = JSON.parse(showFile(headSha, addedBaselineSnapshot));
  } catch {
    failures.push(`N-alignment: ${addedBaselineSnapshot} is not valid JSON.`);
  }
}
function versionMatchesSnapshotBaseline(name, version) {
  if (!alignmentSnapshot) return false;
  const entry = alignmentSnapshot.packages?.find((p) => p.name === name);
  return entry?.registry?.latest === version;
}

// Version-field freeze: package versions materialize ONLY through the
// Version Packages PR (SPEC G3). A normal PR editing a version field is a
// second materialization authority — except inside the baseline-alignment
// window above.
const alignmentAlignedDirs = new Set();
for (const rel of changedPaths) {
  const m = /^packages\/([^/]+)\/package\.json$/.exec(rel);
  if (!m) continue;
  const dir = m[1];
  const patch = (() => {
    try {
      return git(['diff', `${baseSha}..${headSha}`, '--', rel]);
    } catch {
      return '';
    }
  })();
  const versionHunks = patch
    .split('\n')
    .filter((l) => /^[+-]\s+"version":/.test(l));
  if (versionHunks.length === 0) continue;
  if (addedBaselineSnapshot) {
    const headPkg = JSON.parse(showFile(headSha, rel));
    if (versionMatchesSnapshotBaseline(headPkg.name, headPkg.version)) {
      alignmentAlignedDirs.add(dir);
      continue; // legitimate one-time baseline alignment
    }
  }
  failures.push(
    `N-version: ${rel} changes a package "version" field in a normal PR. Versions materialize only in the Version Packages PR — revert this edit; declare intent with a changeset instead.`,
  );
}

// This PR's OWN changesets (added between base and head), not base pending ones.
const addedChangesetFiles = git(['diff', '--name-only', '--diff-filter=A', `${baseSha}..${headSha}`, '--', '.changeset/'])
  .split('\n')
  .filter((f) => f.endsWith('.md') && f !== '.changeset/README.md');

const { default: parseChangeset } = await import('@changesets/parse');
const declarations = new Map(); // name -> type
let emptyDeclaration = false;
let emptyFile = null;
for (const file of addedChangesetFiles) {
  const raw = showFile(headSha, file);
  if (raw === null) continue;
  let parsed;
  try {
    parsed = parseChangeset(raw);
  } catch (err) {
    failures.push(`N-parse: changeset ${file} failed to parse: ${err?.message ?? err}`);
    continue;
  }
  const releases = parsed.releases ?? [];
  if (releases.length === 0) {
    emptyDeclaration = true;
    emptyFile = file;
    continue;
  }
  for (const r of releases) {
    if (!['major', 'minor', 'patch'].includes(r.type)) {
      failures.push(`N-4: changeset ${file} declares invalid bump type "${r.type}" for ${r.name} (major/minor/patch only).`);
      continue;
    }
    const pkg = ws.byName.get(r.name);
    if (!pkg) {
      failures.push(`N-1: changeset ${file} declares unknown package "${r.name}" — not a workspace package.`);
      continue;
    }
    if (pkg.private) {
      failures.push(
        `N-2: changeset ${file} declares private package "${r.name}" — private packages are never npm version targets. Declare the intent on the publishable artifact instead (e.g. pd-console change -> create-principles-disciple patch).`,
      );
      continue;
    }
    declarations.set(r.name, r.type);
  }
}

const nonEmptyDeclarations = declarations.size > 0;
if (emptyDeclaration && nonEmptyDeclarations) {
  failures.push(
    `N-intent: ${emptyFile} is an empty (no-release) changeset, but this PR also declares releases (${[...declarations.keys()].join(', ')}). An empty changeset means "no release needed for these changes" — remove it, or split the PR.`,
  );
}

const releaseRelevant = changedPublishablePackages(repoRoot, changedPaths);
// Alignment-only packages (sole change: version field moved onto the
// baseline snapshot) carry no NEW release content — their "intent" IS the
// alignment. Packages with any other release-relevant change (e.g. a
// dependency-range fix) still need a changeset even during the migration.
const alignmentOnlyDirs = new Set(
  [...alignmentAlignedDirs].filter((dir) =>
    changedPaths.every((p) => !p.startsWith(`packages/${dir}/`) || p === `packages/${dir}/package.json`),
  ),
);
if (!emptyDeclaration) {
  for (const pkg of releaseRelevant) {
    if (alignmentOnlyDirs.has(pkg.dir)) continue;
    if (!declarations.has(pkg.name)) {
      failures.push(
        `N-3: release-affecting change to ${pkg.name} (${pkg.dir}/) without a changeset in this PR. Add .changeset/*.md declaring ${pkg.name} major/minor/patch, or — if you judge the change genuinely non-release-affecting (docs/tests/fixture only) — add an empty changeset to declare that explicitly.`,
      );
    }
  }
}

// C4 (direct + transitive) on the final plan of the head tree (base pending
// + this PR's changesets — what would release if merged). An unknown
// package declaration (N-1) makes the plan engine throw; that failure is
// already reported above — degrade to an empty plan, never crash.
let plan = { releases: [] };
try {
  plan = await computeFinalPlan(repoRoot);
} catch (err) {
  failures.push(`N-plan: final release plan could not be computed (${err?.message ?? err}). Usually caused by an invalid changeset declaration reported above.`);
}
const inPlan = new Map(plan.releases.map((r) => [r.name, r]));
for (const rule of PRODUCT_ASSEMBLY_RULES) {
  const trigger = inPlan.get(rule.when);
  if (trigger && !inPlan.has(rule.requires)) {
    failures.push(
      `N-5/C4: final plan releases ${rule.when} (${trigger.oldVersion} -> ${trigger.newVersion}) but not ${rule.requires}. The installer bundles the plugin — declare ${rule.requires} too.`,
    );
  }
}
// C4-direct: conservative path-prefix rule (PRI-819). Like N-3 above, it is
// waived by the official empty-changeset no-release declaration (SPEC §10.2 /
// RELEASE_PROCESS "empty changeset is the declaration, not a waiver") — a
// dev-only change under a payload-source path ships nothing new. C4-transitive
// (PRODUCT_ASSEMBLY_RULES, triggered by an actual plan release) stays
// unconditional: once a package IS in the plan, its assembly edges must hold.
if (!emptyDeclaration) {
  for (const src of ASSEMBLY_PAYLOAD_SOURCES) {
    if (changedPaths.some((p) => p.startsWith(src.path)) && !inPlan.has(src.requires)) {
      failures.push(
        `N-5/C4: this PR changes ${src.path} (ships inside ${src.requires}) but the final plan has no ${src.requires} release. Declare it (typically patch), or — if the change is genuinely non-release-affecting (dev-config/tests only) — add an empty changeset to declare that explicitly.`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(
    `RELEASE_INTENT_GUARD FAIL mode=normal (base=${baseSha.slice(0, 10)} head=${headSha.slice(0, 10)}, reproduction rejected: ${repro.reasons[0] ?? 'n/a'})`,
  );
  if (baseAdvisory) {
    // Degraded base (HEAD~1): the findings may not reflect the real PR diff,
    // so they are surfaced as a loud warning instead of a verdict. CI
    // (PR_BASE_SHA) remains the authoritative enforcement point.
    console.warn(
      'RELEASE_INTENT_GUARD ADVISORY: base was resolved via the HEAD~1 fallback, so the findings above are NOT a PR verdict. Run from a task branch or rely on CI for enforcement.',
    );
    process.exit(0);
  }
  process.exit(1);
}

console.log(
  `RELEASE_INTENT_GUARD PASS mode=normal (base=${baseSha.slice(0, 10)} head=${headSha.slice(0, 10)}, ` +
    `intent=${emptyDeclaration ? 'explicit-no-release' : [...declarations.entries()].map(([n, t]) => `${n}:${t}`).join(',') || 'none-needed'})`,
);
