import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Shared real-process harness for the WorkBuddy adapter tests.
 *
 * Unlike the Codex fail-open harness, a NON-ZERO exit is a legitimate result
 * here (the P02 exit-2 blocking contract on the PreToolUse channel), so the
 * runner REPORTS status codes instead of throwing on them. Only abnormal
 * terminations (signal/timeout kill) throw, with the captured stderr, so a
 * red states what actually happened.
 */
export interface WorkBuddyHookRunResult {
  status: number;
  stdout: string;
  stderr: string;
  /**
   * Async-runner only (runEntryAsync): ms timestamps of the child's observed
   * execution window — `startedAt` is taken when the hook payload has been
   * written into the child's stdin (post start-barrier), `endedAt` when the
   * child closed. Concurrency tests use these to prove real overlap.
   */
  startedAt?: number;
  endedAt?: number;
}

export interface RunEntryOptions {
  timeoutMs?: number;
  /** JS injected into the child BEFORE the hook module is imported (belt tests). */
  childPrelude?: string;
  /** JS run in the child AFTER the import resolves (belt tests). */
  childPostlude?: string;
  /** Extra env overrides (e.g. PD_WORKBUDDY_ADAPTER_ENTRY for the wrapper). */
  env?: Record<string, string>;
}

/**
 * Sync-start barrier for concurrent ASYNC runs (defect-2 remediation): pass
 * the SAME barrier to every concurrent runEntryAsync call. Each runner spawns
 * its child and arms its stdin payload; the payloads are written to all
 * children only once every participant has spawned, so the hook processes
 * genuinely overlap instead of queueing behind each other the way spawnSync
 * forced them to.
 */
export interface SpawnStartBarrier {
  /** Resolves when every expected participant has spawned and armed its write. */
  participate(): Promise<void>;
}

/** Create a barrier that releases after `size` runEntryAsync participants joined. */
export function createSpawnStartBarrier(size: number): SpawnStartBarrier {
  let joined = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  if (size < 1) release?.();
  return {
    participate(): Promise<void> {
      joined += 1;
      if (joined >= size) release?.();
      return ready;
    },
  };
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.resolve(PACKAGE_ROOT, 'dist', 'pd-hook.js');
const WRAPPER = path.resolve(PACKAGE_ROOT, 'plugin', 'scripts', 'wrapper.cjs');

function homeEnv(homeDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USERPROFILE: homeDir,
    HOME: homeDir,
    ...(extra ?? {}),
  };
}

function assertEntryBuilt(): void {
  if (!ENTRY.startsWith(`${PACKAGE_ROOT}${path.sep}`) || !fs.statSync(ENTRY).isFile()) {
    throw new Error(`hook entry not found or outside the package: ${ENTRY} (run npm run build in packages/workbuddy-adapter)`);
  }
}

function interpret(result: ReturnType<typeof spawnSync>, what: string): WorkBuddyHookRunResult {
  if (result.error) throw new Error(`${what} spawn failed: ${String(result.error.message)}`);
  if (result.status === null || result.signal !== null) {
    throw new Error(
      `${what} terminated abnormally (status=${String(result.status)}, signal=${String(result.signal)}). `
        + `An abnormal kill (harness timeout / external signal) is environmental, NOT a governance outcome — re-run before treating it as a regression.\n--- subprocess stderr ---\n${String(result.stderr).slice(0, 4000)}`,
    );
  }
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/** Build the `node -e` script for damaged-environment belt cases; argv[1]/argv[2] point at the real entry so the entry guard fires. */
function buildInjectedScript(entry: string, entryUrl: string, channel: string | undefined, prelude?: string, postlude?: string): string {
  return [
    `process.argv[1] = ${JSON.stringify(entry)};`,
    ...(channel !== undefined ? [`process.argv[2] = ${JSON.stringify(channel)};`] : []),
    prelude ?? '',
    `import(${JSON.stringify(entryUrl)})`,
    `.then(() => { ${postlude ?? ''} })`,
    `.catch((error) => { console.error('IMPORT_FAILED', error && error.message); process.exit(9); });`,
  ].join('\n');
}

/** Run the built pd-hook entry in a fresh subprocess with a controlled fake home. */
export function runEntry(homeDir: string, payloadJson: string, channel?: string, options: RunEntryOptions = {}): WorkBuddyHookRunResult {
  assertEntryBuilt();
  const timeout = options.timeoutMs ?? 15_000;
  return interpret(spawnEntry(homeDir, payloadJson, channel, options, timeout), 'pd-hook entry');
}

interface SpawnArgs {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/** Build the identical spawn shape the sync and async runners share. */
function entrySpawnArgs(homeDir: string, channel: string | undefined, options: RunEntryOptions): SpawnArgs {
  const injected = options.childPrelude !== undefined || options.childPostlude !== undefined;
  const argv = injected
    ? ['-e', buildInjectedScript(ENTRY, pathToFileURL(ENTRY).href, channel, options.childPrelude, options.childPostlude)]
    : [ENTRY, ...(channel !== undefined ? [channel] : [])];
  return { argv, env: homeEnv(homeDir, options.env) };
}

function spawnEntry(homeDir: string, payloadJson: string, channel: string | undefined, options: RunEntryOptions, timeout: number): ReturnType<typeof spawnSync> {
  assertEntryBuilt();
  const { argv, env } = entrySpawnArgs(homeDir, channel, options);
  return spawnSync(process.execPath, argv, {
    input: payloadJson,
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout,
  });
}

export interface RunEntryAsyncOptions extends RunEntryOptions {
  /**
   * Sync-start barrier: pass the SAME barrier to every concurrent runner of a
   * group. Without a barrier the child starts as soon as it is spawned.
   */
  startBarrier?: SpawnStartBarrier;
}

/**
 * Async sibling of runEntry: the child is spawned with `spawn` (never
 * `spawnSync`), so several invocations can genuinely overlap. The synchronous
 * version's semantics are unchanged — this exists because the former
 * "concurrent" test used Promise.all over a blocking spawnSync, which proved
 * serialization, not concurrency (defect-2 remediation).
 */
export function runEntryAsync(homeDir: string, payloadJson: string, channel?: string, options: RunEntryAsyncOptions = {}): Promise<WorkBuddyHookRunResult> {
  return new Promise((resolve, reject) => {
    let spawnArgs: SpawnArgs;
    try {
      assertEntryBuilt();
      spawnArgs = entrySpawnArgs(homeDir, channel, options);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timeout = options.timeoutMs ?? 30_000;
    const child = spawn(process.execPath, spawnArgs.argv, {
      env: spawnArgs.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let startedAt = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* closing an already-dead child is fine */ }
    }, timeout);
    const finish = (result: WorkBuddyHookRunResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', (error: Error) => finish(new Error(`pd-hook entry spawn failed: ${error.message}`)));
    child.on('close', (status, signal) => {
      if (timedOut || status === null || signal !== null) {
        finish(new Error(
          `pd-hook entry terminated abnormally (status=${String(status)}, signal=${String(signal)}, timedOut=${String(timedOut)}). `
            + `An abnormal kill (harness timeout / external signal) is environmental, NOT a governance outcome — re-run before treating it as a regression.\n--- subprocess stderr ---\n${stderr.slice(0, 4000)}`,
        ));
        return;
      }
      finish({ status, stdout, stderr, startedAt, endedAt: Date.now() });
    });
    // The start barrier: hold the payload until every group member has
    // spawned, then write all payloads within the same tick.
    const write = () => {
      startedAt = Date.now();
      child.stdin.write(payloadJson);
      child.stdin.end();
    };
    if (options.startBarrier) options.startBarrier.participate().then(write);
    else write();
  });
}

/** Run the plugin wrapper (real transport path the WorkBuddy host executes). */
export function runWrapper(homeDir: string, payloadJson: string, channel: string, options: RunEntryOptions = {}): WorkBuddyHookRunResult {
  const timeout = options.timeoutMs ?? 15_000;
  const result = spawnSync(process.execPath, [WRAPPER, channel], {
    input: payloadJson,
    encoding: 'utf8',
    env: homeEnv(homeDir, options.env),
    windowsHide: true,
    timeout,
  });
  return interpret(result, 'plugin wrapper');
}

export const PACKAGE_ENTRY = ENTRY;
export const PLUGIN_WRAPPER = WRAPPER
