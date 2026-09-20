/**
 * PRI-671 upgrade-gate runner — the FIXED committed script the gate test
 * executes as a child process with a CONSTANT argv: every input arrives via
 * PD_GATE_* environment variables and every executable path is constructed
 * from literal subpaths and containment-checked before use.
 *
 * PD_GATE_MODE:
 *   install   (PD_GATE_ROOT / PD_GATE_WORKSPACE_DIR / PD_GATE_PAYLOAD_DIR)
 *             run the REAL installer transaction (dist/installer.js) and
 *             print __PD_GATE_RESULT__ + JSON.
 *   pd-version(PD_GATE_ROOT / PD_GATE_HOME)
 *             run the INSTALLED pd CLI's `version --json` and print
 *             __PD_GATE_RESULT__ + {exitCode,stdout}.
 *   restamp   (PD_GATE_ROOT / PD_GATE_PAYLOAD_DIR)
 *             re-stamp the mutated payload tree with the production asset
 *             builder (regenerates _release/manifest.json digests).
 *   console   (PD_GATE_ROOT / PD_GATE_HOME / PD_GATE_WORKSPACE_DIR / PD_GATE_PIDFILE)
 *             boot the INSTALLED console server on a free loopback port,
 *             record its pid + port in the pidfile, stay alive until killed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const RESULT_MARKER = '__PD_GATE_RESULT__';
const INSTALLER_ENTRY = resolve(__dirname, '..', '..', 'dist', 'installer.js');

function gatePath(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0 || !(/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'))) {
    throw new Error(`${name} must be set to an absolute path`);
  }
  return value;
}

/** Containment: every data directory must live inside the gate's isolated root. */
function gateDirectoryInsideRoot(name) {
  const directory = resolve(gatePath(name));
  const gateRoot = resolve(gatePath('PD_GATE_ROOT'));
  if (directory !== gateRoot && !directory.startsWith(gateRoot + sep)) {
    throw new Error(`${name} escaped the isolated gate root: ${directory}`);
  }
  return directory;
}

/** Literal-subpath whitelist + containment: the only entries ever executed. */
function installedEntry(homeRoot, relativeSegments) {
  const entry = join(homeRoot, ...relativeSegments);
  if (!entry.startsWith(homeRoot + sep)) {
    throw new Error(`entry escaped the home whitelist: ${entry}`);
  }
  return entry;
}

async function runInstall() {
  const workspaceDir = gateDirectoryInsideRoot('PD_GATE_WORKSPACE_DIR');
  const payloadDir = gateDirectoryInsideRoot('PD_GATE_PAYLOAD_DIR');
  if (!existsSync(INSTALLER_ENTRY)) {
    throw new Error(`installer build output is missing: ${INSTALLER_ENTRY}`);
  }
  const { install } = await import(pathToFileURL(INSTALLER_ENTRY).href);
  const result = await install(
    {
      language: 'en',
      mode: 'force',
      workspaceDir,
      channels: ['prompt', 'defer_archive', 'code_tool_hook'],
      overwriteConfig: false,
      host: 'openclaw',
      stopGateway: false,
    },
    payloadDir,
    { quiet: true, nonInteractive: true },
  );
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}`);
}

function runPdVersion() {
  const homeRoot = gateDirectoryInsideRoot('PD_GATE_HOME');
  const entry = installedEntry(homeRoot, ['.pd', 'runtime', 'pd-cli', 'dist', 'index.js']);
  if (!existsSync(entry)) {
    throw new Error(`installed pd CLI entry is missing: ${entry}`);
  }
  const outcome = spawnSync(process.execPath, [entry, 'version', '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({
    exitCode: outcome.status,
    stdout: String(outcome.stdout ?? ''),
    stderr: String(outcome.stderr ?? '').slice(0, 2000),
  })}`);
}

function runRestamp() {
  const payloadDir = gateDirectoryInsideRoot('PD_GATE_PAYLOAD_DIR');
  // PRI-874: the mutated payload is re-stamped with an EXPLICIT product
  // identity — unstamped payloads are refused by the installer, and the
  // identity must never be derived from a component manifest.
  const productVersion = process.env.PD_GATE_PRODUCT_VERSION;
  const sourceCommit = process.env.PD_GATE_SOURCE_COMMIT;
  if (typeof productVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(productVersion)) {
    throw new Error(`PD_GATE_PRODUCT_VERSION must be a strict x.y.z version, got: ${JSON.stringify(productVersion)}`);
  }
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error(`PD_GATE_SOURCE_COMMIT must be a 40-char git sha, got: ${JSON.stringify(sourceCommit)}`);
  }
  const builderEntry = resolve(__dirname, '..', '..', 'scripts', 'build-release-asset.mjs');
  if (!existsSync(builderEntry)) {
    throw new Error(`asset builder entry is missing: ${builderEntry}`);
  }
  const outcome = spawnSync(process.execPath, [
    builderEntry,
    '--input', payloadDir,
    '--output', payloadDir,
    '--in-place', 'true',
    '--platform', process.platform,
    '--arch', process.arch,
    '--node-abi', process.versions.modules,
    '--product-version', productVersion,
    '--source-commit', sourceCommit,
  ], { cwd: resolve(__dirname, '..', '..'), timeout: 600_000, encoding: 'utf8' });
  if (outcome.status !== 0) {
    throw new Error(`asset re-stamp failed (${outcome.status}): ${String(outcome.stderr ?? '').slice(0, 2000)}`);
  }
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ restamped: payloadDir, productVersion, sourceCommit })}`);
}

async function runConsole() {  const homeRoot = gateDirectoryInsideRoot('PD_GATE_HOME');
  const workspaceDir = gateDirectoryInsideRoot('PD_GATE_WORKSPACE_DIR');
  const pidFile = gateDirectoryInsideRoot('PD_GATE_PIDFILE');
  const serverEntry = installedEntry(homeRoot, ['.pd', 'runtime', 'console', 'dist', 'server.js']);
  if (!existsSync(serverEntry)) {
    throw new Error(`installed console entry is missing: ${serverEntry}`);
  }
  const portListener = http.createServer();
  await new Promise((resolvePromise) => portListener.listen(0, '127.0.0.1', resolvePromise));
  const bound = portListener.address();
  if (bound === null || typeof bound === 'string') throw new Error('port probe failed');
  const port = bound.port;
  await new Promise((resolvePromise) => portListener.close(() => resolvePromise()));

  const server = spawn(process.execPath, [serverEntry, '--workspace', workspaceDir, '--port', String(port), '--no-auth'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  const descriptor = openSync(pidFile, 'w');
  writeSync(descriptor, JSON.stringify({ pid: server.pid, port }));
  closeSync(descriptor);
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ pid: server.pid, port })}`);
  // Stay alive with the server; the test terminates both via the recorded pid.
  server.on('exit', () => process.exit(0));
  setInterval(() => {}, 60_000);
}

const mode = process.env.PD_GATE_MODE;
try {
  if (mode === 'install') {
    await runInstall();
  } else if (mode === 'pd-version') {
    runPdVersion();
  } else if (mode === 'restamp') {
    runRestamp();
  } else if (mode === 'console') {
    await runConsole();
  } else {
    throw new Error(`PD_GATE_MODE must be "install", "pd-version", "restamp" or "console", got: ${JSON.stringify(mode)}`);
  }
} catch (error) {
  process.stderr.write(`upgrade-gate-runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
