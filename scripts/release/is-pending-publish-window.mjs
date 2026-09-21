#!/usr/bin/env node
/**
 * Pending-publish-window probe CLI (changesets cutover, SPEC v1.2).
 * Thin wrapper over scripts/release/lib/pending-window.mjs.
 *
 * Prints "true" / "false"; exit 1 on a genuinely broken publish range.
 *
 * Usage: node scripts/release/is-pending-publish-window.mjs --dir <package-dir>
 *   e.g. --dir packages/openclaw-plugin
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPendingPublishWindow } from './lib/pending-window.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pkgDir = argValue('--dir');
if (!pkgDir) {
  console.error('usage: is-pending-publish-window.mjs --dir <package-dir>');
  process.exit(2);
}

try {
  const pending = await isPendingPublishWindow(repoRoot, pkgDir);
  console.log(pending ? 'true' : 'false');
} catch (err) {
  console.error(`::error::${err?.message ?? err}`);
  process.exit(1);
}
