#!/usr/bin/env node
/**
 * Cutover baseline snapshot (SPEC v1.2 §9.2 / Step C2).
 *
 * Captures, for every publishable workspace package:
 *   - the committed main version at the capture commit;
 *   - the registry dist-tags and latest tag;
 *   - the full list of published versions;
 *   - the latest version's provenance metadata (gitHead, dist.integrity);
 *   - the internal dependency constraints of the registry latest.
 *
 * Read-only. The output is MIGRATION EVIDENCE (PR evidence / test fixture /
 * migration report) — never a long-term source of truth (SPEC Step C2), so
 * nothing in the release path may read this file at runtime.
 *
 * Usage:
 *   node scripts/release/snapshot-registry-baseline.mjs [--out <file>]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPackument } from './lib/registry-client.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argValue(flag) {
  const argv = process.argv;
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const out = argValue('--out');

function committedVersion(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', pkgDir, 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version, private: manifest.private === true };
}

const PUBLISHABLE_DIRS = [
  'principles-core',
  'install-layout',
  'host-runtime',
  'codex-adapter',
  'pd-cli',
  'openclaw-plugin',
  'create-principles-disciple',
];

let captureCommit = 'unknown';
try {
  captureCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {
  // snapshot stays usable outside a git checkout (versions still recorded)
}

const packages = [];
for (const dir of PUBLISHABLE_DIRS) {
  const local = committedVersion(dir);
  const entry = { dir, name: local.name, mainVersion: local.version };
  const doc = await fetchPackument(local.name);
  if (!doc) {
    entry.registry = { published: false };
  } else {
    const versions = doc.versions ?? {};
    const distTags = doc['dist-tags'] ?? {};
    const latest = distTags.latest;
    const latestManifest = latest ? versions[latest] : undefined;
    entry.registry = {
      published: true,
      latest,
      distTags,
      versionCount: Object.keys(versions).length,
      versions: Object.keys(versions),
      latestProvenance: {
        gitHead: latestManifest?.gitHead ?? null,
        integrity: latestManifest?.dist?.integrity ?? null,
      },
      // Internal dependency constraints of the registry latest — the range
      // reality consumers actually resolve against (SPEC §9.2).
      internalDependencies: Object.fromEntries(
        Object.entries(latestManifest?.dependencies ?? {}).filter(
          ([k]) => k.startsWith('@principles/') || k === 'principles-disciple',
        ),
      ),
    };
  }
  packages.push(entry);
  const latest = entry.registry.latest ?? '(unpublished)';
  const relation =
    entry.registry.published && entry.registry.latest !== local.version ? 'DRIFT' : 'aligned/unknown';
  console.log(`${entry.name.padEnd(38)} main=${local.version.padEnd(10)} latest=${String(latest).padEnd(10)} ${relation}`);
}

const snapshot = {
  schema: 'pd-registry-baseline-snapshot/1',
  purpose: 'changesets-cutover migration evidence (SPEC v1.2 §9.2) — not a runtime source of truth',
  capturedAt: new Date().toISOString(),
  captureCommit,
  packages,
};

const json = JSON.stringify(snapshot, null, 2) + '\n';
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(repoRoot, out)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, out), json);
  console.log(`Wrote snapshot: ${out}`);
} else {
  process.stdout.write(json);
}
