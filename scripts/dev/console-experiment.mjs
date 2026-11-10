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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePdHome, isPathWithinRoot } from '../../packages/install-layout/dist/index.js';

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

ensureRoot(path.resolve(options.root));

// The SAME resolver the console uses — the launcher must not invent a second
// interpretation of the root.
const resolved = resolvePdHome({ env: { PD_EXPERIMENT_ROOT: options.root } });
if (!resolved.ok) {
  console.error(`[experiment-console] Refusing to start: ${resolved.reason}`);
  console.error(`[experiment-console] ${resolved.message}`);
  console.error(`[experiment-console] Next: ${resolved.nextAction}`);
  process.exit(1);
}

const workspace = path.resolve(options.workspace ?? path.join(resolved.homeDir, 'workspace'));
for (const dir of [resolved.pdHome, resolved.consoleConfigDir, resolved.openclawHome, resolved.codexHome, workspace]) {
  fs.mkdirSync(dir, { recursive: true });
}

await assertPortFree(options.port, 'Console');
if (options.gateway) await assertPortFree(EXPERIMENT_GATEWAY_PORT, 'Experiment gateway');

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        // Process already gone.
      }
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const childEnv = {
  ...process.env,
  PD_EXPERIMENT_ROOT: resolved.homeDir,
  OPENCLAW_HOME: resolved.openclawHome,
  CODEX_HOME: resolved.codexHome,
};

if (options.gateway) {
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
console.log(`[experiment-console] Workspace: ${workspace}`);
console.log(`[experiment-console] Console:   http://127.0.0.1:${options.port}`);
