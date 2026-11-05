// Package manager guard — fail closed when dependencies are installed by
// anything other than npm.
//
// Incident history:
//   * ERR-068 (PRI-419 / PR #953): a `pnpm install` in this npm-ci repo left
//     package-lock.json out of sync and broke every CI job.
//   * PR #969 (2026-06-18) unified the repo on npm and deleted
//     pnpm-lock.yaml / pnpm-workspace.yaml, but an accidental `pnpm install`
//     on 2026-11-01 regenerated both files. Neither .gitignore nor the
//     post-hoc check:repo-hygiene can prevent regeneration: this guard runs
//     at preinstall, before any lockfile or node_modules is written.
//
// CI runs `npm ci` (frozen against package-lock.json), so the lockfile CI
// consumes must be the one the installer writes. See the ERR-068 prevention
// note: identify the canonical lockfile from .github/workflows before
// installing dependencies.
//
// Judge-only: it never installs, repairs or deletes anything.
//
// Usage:
//   node scripts/dev/check-package-manager.mjs
// Exit codes: 0 = npm, 1 = rejected.

const userAgent = process.env.npm_config_user_agent || '';

const REMEDIATION =
  'This repository is npm-only (PR #969). Run `npm install` instead; CI runs ' +
  '`npm ci` against package-lock.json. If another lockfile was created, ' +
  'remove it and reinstall with npm.';

// npm:  "npm/10.9.7 node/v22.22.2 win32 x64 workspaces/false"
// pnpm: "pnpm/12.16.1 npm/? node/v22.22.2 win32 x64"
// yarn: "yarn/1.22.22 npm/? node/v22.22.2 win32 x64"
// An installer that hides its identity is not evidence of npm: fail closed.
const manager = userAgent.split(/[\s/]/, 1)[0];

if (manager !== 'npm') {
  console.error(
    `[package-manager-guard] rejected: ${userAgent || '(no npm_config_user_agent)'}`
  );
  console.error(`  next: ${REMEDIATION}`);
  process.exit(1);
}
