// PRI-962: install the path-independent hook dispatcher into the hooks
// directory that every worktree shares.
//
// Why this exists: the `lefthook` dependency's postinstall runs
// `lefthook install -f`, which rewrites the shared hook files with an absolute
// path to THAT worktree's binary. Running this installer right after
// dependencies (root `postinstall`) puts the deterministic dispatcher back, so
// the shared entry never depends on which worktree installed last.
//
// Usage: node scripts/dev/install-git-hooks.mjs [--strict] [--quiet]
//   --strict  exit non-zero when hooks cannot be installed (bootstrap path)
//   --quiet   stay silent on success (spawned from npm postinstall)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, 'git-hooks');
const HOOK_NAMES = ['pre-commit', 'pre-push'];

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const quiet = argv.includes('--quiet');

function note(message) {
  if (!quiet) console.log('[pd-hooks] ' + message);
}

function warn(message) {
  console.error('[pd-hooks] ' + message);
}

function bail(message) {
  if (strict) {
    warn(message);
    process.exit(1);
  }
  // npm postinstall must not break an otherwise valid install; the warning is
  // the observable signal, and the next bootstrap retries in strict mode.
  warn('WARN: ' + message);
  process.exit(0);
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

function ensureExecutable(target) {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(target).mode;
    // Git runs a hook only when its owner can execute it; any other exec bit
    // is irrelevant (and would let `0641` masquerade as installed).
    if ((mode & 0o100) === 0) fs.chmodSync(target, 0o755);
  } catch {
    /* the next run reports the real failure if the file is unreadable */
  }
}

function main() {
  // CI checkouts never commit; lefthook's own postinstall also skips there.
  if (process.env.CI && !strict) {
    note('CI detected; skipping git hook installation');
    return;
  }

  const topResult = git(['rev-parse', '--show-toplevel'], process.cwd());
  const top = topResult.status === 0 ? topResult.stdout.trim() : '';
  if (!top) bail('not inside a git worktree; nothing to install');

  const hooksPathResult = git(['rev-parse', '--git-path', 'hooks'], top);
  const hooksPath = hooksPathResult.status === 0 ? hooksPathResult.stdout.trim() : '';
  if (!hooksPath) bail('could not resolve the git hooks directory');

  // `--git-path hooks` honours core.hooksPath; a relative value is resolved
  // against the worktree root, which is where Git runs hooks from.
  const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(top, hooksPath);

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err) {
    bail('cannot create hooks directory ' + hooksDir + ': ' + err.message);
  }

  let installed = 0;
  for (const name of HOOK_NAMES) {
    const template = path.join(TEMPLATE_DIR, name);
    let content;
    try {
      content = fs.readFileSync(template);
    } catch (err) {
      bail('missing hook template ' + template + ': ' + err.message);
    }

    const target = path.join(hooksDir, name);
    let current = null;
    try {
      current = fs.readFileSync(target);
    } catch {
      current = null;
    }

    if (current && current.equals(content)) {
      ensureExecutable(target);
      continue;
    }

    try {
      fs.writeFileSync(target, content, { mode: 0o755 });
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
      installed++;
    } catch (err) {
      bail('cannot write ' + target + ': ' + err.message);
    }
  }

  if (installed === 0) note('git hooks already current (' + hooksDir + ')');
  else note('installed ' + installed + ' git hook(s) into ' + hooksDir);
}

main();
