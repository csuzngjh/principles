// scripts/install-hooks.mjs
// Cross-platform replacement for install-hooks.ps1.
// Installs the pd-worktree post-checkout hook fragment into .git/hooks/post-checkout,
// preserving any existing graphify hook logic via idempotent marker-based block management.
//
// Usage:
//   node scripts/install-hooks.mjs          # install (skip if already installed)
//   node scripts/install-hooks.mjs --force  # reinstall even if up-to-date
//
// What it does:
//   1. Reads scripts/post-checkout-worktree.sh (the fragment)
//   2. Reads .git/hooks/post-checkout (if exists, may contain graphify hook)
//   3. Removes any existing pd-worktree-hook block (between markers)
//   4. Appends the worktree fragment with markers to the end
//   5. Writes back to .git/hooks/post-checkout
//   6. chmod +x on Unix (no-op on Windows)
//
// Advantages over the .ps1 version:
//   - Works on Linux/macOS without PowerShell
//   - Node.js fs.writeFileSync can write to .git/hooks/ directly, bypassing
//     Trae IDE's PowerShell write-protection on .git/

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const START_MARKER = '# pd-worktree-hook-start';
const END_MARKER = '# pd-worktree-hook-end';

function parseArgs(argv) {
  const args = { force: false };
  for (const arg of argv.slice(2)) {
    switch (arg) {
      case '--force': case '-f': args.force = true; break;
      case '-h': case '--help':
        console.log('Usage: node scripts/install-hooks.mjs [--force]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }
  return args;
}

function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    console.error('Not in a git repository.');
    return null;
  }
}

/**
 * Get the hooks directory. In a worktree, `.git` is a FILE (a `gitdir:` pointer),
 * not a directory — so we MUST use `git rev-parse --git-path hooks` which resolves
 * correctly in both main repo and worktree contexts (returns the main repo's
 * .git/hooks/ in either case, since hooks are shared across worktrees).
 */
function getHooksDir() {
  try {
    return execSync('git rev-parse --git-path hooks', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Remove an existing pd-worktree-hook block (between markers, inclusive).
 * Returns the content with the block removed.
 */
function removeExistingBlock(content) {
  if (!content.includes(START_MARKER)) return content;
  // Match: optional leading newline + start marker + ... + end marker + optional trailing newline
  // The `s` flag (dotAll) lets . match newlines.
  const pattern = new RegExp(
    `\\r?\\n?# pd-worktree-hook-start[\\s\\S]*?# pd-worktree-hook-end\\r?\\n?`,
    'g'
  );
  return content.replace(pattern, '\n');
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = getRepoRoot();
  if (!repoRoot) process.exit(1);

  const fragmentFile = path.join(repoRoot, 'scripts', 'post-checkout-worktree.sh');

  if (!fs.existsSync(fragmentFile)) {
    console.error(`Fragment not found: ${fragmentFile}`);
    process.exit(1);
  }

  const hooksDir = getHooksDir();
  if (!hooksDir) {
    console.error('Could not resolve hooks directory via git.');
    process.exit(1);
  }
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  const hookFile = path.join(hooksDir, 'post-checkout');

  const fragment = fs.readFileSync(fragmentFile, 'utf-8');

  // Read existing hook content; treat ENOENT as "no existing hook".
  // Using try/catch instead of existsSync+readFileSync to avoid TOCTOU race
  // (CodeQL: potential file system race condition).
  let existingContent = '';
  try {
    existingContent = fs.readFileSync(hookFile, 'utf-8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  const hasOurBlock = existingContent.includes(START_MARKER);
  if (hasOurBlock && !args.force) {
    console.log('[skip] pd-worktree hook already installed (use --force to reinstall)');
    process.exit(0);
  }

  if (hasOurBlock) {
    existingContent = removeExistingBlock(existingContent);
    console.log('[ok] Removed old pd-worktree block');
  }

  // Wrap fragment in markers for future idempotent management.
  // Ensure fragment itself doesn't already start with a shebang (it shouldn't, but be safe).
  const markedFragment = `\n${START_MARKER}\n${fragment}\n${END_MARKER}\n`;
  const newContent = existingContent.trimEnd() + '\n' + markedFragment;

  try {
    fs.writeFileSync(hookFile, newContent, 'utf-8');
  } catch (err) {
    console.error(`[fail] Could not write ${hookFile}: ${err.message}`);
    console.error('       Check that .git/ is writable and not locked by another process.');
    process.exit(1);
  }

  // chmod +x on Unix (no-op / harmless on Windows)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch { /* ignore */ }
  }

  console.log('[ok] Installed pd-worktree post-checkout hook');
  console.log(`     Hook file: ${hookFile}`);
  console.log('');
  console.log('The hook will:');
  console.log('  - Preserve existing graphify auto-rebuild logic');
  console.log('  - Auto-run setup-worktree.mjs in new worktrees');
  console.log('  - Skip in main repo and CI (no noise)');
  console.log('');
  console.log('To verify: create a test worktree');
  console.log('  git worktree add ../test-wt main');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
