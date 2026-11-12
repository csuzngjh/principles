#!/usr/bin/env node
/**
 * Experiment console launcher (PRI-872 / SPEC
 * `install-mjs-dev-prod-isolation-review-20260920` §6).
 *
 * Starts a SECOND PD console that owns its own PD home, its own console
 * registry, its own OpenClaw/Codex homes and its own ports, so it can run next
 * to the production installation on the same Windows account without ever
 * touching `~/.pd`, `~/.pd-console`, `~/.openclaw` or ports 3100 / 18789.
 *
 * Why a launcher and not just `PD_EXPERIMENT_ROOT=... npm run dev`:
 *  - the port pair must be checked BEFORE anything binds (a silent fallback to
 *    3100 is how this incident class starts);
 *  - the experiment gateway must be a foreground child (`openclaw gateway run`)
 *    owned by this process — never `openclaw gateway start|stop`, which drives
 *    the machine-level service shared with production;
 *  - children must die with the launcher, so no orphan gateway keeps serving.
 *
 * Usage:
 *   node scripts/dev/console-experiment.mjs --root D:/pd-labs/pri-872 \
 *     [--workspace D:/pd-labs/pri-872/workspace] [--port 13100] [--gateway] [--no-auth]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePdHome, isPathWithinRoot } from '../../packages/install-layout/dist/index.js';
import {
  resolveExperimentWorkspace,
  verifyExperimentChildEnvironment,
  verifyExperimentWorkspaceDirectory,
} from './experiment-workspace-isolation.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPERIMENT_CONSOLE_PORT = 13100;
const EXPERIMENT_GATEWAY_PORT = 19789;

function parseArgs(argv) {
  const options = { gateway: false, noAuth: false, port: EXPERIMENT_CONSOLE_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) fail(`${argument} needs a value`);
      index += 1;
      return value;
    };
    if (argument === '--root') options.root = next();
    else if (argument === '--workspace') options.workspace = next();
    else if (argument === '--port') options.port = Number.parseInt(next(), 10);
    else if (argument === '--gateway') options.gateway = true;
    else if (argument === '--no-auth') options.noAuth = true;
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/dev/console-experiment.mjs --root <absolute dir> [--workspace <dir>] [--port 13100] [--gateway] [--no-auth]');
      process.exit(0);
    } else fail(`Unknown argument: ${argument}`);
  }
  if (!options.root) fail('--root is required (absolute path to the experiment root).');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    fail('--port must be an integer between 1 and 65535.');
  }
  return options;
}

function fail(message) {
  console.error(`[experiment-console] ${message}`);
  process.exit(1);
}

async function assertPortFree(port, label) {
  await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      probe.close();
      fail(`${label} port ${port} is already in use (${error.code ?? 'error'}). Stop the process holding it or pass another --port.`);
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

const options = parseArgs(process.argv.slice(2));

/**
 * Provision the declared root only when its PARENT already exists and the
 * target cannot land inside the production state. The resolver still performs
 * the realpath/escape validation afterwards — this step only saves the
 * operator a `mkdir`, it never widens what counts as a valid root.
 */
function ensureRoot(root) {
  if (fs.existsSync(root)) return;
  const parent = path.dirname(root);
  if (!fs.existsSync(parent)) {
    fail(`Parent directory does not exist: ${parent}. Create the path first.`);
  }
  const production = resolvePdHome({ env: {} });
  if (production.ok) {
    for (const productionDir of [production.pdHome, production.consoleConfigDir, production.openclawHome]) {
      if (isPathWithinRoot(productionDir, root)) {
        fail(`Refusing to create an experiment root inside the production state (${productionDir}).`);
      }
    }
  }
  fs.mkdirSync(root);
  console.log(`[experiment-console] Created experiment root: ${root}`);
}

// Validate the SHAPE before touching the filesystem: `ensureRoot` would
// otherwise create a directory relative to the cwd and only afterwards be
// refused by the resolver for not being absolute.
if (!path.isAbsolute(options.root)) {
  fail(`--root must be an absolute path (got "${options.root}").`);
}
const rootDir = path.resolve(options.root);
ensureRoot(rootDir);

// The SAME resolver the console uses — the launcher must not invent a second
// interpretation of the root.
const resolved = resolvePdHome({ env: { PD_EXPERIMENT_ROOT: rootDir } });
if (!resolved.ok) {
  console.error(`[experiment-console] Refusing to start: ${resolved.reason}`);
  console.error(`[experiment-console] ${resolved.message}`);
  console.error(`[experiment-console] Next: ${resolved.nextAction}`);
  process.exit(1);
}

const workspaceIsolation = resolveExperimentWorkspace({
  experimentRoot: resolved.homeDir,
  requestedWorkspace: options.workspace === undefined ? undefined : path.resolve(options.workspace),
});
if (!workspaceIsolation.ok) {
  console.error(`[experiment-console] Refusing to start: ${workspaceIsolation.reason}`);
  console.error(`[experiment-console] ${workspaceIsolation.message}`);
  console.error(`[experiment-console] Next: ${workspaceIsolation.nextAction}`);
  process.exit(1);
}
const workspaceCandidate = workspaceIsolation.workspace;
// PRI-1165: OpenClaw's private SQLite snapshot staging root and rolling logs
// resolve through XDG_CACHE_HOME (then LOCALAPPDATA) on Windows. Pointing it at
// the experiment root keeps them out of `%LOCALAPPDATA%\openclaw`.
const cacheHome = path.join(resolved.homeDir, '.cache');
for (const dir of [resolved.pdHome, resolved.consoleConfigDir, resolved.openclawHome, resolved.codexHome, cacheHome, workspaceCandidate]) {
  fs.mkdirSync(dir, { recursive: true });
}

// P0-1 stage 2: the workspace must now be a REAL directory that still resolves
// inside the root. A pre-existing junction at the workspace path is the escape
// this catches; `..` traversal was already collapsed by the resolver above.
const workspaceDirectoryCheck = verifyExperimentWorkspaceDirectory({
  experimentRoot: resolved.homeDir,
  workspace: workspaceCandidate,
});
if (!workspaceDirectoryCheck.ok) {
  console.error(`[experiment-console] Refusing to start: ${workspaceDirectoryCheck.reason}`);
  console.error(`[experiment-console] ${workspaceDirectoryCheck.message}`);
  console.error(`[experiment-console] Next: ${workspaceDirectoryCheck.nextAction}`);
  process.exit(1);
}
const workspace = workspaceDirectoryCheck.workspace;

await assertPortFree(options.port, 'Console');
if (options.gateway) await assertPortFree(EXPERIMENT_GATEWAY_PORT, 'Experiment gateway');

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid !== undefined) {
      // `shell: true` makes the child `cmd.exe`; the real `openclaw gateway
      // run` (or tsx) is its grandchild, so `child.kill()` alone would leave it
      // holding its port after the launcher exits.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    child.kill();
  } catch {
    // Process already gone.
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const childEnv = {
  ...process.env,
  PD_EXPERIMENT_ROOT: resolved.homeDir,
  // P0-1: PD's own workspace chain (PD_WORKSPACE_DIR → OPENCLAW_WORKSPACE →
  // principles-disciple.json → default) is independent of the OpenClaw dirs
  // isolated above, and it is resolved inside the gateway process. A
  // user-level PD_WORKSPACE_DIR inherited from the operator's shell outranks
  // everything below, which is how the experiment gateway once resolved the
  // PRODUCTION workspace. Pin the chain here; never rely on the caller having
  // unset it.
  PD_WORKSPACE_DIR: workspace,
  OPENCLAW_WORKSPACE: workspace,
  OPENCLAW_WORKSPACE_DIR: workspace,
  // OpenClaw's explicit profile/state knobs. Deliberately NOT OPENCLAW_HOME:
  // for the OpenClaw CLI that variable is a HOME stand-in (it appends
  // `.openclaw`), so passing `<root>/.openclaw` would nest the state one level
  // deeper and split it from what the console reads.
  OPENCLAW_STATE_DIR: resolved.openclawHome,
  OPENCLAW_CONFIG_PATH: path.join(resolved.openclawHome, 'openclaw.json'),
  CODEX_HOME: resolved.codexHome,
  // PRI-1165: keep OpenClaw's cache/logs inside the root, and namespace the
  // rolling log filename so it never collides with the production instance.
  XDG_CACHE_HOME: cacheHome,
  OPENCLAW_PROFILE: 'experiment',
};
// A stale value inherited from the parent shell would win over the state dir.
delete childEnv.OPENCLAW_HOME;
// PD_STATE_DIR is not a workspace pointer, but an inherited production value
// would still redirect PD's state tree. Dropping it lets the state dir derive
// from the pinned experiment workspace.
delete childEnv.PD_STATE_DIR;

for (const pointer of workspaceIsolation.overriddenPointers) {
  console.log(`[experiment-console] Overriding inherited ${pointer.name}=${pointer.path} -> ${workspace}`);
}

// P0-1 stage 3: the environment we are about to hand out must resolve to the
// SAME workspace through every pointer PD/OpenClaw reads, and every experiment
// path must stay inside the root. This is the launcher-side equivalent of "PD
// resolver result == OpenClaw context workspace"; a mismatch here is a
// launcher bug, not an operator mistake, and must not start anything.
const childEnvironmentCheck = verifyExperimentChildEnvironment({
  experimentRoot: resolved.homeDir,
  workspace: workspaceDirectoryCheck.workspace,
  childEnv,
});
if (!childEnvironmentCheck.ok) {
  console.error(`[experiment-console] Refusing to start: ${childEnvironmentCheck.reason}`);
  console.error(`[experiment-console] ${childEnvironmentCheck.message}`);
  console.error(`[experiment-console] Next: ${childEnvironmentCheck.nextAction}`);
  process.exit(1);
}

if (options.gateway) {
  // A fresh experiment root has no OpenClaw profile, and `gateway run` refuses
  // to boot without one (exit 78, "Missing config"). Fail here with the exact
  // path instead of letting the child die and take the console down with it.
  const experimentConfig = path.join(resolved.openclawHome, 'openclaw.json');
  if (!fs.existsSync(experimentConfig)) {
    fail(`Experiment OpenClaw profile is not configured: ${experimentConfig} is missing. Run 'openclaw setup' with OPENCLAW_STATE_DIR=${resolved.openclawHome} and OPENCLAW_CONFIG_PATH=${experimentConfig}, then retry; or start without --gateway.`);
  }
  // Foreground gateway owned by this launcher. `openclaw gateway start` would
  // drive the machine-level service that production is using.
  const gateway = spawn(
    'openclaw',
    ['gateway', 'run', '--port', String(EXPERIMENT_GATEWAY_PORT)],
    { env: childEnv, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  children.push(gateway);
  gateway.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[experiment-console] Experiment gateway exited (code ${code ?? 'unknown'}); stopping the console too.`);
      shutdown(code ?? 1);
    }
  });
  console.log(`[experiment-console] Gateway: http://127.0.0.1:${EXPERIMENT_GATEWAY_PORT} (foreground, owned by this launcher)`);
}

const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const consoleEntry = path.join(REPO_ROOT, 'packages', 'pd-console', 'src', 'server', 'index.ts');
if (!fs.existsSync(tsxCli) || !fs.existsSync(consoleEntry)) {
  fail('Cannot find tsx or the console entry; run `npm install` at the repo root first.');
}

const consoleArgs = [tsxCli, consoleEntry, '--port', String(options.port), '--workspace', workspace];
if (options.noAuth) consoleArgs.push('--no-auth');
const consoleChild = spawn(process.execPath, consoleArgs, { env: childEnv, stdio: 'inherit' });
children.push(consoleChild);
consoleChild.on('exit', (code) => shutdown(code ?? 0));

console.log('[experiment-console] Experiment instance — production state is out of reach by construction.');
console.log(`[experiment-console] Root:      ${resolved.homeDir}`);
console.log(`[experiment-console] PD home:   ${resolved.pdHome}`);
console.log(`[experiment-console] Registry:  ${resolved.consoleConfigDir}`);
console.log(`[experiment-console] Cache:     ${cacheHome} (XDG_CACHE_HOME)`);
console.log(`[experiment-console] Workspace: ${workspace}`);
console.log(`[experiment-console] Console:   http://127.0.0.1:${options.port}`);
console.log('[experiment-console] Profile:   experiment (log namespace)');
console.log('[experiment-console] Shared:    %LOCALAPPDATA%\\OpenClaw\\locks — lock files are keyed by state-db path, so prod/experiment never share one.');
