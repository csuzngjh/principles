#!/usr/bin/env node
/**
 * Sync the canonical linear-cli into the installed agent skill directories.
 *
 * WHY THIS EXISTS (PRI-722 Reality Audit finding):
 * the CLI used to live ONLY as two hand-copied directories
 * (~/.workbuddy/skills/linear-cli and ~/.agents/skills/linear-cli) with no
 * sync mechanism, so "one copy updated, one copy stale" was the default
 * outcome. The repository copy under scripts/linear-cli/ is now the single
 * maintenance source; the installed copies are derived artifacts.
 *
 * This is a plain file copy. It is deliberately NOT a package, a build step,
 * a daemon, or a watcher.
 *
 * Usage:
 *   node scripts/linear-cli/sync-skill-copies.mjs [--check] [--json]
 *
 * --check reports drift (exit 1) without writing anything, so CI/hooks can
 * detect a stale installed copy.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || '';

const DEFAULT_TARGETS = [
  path.join(HOME, '.workbuddy', 'skills', 'linear-cli'),
  path.join(HOME, '.agents', 'skills', 'linear-cli'),
];

const FILES = [
  { from: path.join(HERE, 'linear.cjs'), to: path.join('scripts', 'linear.cjs') },
  { from: path.join(HERE, 'SKILL.md'), to: 'SKILL.md' },
  ...fs
    .readdirSync(path.join(HERE, 'lib'))
    .filter((f) => f.endsWith('.cjs'))
    .map((f) => ({ from: path.join(HERE, 'lib', f), to: path.join('scripts', 'lib', f) })),
];

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function resolveTargets() {
  const env = process.env.LINEAR_CLI_SKILL_TARGETS;
  if (!env) return DEFAULT_TARGETS;
  return env
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const json = argv.includes('--json');
  const targets = resolveTargets().filter((t) => fs.existsSync(t));
  const skipped = resolveTargets().filter((t) => !fs.existsSync(t));

  const results = [];
  for (const target of targets) {
    const files = [];
    for (const entry of FILES) {
      const dest = path.join(target, entry.to);
      const srcHash = sha256(entry.from);
      const destHash = sha256(dest);
      const inSync = srcHash !== null && srcHash === destHash;
      if (!check && !inSync) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry.from, dest);
      }
      files.push({ file: entry.to, inSync: inSync || !check, written: !check && !inSync });
    }
    results.push({
      target,
      inSync: files.every((f) => f.inSync),
      written: files.filter((f) => f.written).length,
      files,
    });
  }

  const allInSync = results.every((r) => r.inSync);
  const payload = {
    ok: check ? allInSync : true,
    mode: check ? 'check' : 'sync',
    source: path.relative(process.cwd(), HERE) || HERE,
    targets: results,
    skippedMissingTargets: skipped,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(
        `${check ? (r.inSync ? 'IN SYNC ' : 'DRIFT   ') : 'SYNCED  '} ${r.target}${check ? '' : ` (${r.written} file(s) written)`}\n`,
      );
      if (check && !r.inSync) {
        for (const f of r.files.filter((x) => !x.inSync)) process.stdout.write(`         drift: ${f.file}\n`);
      }
    }
    for (const s of skipped) process.stdout.write(`SKIPPED  ${s} (not installed)\n`);
  }

  if (check && !allInSync) process.exitCode = 1;
}

main();
