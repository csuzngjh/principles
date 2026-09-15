// `npm run dev:worktree:bootstrap [-- <path>] [--skip-install] [--skip-build]`
// (PRI-796, SPEC §7).
//
// One command takes a fresh worktree to a trustworthily developable/testable
// worktree, and then PROVES it with the readiness probes instead of assuming
// the steps succeeded.
//
// Deliberate reuse (SPEC §7.2 Connection Before Creation):
//   * dependency installation, the Windows PATH repair for the Trae IDE bug, the
//     private-docs check and the build are owned by scripts/setup-worktree.mjs —
//     this wrapper delegates to the TARGET worktree's own copy of that script;
//   * the dependency ORDER of the build is owned by the root `npm run build`
//     script. No second ordering list is introduced here.
//
// What this wrapper adds: readiness verification afterwards, so "bootstrap ran"
// and "the worktree is actually usable" cannot be confused.
//
// Isolation (SPEC D5): each worktree installs its OWN node_modules. A junction
// to the primary's node_modules would make the tree silently resolve the control
// plane's `packages/*/dist` — the most dangerous false verification. Nothing
// here ever links, copies or shares node_modules between worktrees.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReadiness, renderReadiness } from './lib/readiness.mjs';

function parseArgs(argv) {
  const args = { target: null, skipInstall: false, skipBuild: false, skipPrivateDocs: false, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--skip-install') args.skipInstall = true;
    else if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--skip-private-docs') args.skipPrivateDocs = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/dev/bootstrap-worktree.mjs [<worktree-path>] [--skip-install] [--skip-build] [--skip-private-docs] [--json]'
      );
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error('Unknown argument: ' + arg);
      process.exit(2);
    } else if (args.target === null) {
      args.target = arg;
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Report a pre-mutation refusal: these paths must not spend minutes installing
 * into a directory that is not a worktree.
 */
function refuse(args, error) {
  if (args.json) console.log(JSON.stringify({ ok: false, code: 'ENVIRONMENT_INVALID', error }, null, 2));
  else console.error('[bootstrap-worktree] FAIL: ' + error);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(args.target || process.cwd());

  if (!fs.existsSync(path.join(root, 'package.json'))) {
    refuse(args, 'not a PD worktree (no package.json): ' + root);
  }

  // PRI-796 review: package.json + a copied scripts/ tree is satisfiable by any
  // copied source directory or nested folder — running installs there would
  // build the wrong tree. Require a real git worktree before anything mutates.
  const gitCheck = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf-8' });
  if (gitCheck.status !== 0 || gitCheck.stdout?.trim() !== 'true') {
    refuse(args, 'not a git worktree (git rev-parse --is-inside-work-tree failed): ' + root);
  }

  const setupScript = path.join(root, 'scripts', 'setup-worktree.mjs');
  if (!fs.existsSync(setupScript)) {
    refuse(args, 'setup-worktree.mjs missing in the target worktree: ' + setupScript);
  }

  const setupArgs = [setupScript];
  if (args.skipInstall) setupArgs.push('--skip-install');
  if (args.skipBuild) setupArgs.push('--skip-build');
  if (args.skipPrivateDocs) setupArgs.push('--skip-private-docs');
  // SPEC §7.1: reuse the npm download cache. The lockfile still determines
  // resolution and integrity, so this changes only where bytes come from.
  if (!args.skipInstall) setupArgs.push('--prefer-offline');

  if (args.json) console.error('[bootstrap-worktree] running ' + path.basename(setupScript) + ' in ' + root);
  // PRI-796 review: never buffer the full npm/build log. In --json mode the
  // payload carries only the exit code + readiness verdict, so the child's
  // human log goes to /dev/null instead of a synchronous pipe that can fill
  // spawnSync's buffer and truncate the run; interactive mode inherits the
  // terminal so operators still see every line live.
  const setup = spawnSync(process.execPath, setupArgs, {
    cwd: root,
    stdio: args.json ? ['inherit', 'ignore', 'ignore'] : 'inherit',
    encoding: 'utf-8',
  });
  const setupOk = setup.status === 0;

  // Readiness is the verdict; the setup exit code alone is not evidence that
  // the tree can resolve its own packages.
  let report = null;
  let readinessError = null;
  try {
    report = checkReadiness({ worktreeRoot: root });
  } catch (err) {
    readinessError = String((err && err.message) || err);
  }

  const ok = setupOk && report !== null && report.ok;
  const payload = {
    ok,
    code: ok ? null : report?.code || (setupOk ? 'ENVIRONMENT_INVALID' : 'NOT_READY'),
    worktreeRoot: root,
    setupExitCode: setup.status,
    ready: report ? report.ok : false,
    readiness: report,
    readinessError,
    nextAction: ok ? null : report?.nextAction || 'Inspect the setup output above, then retry.',
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    console.log('[bootstrap-worktree] ' + (ok ? 'READY — ' : 'NOT READY — ') + root);
    if (report) console.log(renderReadiness(report));
    else console.log('  readiness could not be evaluated: ' + readinessError);
    if (!ok) console.log('\n  next: ' + payload.nextAction);
  }

  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && process.argv[1].endsWith('bootstrap-worktree.mjs');
if (isMain) {
  await main();
}
