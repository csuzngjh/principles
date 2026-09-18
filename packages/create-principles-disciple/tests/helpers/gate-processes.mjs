/**
 * PRI-671 gate process helpers — every child process the upgrade gate test
 * needs, in one place. node's argv is always a single FIXED committed script
 * (upgrade-gate-runner.mjs); all inputs travel via PD_GATE_* environment
 * variables and are containment-checked inside the runner against the gate's
 * isolated root. This module exists so the test file itself performs no
 * process spawning.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const helpersDir = path.dirname(fileURLToPath(import.meta.url));
export const GATE_RUNNER = path.resolve(helpersDir, 'upgrade-gate-runner.mjs');
export const GATE_RESULT_MARKER = '__PD_GATE_RESULT__';

/**
 * @typedef {object} GateProcessContext
 * @property {string} root            the gate's isolated temp root (containment boundary)
 * @property {string} homeDir         isolated HOME for the child environment
 * @property {string} workspaceDir    the isolated workspace directory
 * @property {string} binDir          shim directory prepended to PATH
 */

/**
 * @typedef {object} BootedConsole
 * @property {import('node:child_process').ChildProcess} runner
 * @property {number} pid
 * @property {number} port
 */

function assertFixedRunner() {
  if (!GATE_RUNNER.startsWith(helpersDir + path.sep) || !existsSync(GATE_RUNNER)) {
    throw new Error(`gate runner must be the committed helper inside ${helpersDir}: ${GATE_RUNNER}`);
  }
}

function gateEnv(context, mode, extra) {
  assertFixedRunner();
  return {
    ...process.env,
    HOME: context.homeDir,
    USERPROFILE: context.homeDir,
    PATH: `${context.binDir}${path.delimiter}${process.env.PATH}`,
    PD_SKIP_NPM_UPGRADE: '1',
    PD_SKIP_GLOBAL_SHIM: '1',
    PD_SKIP_CONSOLE_AUTOLAUNCH: '1',
    // Slow-disk machines legitimately exceed the console's default 180s
    // apply-full HTTP timeout (PRI-671 gate observation: 504 while the
    // update succeeds server-side). Windows 2025 + Defender measured the
    // full server-side apply at 17-23 min (sync tar extraction 600-950s +
    // installer deploy ~400s; 09-17/09-18 full-matrix evidence), so the
    // console-side budget must exceed the gate's 30 min client bound —
    // otherwise the console 504s at 15 min while the update is still
    // applying (the worst possible signal).
    PD_UPDATE_APPLY_FULL_TIMEOUT_MS: '1800000',
    PD_GATE_MODE: mode,
    PD_GATE_ROOT: context.root,
    ...extra,
  };
}

export function parseGateResult(stdout) {
  const markerIndex = stdout.lastIndexOf(GATE_RESULT_MARKER);
  if (markerIndex < 0) throw new Error(`gate runner output is missing the result marker; stdout tail: ${stdout.slice(-800)}`);
  const jsonStart = markerIndex + GATE_RESULT_MARKER.length;
  const jsonEnd = stdout.lastIndexOf('}') + 1;
  return JSON.parse(stdout.slice(jsonStart, jsonEnd));
}

/**
 * Build the candidate publication with the production builder (used when the
 * gate runs without a CI-provided publication).
 *
 * @param {string} installerDir the create-principles-disciple package root
 * @param {string} outputDir    gate-isolated output directory
 */
export async function gateBuildPublicationInternal(installerDir, outputDir) {
  const builderEntry = path.resolve(installerDir, 'scripts', 'build-self-contained-release.mjs');
  if (!builderEntry.startsWith(installerDir + path.sep) || !existsSync(builderEntry)) {
    throw new Error(`builder entry must be the committed script inside ${installerDir}: ${builderEntry}`);
  }
  await execFileAsync(process.execPath, [builderEntry, '--output', outputDir], {
    cwd: installerDir,
    env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
    timeout: 1_800_000,
  });
}

/**
 * Re-stamp a mutated payload tree with the production asset builder
 * (regenerates _release/manifest.json digests for the mutated content).
 * Delegates to the committed runner's restamp mode.
 *
 * @param {GateProcessContext} context
 * @param {string} payloadDir
 */
export async function gateRestampPayload(context, payloadDir) {
  await execFileAsync(process.execPath, [GATE_RUNNER], {
    env: gateEnv(context, 'restamp', { PD_GATE_PAYLOAD_DIR: payloadDir }),
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * Run the REAL installer transaction against a payload directory. When a
 * metadataBaseUrl is given it is exported as PD_RELEASE_METADATA_URL so the
 * installer persists it into install.json (PRI-709 durable tier) — the same
 * way a governed install would.
 *
 * @param {GateProcessContext} context
 * @param {string} payloadDir
 * @param {string} [metadataBaseUrl]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function gateRunInstall(context, payloadDir, metadataBaseUrl) {
  const { stdout } = await execFileAsync(process.execPath, [GATE_RUNNER], {
    env: gateEnv(context, 'install', {
      PD_GATE_WORKSPACE_DIR: context.workspaceDir,
      PD_GATE_PAYLOAD_DIR: payloadDir,
      ...(metadataBaseUrl !== undefined ? { PD_RELEASE_METADATA_URL: metadataBaseUrl } : {}),
    }),
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseGateResult(stdout);
}

/**
 * Run the INSTALLED pd CLI's `version --json`.
 *
 * @param {GateProcessContext} context
 * @returns {Promise<{exitCode: number | null, stdout: string, stderr: string}>}
 */
export async function gateRunPdVersion(context) {
  const { stdout } = await execFileAsync(process.execPath, [GATE_RUNNER], {
    env: gateEnv(context, 'pd-version', { PD_GATE_HOME: context.homeDir }),
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = parseGateResult(stdout);
  return {
    exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
    stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
    stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
  };
}

/**
 * Boot the INSTALLED console server through the runner. Returns once the
 * runner has recorded the server pid + port in the pidfile.
 *
 * @param {GateProcessContext} context
 * @param {string} pidFile
 * @returns {Promise<BootedConsole>}
 */
export async function gateStartConsole(context, pidFile) {
  const runner = spawn(process.execPath, [GATE_RUNNER], {
    env: gateEnv(context, 'console', {
      PD_GATE_HOME: context.homeDir,
      PD_GATE_WORKSPACE_DIR: context.workspaceDir,
      PD_GATE_PIDFILE: pidFile,
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  const deadline = Date.now() + 60_000;
  while (!existsSync(pidFile)) {
    if (Date.now() > deadline) throw new Error(`console runner did not record a pidfile at ${pidFile}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const recorded = JSON.parse(readFileSync(pidFile, 'utf8'));
  return { runner, pid: recorded.pid, port: recorded.port };
}

/**
 * Terminate a booted console (server pid first, then the runner).
 *
 * @param {BootedConsole | null} booted
 * @param {string} pidFile
 */
export async function gateStopConsole(booted, pidFile) {
  if (booted !== null) {
    try {
      process.kill(booted.pid);
    } catch {
      // already exited
    }
    if (booted.runner.exitCode === null) {
      booted.runner.kill();
      await new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
          booted.runner.kill('SIGKILL');
          resolvePromise();
        }, 15_000);
        booted.runner.once('exit', () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
  }
  try {
    rmSync(pidFile, { force: true });
  } catch {
    // best-effort
  }
}
