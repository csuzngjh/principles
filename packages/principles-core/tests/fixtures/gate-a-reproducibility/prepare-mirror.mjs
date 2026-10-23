#!/usr/bin/env node
/**
 * Materialize the `core-mirror` source snapshot consumed by the Gate A
 * reproducibility fixtures (fixture-ledger.ts / fixture-sqlite.ts import
 * `../core-mirror/packages/...`).
 *
 * The mirror is a byte-exact `git archive` snapshot of a given ref — NOT a
 * symlink and NOT the live checkout — so the provenance of every assertion is
 * a single recorded commit SHA. The mirror is generated output and is
 * gitignored (see ../.gitignore).
 *
 * Usage (from anywhere):
 *   node packages/principles-core/tests/fixtures/gate-a-reproducibility/prepare-mirror.mjs [ref]
 *
 * Default ref: origin/main. The resolved full SHA, ref name, file count and
 * creation time are written to core-mirror/.provenance.json.
 *
 * No network access, no production data, no database: this only reads git
 * objects and writes .ts files into a gitignored directory.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.dirname(HERE); // .../tests/fixtures
const MIRROR = path.join(FIXTURES_DIR, 'core-mirror');
const PATHS = ['packages/principles-core/src', 'packages/host-runtime/src'];

const ref = process.argv[2] ?? 'origin/main';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`failed to spawn ${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}\n${res.stderr ?? ''}`);
  }
  return res.stdout ?? '';
}

function resolveTar() {
  for (const candidate of ['tar', 'C:/Windows/System32/tar.exe']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('tar not found on PATH and C:/Windows/System32/tar.exe is unavailable');
}

const sha = run('git', ['rev-parse', ref]).trim();
console.log(`[prepare-mirror] ref=${ref} sha=${sha}`);

fs.rmSync(MIRROR, { recursive: true, force: true });
fs.mkdirSync(path.join(MIRROR, 'packages'), { recursive: true });

const tarPath = path.join(os.tmpdir(), `pd-gate-a-mirror-${process.pid}.tar`);
try {
  run('git', ['archive', sha, '--output', tarPath, ...PATHS]);
  // Extract with cwd=MIRROR instead of `-C <dir>`: GNU tar on Windows parses a
  // `-C D:\...` argument as a remote host spec and fails. `--force-local` stops
  // tar from reading the Windows archive path `C:\...` as `host:file`.
  run(resolveTar(), ['--force-local', '-x', '-f', tarPath], { cwd: MIRROR });
} finally {
  fs.rmSync(tarPath, { force: true });
}

let files = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files += 1;
  }
};
walk(MIRROR);

fs.writeFileSync(
  path.join(MIRROR, '.provenance.json'),
  `${JSON.stringify({
    schema: 'gate-a-core-mirror.v1',
    ref,
    sha,
    archivedPaths: PATHS,
    files,
    generatedAt: new Date().toISOString(),
    note: 'Generated artifact. Regenerate with prepare-mirror.mjs; never edit by hand.',
  }, null, 2)}\n`,
  'utf8',
);

console.log(`[prepare-mirror] wrote ${files} files to ${path.relative(process.cwd(), MIRROR) || MIRROR}`);
